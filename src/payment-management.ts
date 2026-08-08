import {
  SellerPayoutStatus,
  type LegacySellerPayment,
  type ListLegacySellerPaymentsResult,
  type ListLegacyUpcomingSellerPaymentsResult,
  type ListSellerPayoutsResult,
  type SellerPaymentExperience,
  type SellerPayoutDetail,
  type SellerPayoutStatus as SellerPayoutStatusCode,
  type SellerUnpaidBalance,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError } from "./errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";

export interface ManagedMoneyMovementPaymentsPage {
  readonly experience: "money-movement";
  readonly totalPayouts: number;
  readonly page: number;
  readonly pageSize: number;
  readonly payouts: ListSellerPayoutsResult["payouts"];
  readonly unpaidBalance: SellerUnpaidBalance;
  readonly fetchedAt: string;
}

export interface ManagedLegacyPaymentsPage {
  readonly experience: "legacy";
  readonly page: number;
  readonly totalPages: number;
  readonly upcomingPayments: readonly LegacySellerPayment[];
  readonly pastPayments: readonly LegacySellerPayment[];
  readonly fetchedAt: string;
}

export type ManagedPaymentsPage =
  ManagedMoneyMovementPaymentsPage | ManagedLegacyPaymentsPage;

export interface ManagedPaymentsPageInput {
  readonly page?: number;
  readonly status?: SellerPayoutStatusCode;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

type PaymentManagementClient = Pick<
  TcgplayerSellerClient,
  | "getSellerPaymentExperience"
  | "listLegacySellerPayments"
  | "listLegacyUpcomingSellerPayments"
  | "listSellerPayouts"
  | "getSellerPayout"
  | "getSellerUnpaidBalance"
>;

export interface PaymentManagementServiceOptions {
  readonly client: PaymentManagementClient;
  readonly sellerKey: SellerKeySource;
  readonly pageSize?: number;
  readonly cacheMilliseconds?: number;
  readonly detailCacheMilliseconds?: number;
  readonly now?: () => Date;
}

interface Cached<T> {
  readonly expiresAt: number;
  readonly value: T;
}

const PAYOUT_STATUSES = new Set<SellerPayoutStatusCode>(
  Object.values(SellerPayoutStatus),
);

export class PaymentManagementService {
  private readonly client: PaymentManagementClient;
  private readonly sellerKey: SellerKeySource;
  private cachedSellerKey: string | undefined;
  private readonly pageSize: number;
  private readonly cacheMilliseconds: number;
  private readonly detailCacheMilliseconds: number;
  private readonly now: () => Date;
  private experienceCache: Cached<SellerPaymentExperience> | undefined;
  private readonly pageCache = new Map<
    string,
    Cached<ListSellerPayoutsResult>
  >();
  private readonly legacyPageCache = new Map<
    number,
    Cached<ListLegacySellerPaymentsResult>
  >();
  private readonly detailCache = new Map<string, Cached<SellerPayoutDetail>>();
  private unpaidBalanceCache: Cached<SellerUnpaidBalance> | undefined;
  private legacyUpcomingCache:
    Cached<ListLegacyUpcomingSellerPaymentsResult> | undefined;

  constructor(options: PaymentManagementServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    if (typeof options.sellerKey === "string") {
      requiredText(options.sellerKey, "Seller key", 256);
    }
    this.pageSize = boundedInteger(
      options.pageSize ?? 25,
      1,
      100,
      "Payment page size",
    );
    this.cacheMilliseconds = boundedInteger(
      options.cacheMilliseconds ?? 60_000,
      0,
      3_600_000,
      "Payment cache duration",
    );
    this.detailCacheMilliseconds = boundedInteger(
      options.detailCacheMilliseconds ?? 300_000,
      0,
      3_600_000,
      "Payment detail cache duration",
    );
    this.now = options.now ?? (() => new Date());
  }

  async list(
    input: ManagedPaymentsPageInput = {},
  ): Promise<ManagedPaymentsPage> {
    this.currentSellerKey();
    const page = boundedInteger(input.page ?? 1, 1, 1_000_000, "Payment page");
    if (input.status !== undefined && !PAYOUT_STATUSES.has(input.status)) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Payment status is invalid.",
      );
    }
    const experience = await this.loadExperience(input);
    if (experience === "legacy") {
      if (input.status !== undefined) {
        throw new ApplicationError(
          "CONFIGURATION_ERROR",
          "Payment status filters are unavailable for legacy payments.",
        );
      }
      const [history, upcoming] = await Promise.all([
        this.loadLegacyPage(page, input),
        this.loadLegacyUpcoming(input),
      ]);
      return {
        experience,
        page: history.page,
        totalPages: history.totalPages,
        upcomingPayments: upcoming.payments,
        pastPayments: history.payments,
        fetchedAt: this.now().toISOString(),
      };
    }

    const [payoutPage, unpaidBalance] = await Promise.all([
      this.loadPayoutPage(page, input),
      this.loadUnpaidBalance(input),
    ]);
    return {
      experience,
      ...payoutPage,
      unpaidBalance,
      fetchedAt: this.now().toISOString(),
    };
  }

  async get(
    referenceId: string,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<SellerPayoutDetail> {
    const sellerKey = this.currentSellerKey();
    const normalized = requiredText(referenceId, "Payout reference", 256);
    const experience = await this.loadExperience(options);
    if (experience === "legacy") {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "Transaction-level payout details are unavailable for legacy payments.",
      );
    }
    const now = this.now().getTime();
    const cached = this.detailCache.get(normalized);
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now
    ) {
      return cached.value;
    }
    const value = await this.client.getSellerPayout(
      { sellerKey, referenceId: normalized },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    this.detailCache.set(normalized, {
      value,
      expiresAt: this.now().getTime() + this.detailCacheMilliseconds,
    });
    return value;
  }

  private async loadExperience(input: {
    readonly force?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<SellerPaymentExperience> {
    const sellerKey = this.currentSellerKey();
    const now = this.now().getTime();
    if (
      input.force !== true &&
      this.experienceCache !== undefined &&
      this.experienceCache.expiresAt > now
    ) {
      return this.experienceCache.value;
    }
    const value = await this.client.getSellerPaymentExperience(
      { sellerKey },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.experienceCache = {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    };
    return value;
  }

  private async loadLegacyPage(
    page: number,
    input: ManagedPaymentsPageInput,
  ): Promise<ListLegacySellerPaymentsResult> {
    const now = this.now().getTime();
    const cached = this.legacyPageCache.get(page);
    if (
      input.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now
    ) {
      return cached.value;
    }
    const value = await this.client.listLegacySellerPayments(
      { page },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.legacyPageCache.set(page, {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    });
    return value;
  }

  private async loadLegacyUpcoming(
    input: ManagedPaymentsPageInput,
  ): Promise<ListLegacyUpcomingSellerPaymentsResult> {
    const now = this.now().getTime();
    if (
      input.force !== true &&
      this.legacyUpcomingCache !== undefined &&
      this.legacyUpcomingCache.expiresAt > now
    ) {
      return this.legacyUpcomingCache.value;
    }
    const value = await this.client.listLegacyUpcomingSellerPayments(
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.legacyUpcomingCache = {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    };
    return value;
  }

  private async loadPayoutPage(
    page: number,
    input: ManagedPaymentsPageInput,
  ): Promise<ListSellerPayoutsResult> {
    const sellerKey = this.currentSellerKey();
    const key = `${String(page)}:${input.status ?? "all"}`;
    const now = this.now().getTime();
    const cached = this.pageCache.get(key);
    if (
      input.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now
    ) {
      return cached.value;
    }
    const value = await this.client.listSellerPayouts(
      {
        sellerKey,
        page,
        pageSize: this.pageSize,
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.pageCache.set(key, {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    });
    return value;
  }

  private async loadUnpaidBalance(
    input: ManagedPaymentsPageInput,
  ): Promise<SellerUnpaidBalance> {
    const sellerKey = this.currentSellerKey();
    const now = this.now().getTime();
    if (
      input.force !== true &&
      this.unpaidBalanceCache !== undefined &&
      this.unpaidBalanceCache.expiresAt > now
    ) {
      return this.unpaidBalanceCache.value;
    }
    const value = await this.client.getSellerUnpaidBalance(
      { sellerKey },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.unpaidBalanceCache = {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    };
    return value;
  }

  private currentSellerKey(): string {
    const sellerKey = requiredText(
      resolveSellerKey(this.sellerKey),
      "Seller key",
      256,
    );
    if (
      this.cachedSellerKey !== undefined &&
      this.cachedSellerKey.toLowerCase() !== sellerKey.toLowerCase()
    ) {
      this.experienceCache = undefined;
      this.pageCache.clear();
      this.legacyPageCache.clear();
      this.detailCache.clear();
      this.unpaidBalanceCache = undefined;
      this.legacyUpcomingCache = undefined;
    }
    this.cachedSellerKey = sellerKey;
    return sellerKey;
  }
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    containsControlCharacter(normalized)
  ) {
    throw new ApplicationError("CONFIGURATION_ERROR", `${label} is invalid.`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      `${label} must be between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}
