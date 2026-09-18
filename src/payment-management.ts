import {
  SellerPayoutStatus,
  type LegacySellerPayment,
  type ListLegacySellerPaymentsResult,
  type ListLegacyUpcomingSellerPaymentsResult,
  type ListSellerPayoutsResult,
  type SellerPaymentExperience,
  type SellerPayoutDetail,
  type SellerPayoutStatus as TcgplayerSellerPayoutStatusCode,
  type SellerUnpaidBalance,
  type TcgplayerSellerClient,
} from "./providers/tcgplayer/sdk.js";
import { ApplicationError } from "./errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";

export type SellerPayoutStatusCode = TcgplayerSellerPayoutStatusCode;
export type ManagedSellerPayoutDetail = SellerPayoutDetail;
export const SELLER_PAYOUT_STATUS_VALUES: readonly SellerPayoutStatusCode[] =
  Object.values(SellerPayoutStatus);

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

export interface ManagedPaymentReportPeriod {
  readonly year: number;
  readonly month?: number;
  readonly amount: number;
  readonly payments: number;
  readonly orders: number;
}

export interface ManagedPaymentReport {
  readonly experience: SellerPaymentExperience;
  readonly months: readonly ManagedPaymentReportPeriod[];
  readonly years: readonly ManagedPaymentReportPeriod[];
  readonly fetchedAt: string;
}

export interface ManagedPaymentReportInput {
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
  SELLER_PAYOUT_STATUS_VALUES,
);
const MAX_REPORT_PAGES = 1_000;

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

  async report(
    input: ManagedPaymentReportInput = {},
  ): Promise<ManagedPaymentReport> {
    this.currentSellerKey();
    const experience = await this.loadExperience(input);
    const payments =
      experience === "legacy"
        ? await this.loadLegacyReportPayments(input)
        : await this.loadMoneyMovementReportPayments(input);
    return {
      experience,
      ...aggregatePaymentReport(payments),
      fetchedAt: this.now().toISOString(),
    };
  }

  private async loadMoneyMovementReportPayments(
    input: ManagedPaymentReportInput,
  ): Promise<readonly ReportPayment[]> {
    const pageInput = {
      ...input,
      status: SellerPayoutStatus.Succeeded,
    };
    const first = await this.loadPayoutPage(1, pageInput);
    const totalPages = Math.max(
      1,
      Math.ceil(first.totalPayouts / first.pageSize),
    );
    assertReportPageCount(totalPages);
    const pages = [first];
    for (let page = 2; page <= totalPages; page += 1) {
      pages.push(await this.loadPayoutPage(page, pageInput));
    }
    return pages.flatMap((result) =>
      result.payouts
        .filter((payout) => payout.status === SellerPayoutStatus.Succeeded)
        .map((payout) => ({
          date: payout.lastSentAt ?? payout.createdAt,
          amount: payout.amount,
          orders: payout.ordersCount,
        })),
    );
  }

  private async loadLegacyReportPayments(
    input: ManagedPaymentReportInput,
  ): Promise<readonly ReportPayment[]> {
    const first = await this.loadLegacyPage(1, input);
    assertReportPageCount(first.totalPages);
    const pages = [first];
    for (let page = 2; page <= first.totalPages; page += 1) {
      pages.push(await this.loadLegacyPage(page, input));
    }
    return pages.flatMap((result) =>
      result.payments.flatMap((payment) => {
        const date = payment.estimatedArrivalDate ?? payment.initiatedDate;
        return date === null
          ? []
          : [{ date, amount: payment.amount, orders: payment.ordersCount }];
      }),
    );
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

interface ReportPayment {
  readonly date: string;
  readonly amount: number;
  readonly orders: number;
}

function aggregatePaymentReport(payments: readonly ReportPayment[]): {
  readonly months: readonly ManagedPaymentReportPeriod[];
  readonly years: readonly ManagedPaymentReportPeriod[];
} {
  const months = new Map<string, ManagedPaymentReportPeriod>();
  const years = new Map<number, ManagedPaymentReportPeriod>();
  for (const payment of payments) {
    const match = /^(\d{4})-(\d{2})/u.exec(payment.date);
    if (match === null) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const monthKey = `${String(year)}-${String(month).padStart(2, "0")}`;
    const currentMonth = months.get(monthKey);
    months.set(monthKey, {
      year,
      month,
      amount: (currentMonth?.amount ?? 0) + payment.amount,
      payments: (currentMonth?.payments ?? 0) + 1,
      orders: (currentMonth?.orders ?? 0) + payment.orders,
    });
    const currentYear = years.get(year);
    years.set(year, {
      year,
      amount: (currentYear?.amount ?? 0) + payment.amount,
      payments: (currentYear?.payments ?? 0) + 1,
      orders: (currentYear?.orders ?? 0) + payment.orders,
    });
  }
  return {
    months: [...months.values()].sort(
      (left, right) =>
        right.year - left.year || (right.month ?? 0) - (left.month ?? 0),
    ),
    years: [...years.values()].sort((left, right) => right.year - left.year),
  };
}

function assertReportPageCount(totalPages: number): void {
  if (
    !Number.isSafeInteger(totalPages) ||
    totalPages < 1 ||
    totalPages > MAX_REPORT_PAGES
  ) {
    throw new ApplicationError(
      "PROVIDER_ERROR",
      "Payment history is too large to summarize safely.",
    );
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
