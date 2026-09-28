import { randomUUID } from "node:crypto";
import {
  parseLocalInventoryId,
  type LocalInventoryItem,
} from "./local-inventory-contracts.js";
import type { LocalInventoryService } from "./local-inventory.js";
import {
  MarketplaceValidationError,
  type ProviderOrderRef,
} from "./marketplaces/identity.js";
import {
  parseReplenishmentRule,
  replenishmentPrice,
  replenishmentProfileId,
  replenishmentQuantity,
  type ReplenishmentRule,
  type ReplenishmentSnapshot,
} from "./replenishment-contracts.js";

export interface ReplenishmentGateway {
  readonly connectionId: string;
  accountScope(): string;
  pricingProfiles?(): Promise<
    readonly { readonly id: string; readonly name: string }[]
  >;
  isShipped(ref: ProviderOrderRef): Promise<boolean>;
  prepare(
    item: LocalInventoryItem,
    price: number,
    pricingProfileId?: string,
  ): Promise<{
    readonly quantity: number;
    readonly price?: number;
    readonly reservedQuantity?: number;
    submit(addQuantity: number): Promise<void>;
  }>;
}

export class ReplenishmentService {
  private readonly previews = new Map<
    string,
    { fingerprint: string; expires: number }
  >();
  constructor(
    private readonly local: LocalInventoryService,
    private readonly gateway: ReplenishmentGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  snapshot(workerRunning = false): Promise<ReplenishmentSnapshot> {
    return this.local.withReplenishmentState(async (state) => ({
      pricingProfiles: (await this.gateway.pricingProfiles?.()) ?? [],
      connectionId: this.gateway.connectionId,
      workerRunning,
      rules: state.replenishments ?? [],
    }));
  }

  async configure(
    localId: string,
    value: unknown,
  ): Promise<ReplenishmentSnapshot> {
    const id = parseLocalInventoryId(localId);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new MarketplaceValidationError("Invalid auto-relist settings.");
    const input = value as Record<string, unknown>;
    if (typeof input.enabled !== "boolean")
      throw new MarketplaceValidationError(
        "Choose whether auto-relisting is enabled.",
      );
    if (
      (input.previewOnly !== undefined &&
        typeof input.previewOnly !== "boolean") ||
      (input.reconciled !== undefined &&
        typeof input.reconciled !== "boolean") ||
      (input.previewOnly === true && input.startPreviewId !== undefined)
    )
      throw new MarketplaceValidationError(
        "Invalid auto-relist review settings.",
      );
    const enabled = input.enabled;
    const previewOnly = input.previewOnly === true;
    const starting = input.startPreviewId !== undefined;
    const stored =
      typeof input.startPreviewId === "string"
        ? this.previews.get(input.startPreviewId)
        : undefined;
    if (typeof input.startPreviewId === "string")
      this.previews.delete(input.startPreviewId);
    if ((starting || previewOnly) && !enabled)
      throw new MarketplaceValidationError(
        "Enable auto-relisting to list now.",
      );
    if (
      starting &&
      (stored === undefined || stored.expires <= this.now().getTime())
    )
      throw new MarketplaceValidationError(
        "This listing review expired or was already used. Review again.",
      );
    return this.local.withReplenishmentState(async (state, save) => {
      const item = state.items.find(
        (candidate) => candidate.localInventoryId === id,
      );
      if (item === undefined)
        throw new MarketplaceValidationError("Local item was not found.");
      const existing = state.replenishments?.find(
        (rule) => rule.localInventoryId === id,
      );
      const targetQuantity = replenishmentQuantity(
        input.targetQuantity ?? existing?.targetQuantity ?? 1,
      );
      const pricingProfileId =
        input.pricingProfileId === null
          ? undefined
          : input.pricingProfileId === undefined
            ? existing?.pricingProfileId
            : replenishmentProfileId(input.pricingProfileId);
      const configuredPrice = replenishmentPrice(
        input.price ??
          existing?.price ??
          (pricingProfileId === undefined ? undefined : 1),
      );
      let price = configuredPrice;
      let prepared:
        Awaited<ReturnType<ReplenishmentGateway["prepare"]>> | undefined;
      let addQuantity = 0;
      if ((starting || previewOnly) && (existing?.tickets.length ?? 0) > 0)
        throw new MarketplaceValidationError(
          "Wait for tracked orders to ship before listing more stock.",
        );
      if (enabled) {
        if (
          (existing?.status === "review-required" ||
            existing?.status === "running") &&
          input.reconciled !== true
        )
          throw new MarketplaceValidationError(
            "Check the live listing and acknowledge reconciliation before re-enabling.",
          );
        if (item.onHand < 1)
          throw new MarketplaceValidationError(
            "Record local stock before enabling auto-relisting.",
          );
        const current = await this.gateway.prepare(
          item,
          price,
          pricingProfileId,
        );
        prepared = current;
        price = replenishmentPrice(current.price ?? price);
        if (
          current.quantity >
          Math.min(
            targetQuantity,
            Math.max(0, item.onHand - (current.reservedQuantity ?? 0)),
          )
        )
          throw new MarketplaceValidationError(
            "The live quantity exceeds this limit. Reduce or delist it before enabling auto-relisting.",
          );
      }
      if (prepared !== undefined) {
        const target = Math.min(
          targetQuantity,
          Math.max(0, item.onHand - (prepared.reservedQuantity ?? 0)),
        );
        addQuantity = Math.max(0, target - prepared.quantity);
        const fingerprint = JSON.stringify({
          item,
          existing,
          account: this.gateway.accountScope(),
          targetQuantity,
          price,
          configuredPrice:
            pricingProfileId === undefined ? configuredPrice : undefined,
          pricingProfileId,
          quantity: prepared.quantity,
          reserved: prepared.reservedQuantity ?? 0,
        });
        if (previewOnly) {
          for (const [key, entry] of this.previews)
            if (entry.expires <= this.now().getTime())
              this.previews.delete(key);
          if (this.previews.size >= 100) this.previews.clear();
          const previewId = randomUUID();
          this.previews.set(previewId, {
            fingerprint,
            expires: this.now().getTime() + 300000,
          });
          return {
            connectionId: this.gateway.connectionId,
            workerRunning: false,
            rules: state.replenishments ?? [],
            preview: {
              id: previewId,
              quantity: prepared.quantity,
              targetQuantity: target,
              addQuantity,
              price,
            },
          };
        }
        if (starting && stored?.fingerprint !== fingerprint)
          throw new MarketplaceValidationError(
            "Stock, pricing, or auto-relist settings changed. Review again.",
          );
      }
      let rule = parseReplenishmentRule({
        displayName: item.displayName,
        localInventoryId: id,
        connectionId: this.gateway.connectionId,
        accountScope: this.gateway.accountScope(),
        targetQuantity,
        price: pricingProfileId === undefined ? configuredPrice : price,
        ...(pricingProfileId === undefined ? {} : { pricingProfileId }),
        enabled,
        tickets:
          enabled && input.reconciled !== true ? (existing?.tickets ?? []) : [],
        jobs: existing?.jobs ?? [],
        status: enabled
          ? "watching"
          : existing?.status === "review-required" ||
              existing?.status === "running"
            ? "review-required"
            : "paused",
        message: enabled
          ? "Watching future sales; replenish after confirmed shipment."
          : "Auto-relisting paused. Outstanding sale tickets cleared.",
      });
      const persist = async () => {
        const rules = [
          ...(state.replenishments ?? []).filter(
            (r) => r.localInventoryId !== id,
          ),
          rule,
        ];
        await save({ ...state, replenishments: rules });
        return {
          connectionId: this.gateway.connectionId,
          workerRunning: false,
          rules,
        };
      };
      if (!starting || prepared === undefined || addQuantity === 0)
        return persist();
      const job = {
        id: randomUUID(),
        at: this.now().toISOString(),
        quantity: addQuantity,
        status: "running" as const,
        message: "Submitting initial public stock.",
      };
      rule = {
        ...rule,
        status: "running",
        jobs: [...rule.jobs.slice(-99), job],
        message: job.message,
      };
      await persist();
      let status: "submitted" | "review-required" = "submitted";
      try {
        await prepared.submit(addQuantity);
      } catch {
        status = "review-required";
      }
      const message =
        status === "submitted"
          ? "Initial listing submitted. Replacements wait for confirmed shipment."
          : "Submission outcome requires review. Check the live listing before re-enabling.";
      rule = {
        ...rule,
        enabled: status === "submitted",
        status: status === "submitted" ? "watching" : "review-required",
        message,
        jobs: [...rule.jobs.slice(0, -1), { ...job, status, message }],
      };
      return persist();
    });
  }

  pauseExactIdentity(namespace: string, value: string): Promise<void> {
    return this.local.withReplenishmentState(async (state, save) => {
      const ids = new Set(
        state.items
          .filter((item) =>
            item.catalogIdentities.some(
              (identity) =>
                identity.namespace === namespace &&
                identity.precision === "exact-variant" &&
                identity.value === value,
            ),
          )
          .map((item) => item.localInventoryId),
      );
      await save({
        ...state,
        replenishments: (state.replenishments ?? []).map((rule) =>
          ids.has(rule.localInventoryId) &&
          rule.connectionId === this.gateway.connectionId
            ? {
                ...rule,
                enabled: false,
                tickets: [],
                status:
                  rule.status === "review-required" || rule.status === "running"
                    ? "review-required"
                    : "paused",
                message: "Paused by explicit delisting.",
              }
            : rule,
        ),
      });
    });
  }

  runOne(): Promise<boolean> {
    return this.local.withReplenishmentState(async (state, save) => {
      const now = this.now();
      const rules = state.replenishments ?? [];
      const rule =
        rules.find(
          (r) =>
            r.connectionId === this.gateway.connectionId &&
            r.status === "running",
        ) ??
        [...rules]
          .filter(
            (r) =>
              r.connectionId === this.gateway.connectionId &&
              r.enabled &&
              r.status !== "review-required" &&
              r.tickets.length > 0 &&
              (r.checkedAt === undefined ||
                now.getTime() - Date.parse(r.checkedAt) >= 60000),
          )
          .sort((a, b) =>
            (a.checkedAt ?? "").localeCompare(b.checkedAt ?? ""),
          )[0];
      if (rule === undefined) return false;
      const persist = (next: ReplenishmentRule) =>
        save({
          ...state,
          replenishments: rules.map((r) =>
            r.localInventoryId === rule.localInventoryId
              ? parseReplenishmentRule(next)
              : r,
          ),
        });
      if (rule.accountScope !== this.gateway.accountScope()) {
        await persist({
          ...rule,
          enabled: false,
          status: "review-required",
          message:
            "The connected seller changed. Reconcile and re-enable for this account.",
        });
        return true;
      }
      if (rule.status === "running") {
        await persist({
          ...rule,
          enabled: false,
          status: "review-required",
          message:
            "Interrupted submission. Check the live listing before re-enabling.",
          jobs: rule.jobs.map((job) =>
            job.status === "running"
              ? {
                  ...job,
                  status: "review-required",
                  message: "Interrupted submission.",
                }
              : job,
          ),
        });
        return true;
      }
      const item = state.items.find(
        (i) => i.localInventoryId === rule.localInventoryId,
      );
      if (item === undefined)
        throw new MarketplaceValidationError(
          "The replenishment item is missing.",
        );
      const checked = { ...rule, checkedAt: now.toISOString() };
      if (item.onHand === 0) {
        await persist({
          ...checked,
          enabled: false,
          status: "out-of-stock",
          tickets: [],
          message: "Local stock exhausted.",
        });
        return true;
      }
      // Check every outstanding sale before publishing any replacement; order details stay in memory.
      let prepared: Awaited<ReturnType<ReplenishmentGateway["prepare"]>>;
      try {
        for (const ticket of rule.tickets) {
          if (!(await this.gateway.isShipped(ticket.ref))) {
            await persist({
              ...checked,
              status: "waiting-shipment",
              message:
                "Waiting for the marketplace to confirm all tracked orders shipped.",
            });
            return true;
          }
        }
        prepared = await this.gateway.prepare(
          item,
          rule.price,
          rule.pricingProfileId,
        );
      } catch {
        await persist({
          ...checked,
          message:
            "Could not verify shipment, inventory, or pricing. Check the connection and saved pricing profile. Will check again; nothing submitted.",
        });
        return true;
      }
      const credit = rule.tickets.reduce(
        (sum, ticket) => sum + ticket.quantity,
        0,
      );
      const quantity = Math.max(
        0,
        Math.min(
          rule.targetQuantity,
          Math.max(0, item.onHand - (prepared.reservedQuantity ?? 0)),
        ) - prepared.quantity,
      );
      const addQuantity = Math.min(quantity, credit);
      const job = {
        id: randomUUID(),
        at: now.toISOString(),
        quantity: addQuantity,
        status: addQuantity === 0 ? ("skipped" as const) : ("running" as const),
        message:
          addQuantity === 0
            ? "Live listing already meets the available stock limit."
            : "Submitting shipped-sale replacement.",
      };
      const running: ReplenishmentRule = {
        ...checked,
        status: addQuantity === 0 ? "watching" : "running",
        tickets: [],
        jobs: [...rule.jobs.slice(-99), job],
        message: job.message,
      };
      await persist(running);
      if (addQuantity === 0) return true;
      let status: "submitted" | "review-required" = "submitted";
      try {
        await prepared.submit(addQuantity);
      } catch {
        status = "review-required";
      }
      const message =
        status === "submitted"
          ? "Replacement submitted after confirmed shipment."
          : "Submission outcome requires review. Check the live listing before re-enabling.";
      await persist({
        ...running,
        enabled: status === "submitted",
        status: status === "submitted" ? "watching" : "review-required",
        message,
        jobs: [...rule.jobs.slice(-99), { ...job, status, message }],
      });
      return true;
    });
  }
}
