import {
  createTcgplayerSellerClient,
  isTcgplayerApiError,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import type { AppConfig, InventoryAdditionQueueConfig } from "../config.js";
import { ApplicationError, safeErrorCode } from "../errors.js";
import type { Logger } from "../logger.js";
import { safeIdentifier } from "../logger.js";
import {
  environmentSellerCredentialAccess,
  type SellerCredentialAccess,
} from "../seller-credentials.js";
import type { SyncLease } from "../sync-lease.js";
import type {
  InventoryAdditionExecutor,
  InventoryAdditionJob,
  InventoryAdditionQueueStore,
} from "./queue.js";

function jobChange(job: InventoryAdditionJob) {
  return job.operation === "add" ? job.addition : job.removal;
}

function jobKey(job: InventoryAdditionJob): string {
  const change = jobChange(job);
  return `${String(change.productConditionId)}:${String(change.channelId)}`;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
  });
}

export class InventoryAdditionWorker {
  private readonly idleDelayMs: number;
  private readonly workerLease: SyncLease;

  constructor(
    private readonly options: {
      readonly queue: InventoryAdditionQueueStore;
      readonly executor: InventoryAdditionExecutor;
      readonly settings: () => Promise<InventoryAdditionQueueConfig>;
      readonly logger: Logger;
      readonly idleDelayMs?: number;
      readonly workerLease?: SyncLease;
      readonly canProcess?: () => boolean;
    },
  ) {
    this.idleDelayMs = options.idleDelayMs ?? 1000;
    this.workerLease = options.workerLease ?? {
      runExclusive: <T>(work: () => Promise<T>) => work(),
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.workerLease.runExclusive(
      () => this.runExclusive(signal),
      signal,
    );
  }

  private async runExclusive(signal: AbortSignal): Promise<void> {
    const recovered = await this.options.queue.recoverInterrupted();
    if (recovered > 0) {
      this.options.logger.error("inventory-queue.interrupted-jobs", {
        count: recovered,
      });
    }
    while (!signal.aborted) {
      const settings = await this.options.settings();
      if (!settings.enabled || this.options.canProcess?.() === false) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      const job = await this.options.queue.claimNext();
      if (job === undefined) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      const listing = safeIdentifier(jobKey(job));
      this.options.logger.info("inventory-queue.applying", {
        jobId: job.id,
        listing,
        attempt: job.attempts,
      });
      try {
        await this.options.executor.apply(jobChange(job), job.operation);
        await this.options.queue.finish(job.id, "submitted");
        this.options.logger.info("inventory-queue.submitted", {
          jobId: job.id,
          listing,
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        if (
          isTcgplayerApiError(error) &&
          error.code === "AUTHENTICATION_REQUIRED"
        ) {
          await this.options.queue.pauseForAuthentication(job.id);
          this.options.logger.error("inventory-queue.authentication-required", {
            jobId: job.id,
            listing,
          });
        } else if (
          isTcgplayerApiError(error) &&
          error.code === "RATE_LIMITED"
        ) {
          await this.options.queue.retryAfterRateLimit(
            job.id,
            settings.rateLimitDelaySeconds,
          );
          this.options.logger.error("inventory-queue.rate-limited", {
            jobId: job.id,
            listing,
            retryAfterSeconds: settings.rateLimitDelaySeconds,
          });
        } else if (
          (isTcgplayerApiError(error) && error.code === "AMBIGUOUS_RESULT") ||
          (error instanceof ApplicationError &&
            error.code === "REVIEW_REQUIRED")
        ) {
          await this.options.queue.finish(job.id, "review-required", errorCode);
          this.options.logger.error("inventory-queue.review-required", {
            jobId: job.id,
            listing,
            errorCode,
          });
        } else {
          await this.options.queue.finish(job.id, "failed", errorCode);
          this.options.logger.error("inventory-queue.failed", {
            jobId: job.id,
            listing,
            errorCode,
          });
        }
      }
      await wait(settings.delaySeconds * 1000, signal);
    }
  }
}

export function createTcgplayerInventoryAdditionExecutor(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sharedClient?: TcgplayerSellerClient,
): InventoryAdditionExecutor {
  const access =
    credentials ??
    environmentSellerCredentialAccess(
      config.provider.authCookieEnv,
      config.provider.sellerKeyEnv,
      environment,
    );
  const client =
    sharedClient ??
    createTcgplayerSellerClient({
      session: access.session,
      onAuthenticationRequired: access.onAuthenticationRequired,
    });
  return {
    apply: async (change, operation) => {
      const sellerKey = access.sellerKey();
      const [primary, secondary] = await Promise.all([
        client.searchMarketplaceProducts({
          productIds: [change.productId],
          sellerKey,
          channelId: change.channelId,
          limit: 24,
        }),
        change.channelId === 0
          ? client.searchMarketplaceProducts({
              productIds: [change.productId],
              sellerKey,
              channelId: 1,
              limit: 24,
            })
          : Promise.resolve({ totalProducts: 0, products: [] }),
      ]);
      const current = primary.products
        .flatMap((product) => product.listings)
        .find(
          (listing) =>
            listing.productConditionId === change.productConditionId &&
            listing.sellerKey === sellerKey &&
            listing.channelId === change.channelId,
        );
      const currentQuantity = current?.quantity ?? 0;
      if (operation === "remove" && currentQuantity === 0) return;
      if (currentQuantity !== change.currentQuantity) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          `Live quantity changed after preview, so the inventory ${operation === "add" ? "addition" : "removal"} was not submitted.`,
        );
      }
      if (current?.customData.customListingId !== undefined) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          `Custom listings cannot receive automatic inventory ${operation === "add" ? "additions" : "removals"}.`,
        );
      }
      const hasSecondaryInventory = secondary.products
        .flatMap((product) => product.listings)
        .some(
          (listing) =>
            listing.productConditionId === change.productConditionId &&
            listing.sellerKey === sellerKey,
        );
      if (hasSecondaryInventory) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          "Secondary-channel inventory appeared after preview, so reserve quantity cannot be preserved safely.",
        );
      }
      if (operation === "add") {
        if (!("addQuantity" in change)) {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "The inventory job operation does not match its payload.",
          );
        }
        await client.addSellerInventory({
          additions: [
            {
              ...change,
              currentQuantity,
            },
          ],
        });
        return;
      }
      if (current === undefined) return;
      if ("addQuantity" in change) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The inventory job operation does not match its payload.",
        );
      }
      await client.removeSellerInventory({
        removals: [
          {
            ...change,
            currentQuantity,
            conditionId: current.conditionId,
            price: current.price,
            storePriceCustomId: null,
            reserveQuantity: 0,
          },
        ],
      });
    },
  };
}
