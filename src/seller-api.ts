import {
  createTcgplayerSellerClient,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ConfigurationError } from "./errors.js";
import type { SellerCredentialAccess } from "./seller-credentials.js";

export interface SellerRequestMetrics {
  readonly maximumConcurrency: number;
  readonly minimumStartSpacingMs: number;
  readonly requestAttempts: number;
  readonly successfulResponses: number;
  readonly errorResponses: number;
  readonly networkFailures: number;
  readonly abortedRequests: number;
  readonly inFlightRequests: number;
  readonly queuedRequests: number;
  readonly peakInFlightRequests: number;
  readonly lastStartedAt?: string;
  readonly lastCompletedAt?: string;
}

export interface SellerRequestGovernorOptions {
  readonly maximumConcurrency?: number;
  readonly minimumStartSpacingMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

interface QueuedRequest {
  readonly signal: AbortSignal | undefined;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
}

export class SellerRequestGovernor {
  private readonly maximumConcurrency: number;
  private readonly minimumStartSpacingMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private readonly queue: QueuedRequest[] = [];
  private startQueue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private activeSlots = 0;
  private pacingWaiters = 0;
  private requestAttempts = 0;
  private successfulResponses = 0;
  private errorResponses = 0;
  private networkFailures = 0;
  private abortedRequests = 0;
  private inFlightRequests = 0;
  private peakInFlightRequests = 0;
  private lastStartedAt: string | undefined;
  private lastCompletedAt: string | undefined;

  constructor(options: SellerRequestGovernorOptions = {}) {
    this.maximumConcurrency = options.maximumConcurrency ?? 2;
    this.minimumStartSpacingMs = options.minimumStartSpacingMs ?? 250;
    if (
      !Number.isInteger(this.maximumConcurrency) ||
      this.maximumConcurrency < 1 ||
      this.maximumConcurrency > 16
    ) {
      throw new ConfigurationError([
        "Seller request concurrency must be an integer from 1 through 16.",
      ]);
    }
    if (
      !Number.isInteger(this.minimumStartSpacingMs) ||
      this.minimumStartSpacingMs < 0 ||
      this.minimumStartSpacingMs > 60_000
    ) {
      throw new ConfigurationError([
        "Seller request start spacing must be an integer from 0 through 60000 milliseconds.",
      ]);
    }
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== "function") {
      throw new ConfigurationError(["A Fetch API implementation is required."]);
    }
    this.now = options.now ?? (() => new Date());
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const signal = requestSignal(input, init);
    await this.acquire(signal);
    try {
      await this.waitForStart(signal);
    } catch (error) {
      this.releaseSlot(false);
      throw error;
    }
    this.requestAttempts += 1;
    this.inFlightRequests += 1;
    this.peakInFlightRequests = Math.max(
      this.peakInFlightRequests,
      this.inFlightRequests,
    );
    this.lastStartedAt = this.now().toISOString();
    try {
      const response = await this.fetchImplementation(input, init);
      return responseWithTrackedBody(response, (bodyError) => {
        if (bodyError === undefined) {
          if (response.ok) this.successfulResponses += 1;
          else this.errorResponses += 1;
        } else if (isAbortError(bodyError)) {
          this.abortedRequests += 1;
        } else {
          this.networkFailures += 1;
        }
        this.completeAttempt();
      });
    } catch (error) {
      if (isAbortError(error)) this.abortedRequests += 1;
      else this.networkFailures += 1;
      this.completeAttempt();
      throw error;
    }
  };

  readonly snapshot = (): SellerRequestMetrics => ({
    maximumConcurrency: this.maximumConcurrency,
    minimumStartSpacingMs: this.minimumStartSpacingMs,
    requestAttempts: this.requestAttempts,
    successfulResponses: this.successfulResponses,
    errorResponses: this.errorResponses,
    networkFailures: this.networkFailures,
    abortedRequests: this.abortedRequests,
    inFlightRequests: this.inFlightRequests,
    queuedRequests: this.queue.length + this.pacingWaiters,
    peakInFlightRequests: this.peakInFlightRequests,
    ...(this.lastStartedAt === undefined
      ? {}
      : { lastStartedAt: this.lastStartedAt }),
    ...(this.lastCompletedAt === undefined
      ? {}
      : { lastCompletedAt: this.lastCompletedAt }),
  });

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortError());
    if (this.activeSlots < this.maximumConcurrency && this.queue.length === 0) {
      this.reserveSlot();
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const queued: QueuedRequest = {
        signal,
        resolve: resolvePromise,
        reject: rejectPromise,
        abort: () => {
          const index = this.queue.indexOf(queued);
          if (index >= 0) this.queue.splice(index, 1);
          rejectPromise(abortError());
        },
      };
      this.queue.push(queued);
      signal?.addEventListener("abort", queued.abort, { once: true });
    });
  }

  private release(): void {
    this.releaseSlot(true);
  }

  private releaseSlot(started: boolean): void {
    this.activeSlots -= 1;
    if (started) this.inFlightRequests -= 1;
    const next = this.queue.shift();
    if (next === undefined) return;
    next.signal?.removeEventListener("abort", next.abort);
    this.reserveSlot();
    next.resolve();
  }

  private completeAttempt(): void {
    this.lastCompletedAt = this.now().toISOString();
    this.release();
  }

  private reserveSlot(): void {
    this.activeSlots += 1;
  }

  private async waitForStart(signal: AbortSignal | undefined): Promise<void> {
    this.pacingWaiters += 1;
    const scheduled = this.startQueue.then(async () => {
      const remaining = Math.max(0, this.nextStartAt - Date.now());
      await wait(remaining, signal);
      this.nextStartAt = Date.now() + this.minimumStartSpacingMs;
    });
    this.startQueue = scheduled.catch(() => undefined);
    try {
      await scheduled;
    } finally {
      this.pacingWaiters -= 1;
    }
  }
}

export interface SellerApiRuntime {
  readonly client: TcgplayerSellerClient;
  readonly credentials: SellerCredentialAccess;
  readonly requests: SellerRequestGovernor;
}

export function createSellerApiRuntime(options: {
  readonly credentials: SellerCredentialAccess;
  readonly requests?: SellerRequestGovernor;
}): SellerApiRuntime {
  const requests = options.requests ?? new SellerRequestGovernor();
  return {
    credentials: options.credentials,
    requests,
    client: createTcgplayerSellerClient({
      session: options.credentials.session,
      onAuthenticationRequired: options.credentials.onAuthenticationRequired,
      fetch: requests.fetch,
      requestDelayMs: 0,
    }),
  };
}

function requestSignal(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): AbortSignal | undefined {
  if (init?.signal !== undefined && init.signal !== null) return init.signal;
  return input instanceof Request ? input.signal : undefined;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function wait(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  if (milliseconds === 0) return Promise.resolve();
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function responseWithTrackedBody(
  response: Response,
  complete: (error?: unknown) => void,
): Response {
  if (response.body === null) {
    complete();
    return response;
  }
  const reader = response.body.getReader();
  let completed = false;
  const finish = (error?: unknown) => {
    if (completed) return;
    completed = true;
    complete(error);
  };
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        finish(error);
      }
    },
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
        finish();
      } catch (error) {
        finish(error);
        throw error;
      }
    },
  });
  const tracked = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(tracked, {
    url: { configurable: true, value: response.url },
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
  });
  return tracked;
}
