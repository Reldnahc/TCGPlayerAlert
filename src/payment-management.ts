import {
  SellerPayoutStatus,
  type ListSellerPayoutsResult,
  type SellerPayoutDetail,
  type SellerPayoutStatus as SellerPayoutStatusCode,
  type SellerUnpaidBalance,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError } from "./errors.js";

export interface ManagedPaymentsPage {
  readonly totalPayouts: number;
  readonly page: number;
  readonly pageSize: number;
  readonly payouts: ListSellerPayoutsResult["payouts"];
  readonly unpaidBalance: SellerUnpaidBalance;
  readonly fetchedAt: string;
}

export interface ManagedPaymentsPageInput {
  readonly page?: number;
  readonly status?: SellerPayoutStatusCode;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

type PaymentManagementClient = Pick<
  TcgplayerSellerClient,
  "listSellerPayouts" | "getSellerPayout" | "getSellerUnpaidBalance"
>;

export interface PaymentManagementServiceOptions {
  readonly client: PaymentManagementClient;
  readonly sellerKey: string;
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
  private readonly sellerKey: string;
  private readonly pageSize: number;
  private readonly cacheMilliseconds: number;
  private readonly detailCacheMilliseconds: number;
  private readonly now: () => Date;
  private readonly pageCache = new Map<
    string,
    Cached<ListSellerPayoutsResult>
  >();
  private readonly detailCache = new Map<string, Cached<SellerPayoutDetail>>();
  private unpaidBalanceCache?: Cached<SellerUnpaidBalance>;

  constructor(options: PaymentManagementServiceOptions) {
    this.client = options.client;
    this.sellerKey = requiredText(options.sellerKey, "Seller key", 256);
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
    const page = boundedInteger(input.page ?? 1, 1, 1_000_000, "Payment page");
    if (input.status !== undefined && !PAYOUT_STATUSES.has(input.status)) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Payment status is invalid.",
      );
    }
    const payoutPage = await this.loadPayoutPage(page, input);
    const unpaidBalance = await this.loadUnpaidBalance(input);
    return {
      ...payoutPage,
      unpaidBalance,
      fetchedAt: this.now().toISOString(),
    };
  }

  async get(
    referenceId: string,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<SellerPayoutDetail> {
    const normalized = requiredText(referenceId, "Payout reference", 256);
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
      { sellerKey: this.sellerKey, referenceId: normalized },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    this.detailCache.set(normalized, {
      value,
      expiresAt: this.now().getTime() + this.detailCacheMilliseconds,
    });
    return value;
  }

  private async loadPayoutPage(
    page: number,
    input: ManagedPaymentsPageInput,
  ): Promise<ListSellerPayoutsResult> {
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
        sellerKey: this.sellerKey,
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
    const now = this.now().getTime();
    if (
      input.force !== true &&
      this.unpaidBalanceCache !== undefined &&
      this.unpaidBalanceCache.expiresAt > now
    ) {
      return this.unpaidBalanceCache.value;
    }
    const value = await this.client.getSellerUnpaidBalance(
      { sellerKey: this.sellerKey },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.unpaidBalanceCache = {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    };
    return value;
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
