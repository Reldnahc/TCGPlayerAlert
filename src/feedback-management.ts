import type {
  ListSellerFeedbackResult,
  SellerFeedbackAggregation,
  SellerFeedbackEntry,
  SellerFeedbackRating,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError } from "./errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";

export interface ManagedSellerFeedbackEntry extends Omit<
  SellerFeedbackEntry,
  "buyerNickname"
> {
  readonly buyerDisplayName?: string;
}

export interface ManagedSellerFeedbackPage {
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly totalFeedback: number;
  readonly feedback: readonly ManagedSellerFeedbackEntry[];
  readonly aggregation: SellerFeedbackAggregation;
  readonly storefrontUrl: string;
  readonly fetchedAt: string;
}

export interface ManagedSellerFeedbackPageInput {
  readonly page?: number;
  readonly rating?: SellerFeedbackRating;
  readonly commentsOnly?: boolean;
  readonly days?: number;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

type FeedbackManagementClient = Pick<
  TcgplayerSellerClient,
  "listSellerFeedback" | "getSellerFeedbackAggregation"
>;

export interface FeedbackManagementServiceOptions {
  readonly client: FeedbackManagementClient;
  readonly sellerKey: SellerKeySource;
  readonly pageSize?: number;
  readonly cacheMilliseconds?: number;
  readonly now?: () => Date;
}

interface Cached<T> {
  readonly expiresAt: number;
  readonly value: T;
}

export class FeedbackManagementService {
  private readonly client: FeedbackManagementClient;
  private readonly sellerKey: SellerKeySource;
  private cachedSellerKey: string | undefined;
  private readonly pageSize: number;
  private readonly cacheMilliseconds: number;
  private readonly now: () => Date;
  private readonly pageCache = new Map<
    string,
    Cached<ListSellerFeedbackResult>
  >();
  private readonly aggregationCache = new Map<
    string,
    Cached<SellerFeedbackAggregation>
  >();

  constructor(options: FeedbackManagementServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    if (typeof options.sellerKey === "string") {
      requiredText(options.sellerKey, "Seller key", 256);
    }
    this.pageSize = boundedInteger(
      options.pageSize ?? 25,
      1,
      100,
      "Feedback page size",
    );
    this.cacheMilliseconds = boundedInteger(
      options.cacheMilliseconds ?? 60_000,
      0,
      3_600_000,
      "Feedback cache duration",
    );
    this.now = options.now ?? (() => new Date());
  }

  async list(
    input: ManagedSellerFeedbackPageInput = {},
  ): Promise<ManagedSellerFeedbackPage> {
    const sellerKey = this.currentSellerKey();
    const page = boundedInteger(input.page ?? 1, 1, 1_000_000, "Feedback page");
    if (
      input.rating !== undefined &&
      (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
    ) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Feedback rating is invalid.",
      );
    }
    if (
      input.commentsOnly !== undefined &&
      typeof input.commentsOnly !== "boolean"
    ) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Feedback comment filter is invalid.",
      );
    }
    const days =
      input.days === undefined
        ? undefined
        : boundedInteger(input.days, 1, 36_500, "Feedback age");
    const [result, aggregation] = await Promise.all([
      this.loadPage(page, {
        ...input,
        ...(days === undefined ? {} : { days }),
      }),
      this.loadAggregation({
        ...input,
        ...(days === undefined ? {} : { days }),
      }),
    ]);
    return {
      page,
      pageSize: this.pageSize,
      totalPages: Math.max(1, Math.ceil(result.totalFeedback / this.pageSize)),
      totalFeedback: result.totalFeedback,
      feedback: result.feedback.map(maskFeedbackBuyer),
      aggregation,
      storefrontUrl: `https://store.tcgplayer.com/sellerfeedback/${encodeURIComponent(sellerKey)}`,
      fetchedAt: this.now().toISOString(),
    };
  }

  private async loadPage(
    page: number,
    input: ManagedSellerFeedbackPageInput,
  ): Promise<ListSellerFeedbackResult> {
    const sellerKey = this.currentSellerKey();
    const key = [
      page,
      input.rating ?? "all",
      input.commentsOnly === true ? "comments" : "all-comments",
      input.days ?? "all-time",
    ].join(":");
    const now = this.now().getTime();
    const cached = this.pageCache.get(key);
    if (
      input.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now
    ) {
      return cached.value;
    }
    const value = await this.client.listSellerFeedback(
      {
        sellerKey,
        offset: (page - 1) * this.pageSize,
        rows: this.pageSize,
        ...(input.rating === undefined ? {} : { rating: input.rating }),
        ...(input.commentsOnly === true ? { requireComment: true } : {}),
        ...(input.days === undefined ? {} : { days: input.days }),
      },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.pageCache.set(key, {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    });
    return value;
  }

  private async loadAggregation(
    input: ManagedSellerFeedbackPageInput,
  ): Promise<SellerFeedbackAggregation> {
    const sellerKey = this.currentSellerKey();
    const key = String(input.days ?? "all-time");
    const now = this.now().getTime();
    const cached = this.aggregationCache.get(key);
    if (
      input.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now
    ) {
      return cached.value;
    }
    const value = await this.client.getSellerFeedbackAggregation(
      {
        sellerKey,
        ...(input.days === undefined ? {} : { days: input.days }),
      },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    this.aggregationCache.set(key, {
      value,
      expiresAt: this.now().getTime() + this.cacheMilliseconds,
    });
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
      this.pageCache.clear();
      this.aggregationCache.clear();
    }
    this.cachedSellerKey = sellerKey;
    return sellerKey;
  }
}

function maskFeedbackBuyer(
  feedback: SellerFeedbackEntry,
): ManagedSellerFeedbackEntry {
  const { buyerNickname, ...visible } = feedback;
  const buyerDisplayName =
    buyerNickname === undefined ? undefined : maskBuyerNickname(buyerNickname);
  return {
    ...visible,
    ...(buyerDisplayName === undefined ? {} : { buyerDisplayName }),
  };
}

export function maskBuyerNickname(value: string): string | undefined {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const first = words[0];
  if (first === undefined) return undefined;
  const last = words.at(-1) ?? first;
  if (words.length > 1) return `${first} ${last.slice(0, 1)}*`;
  if (first.length <= 2) return `${first.slice(0, 1)}*`;
  return `${first.slice(0, 1)}***${first.slice(-1)}`;
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
