import type {
  ListSellerMessageThreadsResult,
  SellerMessage,
  SellerMessageThread,
  SellerMessageThreadSummary,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError } from "./errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";

export interface ManagedSellerMessage extends Omit<SellerMessage, "sender"> {
  readonly senderDisplayName: string;
}

export interface ManagedSellerMessageThreadSummary extends Omit<
  SellerMessageThreadSummary,
  "sender" | "receiver"
> {
  readonly senderDisplayName: string;
  readonly receiverDisplayName: string;
}

export interface ManagedSellerMessageThread extends Omit<
  SellerMessageThread,
  "messages"
> {
  readonly messages: readonly ManagedSellerMessage[];
  readonly totalPages: number;
  readonly portalUrl: string;
  readonly fetchedAt: string;
}

export interface ManagedSellerMessagesPage {
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly totalThreads: number;
  readonly unreadCount: number;
  readonly threads: readonly ManagedSellerMessageThreadSummary[];
  readonly portalUrl: string;
  readonly fetchedAt: string;
}

export interface ManagedSellerMessagesPageInput {
  readonly page?: number;
  readonly orderNumber?: string;
  readonly includeDeleted?: boolean;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface ManagedSellerMessageThreadInput {
  readonly page?: number;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface MarkAllSellerMessagesReadResult {
  readonly markedThreadCount: number;
}

type MessageManagementClient = Pick<
  TcgplayerSellerClient,
  | "listSellerMessageThreads"
  | "getSellerMessageThread"
  | "getSellerUnreadMessageCount"
  | "markSellerMessageThreadRead"
  | "replyToSellerMessageThread"
>;

export interface MessageManagementServiceOptions {
  readonly client: MessageManagementClient;
  readonly sellerKey: SellerKeySource;
  readonly pageSize?: number;
  readonly cacheMilliseconds?: number;
  readonly now?: () => Date;
}

interface Cached<T> {
  readonly expiresAt: number;
  readonly value: T;
}

export class MessageManagementService {
  private readonly client: MessageManagementClient;
  private readonly sellerKey: SellerKeySource;
  private cachedSellerKey: string | undefined;
  private readonly pageSize: number;
  private readonly cacheMilliseconds: number;
  private readonly now: () => Date;
  private readonly pageCache = new Map<
    string,
    Cached<ListSellerMessageThreadsResult>
  >();
  private readonly threadCache = new Map<string, Cached<SellerMessageThread>>();
  private countCache: Cached<number> | undefined;
  private countPending: Promise<number> | undefined;
  private cacheRevision = 0;

  constructor(options: MessageManagementServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    if (typeof options.sellerKey === "string") {
      requiredText(options.sellerKey, "Seller key", 256);
    }
    this.pageSize = boundedInteger(
      options.pageSize ?? 25,
      1,
      100,
      "Message page size",
    );
    this.cacheMilliseconds = boundedInteger(
      options.cacheMilliseconds ?? 30_000,
      0,
      3_600_000,
      "Message cache duration",
    );
    this.now = options.now ?? (() => new Date());
  }

  async list(
    input: ManagedSellerMessagesPageInput = {},
  ): Promise<ManagedSellerMessagesPage> {
    this.currentSellerKey();
    const page = boundedInteger(input.page ?? 1, 1, 1_000_000, "Message page");
    const orderNumber =
      input.orderNumber === undefined
        ? undefined
        : requiredText(input.orderNumber, "Order number", 256);
    if (
      input.includeDeleted !== undefined &&
      typeof input.includeDeleted !== "boolean"
    ) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Deleted-message filter is invalid.",
      );
    }
    const [result, unreadCount] = await Promise.all([
      this.loadPage(page, orderNumber, input),
      this.unreadCount({
        ...(input.force === undefined ? {} : { force: input.force }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    ]);
    return {
      page,
      pageSize: this.pageSize,
      totalPages: Math.max(1, Math.ceil(result.totalThreads / this.pageSize)),
      totalThreads: result.totalThreads,
      unreadCount,
      threads: result.threads.map(manageThreadSummary),
      portalUrl: "https://sellerportal.tcgplayer.com/messages",
      fetchedAt: this.now().toISOString(),
    };
  }

  async get(
    threadId: number,
    input: ManagedSellerMessageThreadInput = {},
  ): Promise<ManagedSellerMessageThread> {
    const sellerKey = this.currentSellerKey();
    const validatedThreadId = boundedInteger(
      threadId,
      1,
      Number.MAX_SAFE_INTEGER,
      "Message thread",
    );
    const page = boundedInteger(
      input.page ?? 1,
      1,
      1_000_000,
      "Message thread page",
    );
    const cacheKey = `${String(validatedThreadId)}:${String(page)}`;
    const now = this.now().getTime();
    const cached = this.threadCache.get(cacheKey);
    let thread: SellerMessageThread;
    if (
      input.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now
    ) {
      thread = cached.value;
    } else {
      const revision = this.cacheRevision;
      thread = await this.client.getSellerMessageThread(
        {
          sellerKey,
          threadId: validatedThreadId,
          page,
          pageSize: this.pageSize,
        },
        input.signal === undefined ? undefined : { signal: input.signal },
      );
      if (this.cacheRevision === revision) {
        this.threadCache.set(cacheKey, {
          value: thread,
          expiresAt: this.now().getTime() + this.cacheMilliseconds,
        });
      }
    }
    return {
      ...thread,
      messages: thread.messages.map(manageMessage),
      totalPages: Math.max(
        1,
        Math.ceil(thread.totalMessageCount / thread.pageSize),
      ),
      portalUrl: `https://sellerportal.tcgplayer.com/messages/${String(thread.threadId)}`,
      fetchedAt: this.now().toISOString(),
    };
  }

  async unreadCount(
    input: ManagedSellerMessageThreadInput = {},
  ): Promise<number> {
    this.currentSellerKey();
    const now = this.now().getTime();
    if (
      input.force !== true &&
      this.countCache !== undefined &&
      this.countCache.expiresAt > now
    ) {
      return this.countCache.value;
    }
    if (this.countPending !== undefined) return this.countPending;
    const previousCount = this.countCache?.value;
    const revision = this.cacheRevision;
    const pending = this.client
      .getSellerUnreadMessageCount(
        input.signal === undefined ? undefined : { signal: input.signal },
      )
      .then((value) => {
        if (this.cacheRevision === revision) {
          if (previousCount !== undefined && value !== previousCount) {
            this.invalidateMessageContent();
          }
          this.countCache = {
            value,
            expiresAt: this.now().getTime() + this.cacheMilliseconds,
          };
        }
        return value;
      })
      .finally(() => {
        if (this.countPending === pending) this.countPending = undefined;
      });
    this.countPending = pending;
    return pending;
  }

  async markRead(threadId: number, signal?: AbortSignal): Promise<void> {
    const sellerKey = this.currentSellerKey();
    const validatedThreadId = boundedInteger(
      threadId,
      1,
      Number.MAX_SAFE_INTEGER,
      "Message thread",
    );
    try {
      await this.client.markSellerMessageThreadRead(
        { sellerKey, threadId: validatedThreadId },
        signal === undefined ? undefined : { signal },
      );
    } finally {
      this.invalidateThread(validatedThreadId);
    }
  }

  async markAllRead(
    signal?: AbortSignal,
  ): Promise<MarkAllSellerMessagesReadResult> {
    const sellerKey = this.currentSellerKey();
    const pageSize = 100;
    const markedThreadIds = new Set<number>();
    let page = 1;
    let hasMorePages = true;
    try {
      while (hasMorePages) {
        const result = await this.client.listSellerMessageThreads(
          { sellerKey, page, pageSize },
          signal === undefined ? undefined : { signal },
        );
        const totalPages = Math.max(
          1,
          Math.ceil(result.totalThreads / pageSize),
        );
        for (const thread of result.threads) {
          if (
            thread.unreadMessageCount < 1 ||
            markedThreadIds.has(thread.threadId)
          ) {
            continue;
          }
          await this.client.markSellerMessageThreadRead(
            { sellerKey, threadId: thread.threadId },
            signal === undefined ? undefined : { signal },
          );
          markedThreadIds.add(thread.threadId);
        }
        hasMorePages = page < totalPages;
        if (hasMorePages) page += 1;
      }
      return { markedThreadCount: markedThreadIds.size };
    } finally {
      this.invalidateAll();
    }
  }

  async reply(
    threadId: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const sellerKey = this.currentSellerKey();
    const validatedThreadId = boundedInteger(
      threadId,
      1,
      Number.MAX_SAFE_INTEGER,
      "Message thread",
    );
    const validatedBody = messageBody(body);
    try {
      await this.client.replyToSellerMessageThread(
        { sellerKey, threadId: validatedThreadId, body: validatedBody },
        signal === undefined ? undefined : { signal },
      );
    } finally {
      this.invalidateThread(validatedThreadId);
    }
  }

  private async loadPage(
    page: number,
    orderNumber: string | undefined,
    input: ManagedSellerMessagesPageInput,
  ): Promise<ListSellerMessageThreadsResult> {
    const sellerKey = this.currentSellerKey();
    const key = [
      page,
      orderNumber ?? "all-orders",
      input.includeDeleted === true ? "deleted" : "active",
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
    const revision = this.cacheRevision;
    const value = await this.client.listSellerMessageThreads(
      {
        sellerKey,
        page,
        pageSize: this.pageSize,
        ...(orderNumber === undefined ? {} : { orderNumber }),
        ...(input.includeDeleted === true ? { includeDeleted: true } : {}),
      },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    if (this.cacheRevision === revision) {
      this.pageCache.set(key, {
        value,
        expiresAt: this.now().getTime() + this.cacheMilliseconds,
      });
    }
    return value;
  }

  private invalidateThread(threadId: number): void {
    this.cacheRevision += 1;
    this.pageCache.clear();
    for (const key of this.threadCache.keys()) {
      if (key.startsWith(`${String(threadId)}:`)) this.threadCache.delete(key);
    }
    this.countCache = undefined;
    this.countPending = undefined;
  }

  private invalidateMessageContent(): void {
    this.cacheRevision += 1;
    this.pageCache.clear();
    this.threadCache.clear();
  }

  private invalidateAll(): void {
    this.cacheRevision += 1;
    this.pageCache.clear();
    this.threadCache.clear();
    this.countCache = undefined;
    this.countPending = undefined;
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
      this.threadCache.clear();
      this.countCache = undefined;
      this.countPending = undefined;
      this.cacheRevision += 1;
    }
    this.cachedSellerKey = sellerKey;
    return sellerKey;
  }
}

function manageThreadSummary(
  thread: SellerMessageThreadSummary,
): ManagedSellerMessageThreadSummary {
  const { sender, receiver, ...visible } = thread;
  return {
    ...visible,
    senderDisplayName: partyDisplayName(sender),
    receiverDisplayName: partyDisplayName(receiver),
  };
}

function manageMessage(message: SellerMessage): ManagedSellerMessage {
  const { sender, ...visible } = message;
  return { ...visible, senderDisplayName: partyDisplayName(sender) };
}

function partyDisplayName(value: string): string {
  return value.trim().toLowerCase() === "me" ? "You" : value.trim();
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

function messageBody(value: string): string {
  if (typeof value !== "string") {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "Reply message is invalid.",
    );
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length < 1 || normalized.length > 10_000) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "Reply message must contain 1-10000 characters.",
    );
  }
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (
      (code <= 0x1f && character !== "\n" && character !== "\t") ||
      code === 0x7f
    ) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Reply message contains unsupported control characters.",
      );
    }
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
