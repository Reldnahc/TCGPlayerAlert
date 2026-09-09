import { parseConnectionHealth, type ConnectionHealth } from "./contracts.js";
import type {
  ConfiguredConnectionStatus,
  MarketplaceConnectionRegistry,
} from "./registry.js";

const DEFAULT_HEALTH_TTL_MILLISECONDS = 30_000;

interface CachedHealth {
  readonly value: ConnectionHealth;
  readonly expiresAt: number;
}

export interface MarketplaceConnectionStatus extends ConfiguredConnectionStatus {
  readonly health: ConnectionHealth;
}

export class ConnectionHealthService {
  private readonly cache = new Map<string, CachedHealth>();
  private readonly active = new Map<string, Promise<ConnectionHealth>>();
  private readonly now: () => Date;
  private readonly ttlMilliseconds: number;

  constructor(
    private readonly registry: MarketplaceConnectionRegistry,
    options: {
      readonly now?: () => Date;
      readonly ttlMilliseconds?: number;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMilliseconds =
      options.ttlMilliseconds ?? DEFAULT_HEALTH_TTL_MILLISECONDS;
    if (
      !Number.isSafeInteger(this.ttlMilliseconds) ||
      this.ttlMilliseconds < 1
    ) {
      throw new Error("The connection health cache duration is invalid.");
    }
  }

  check(
    connectionId: string,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionHealth> {
    const connection = this.registry.require(connectionId);
    const timestamp = this.now().getTime();
    const cached = this.cache.get(connectionId);
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.expiresAt > timestamp
    ) {
      return Promise.resolve(cached.value);
    }
    const existing = this.active.get(connectionId);
    if (existing !== undefined) return existing;
    const result = connection.health
      .checkHealth(options.signal)
      .then((value) => {
        const parsed = parseConnectionHealth(value);
        const checkedAt = this.now().toISOString();
        const normalized = parseConnectionHealth({ ...parsed, checkedAt });
        this.cache.set(connectionId, {
          value: normalized,
          expiresAt: this.now().getTime() + this.ttlMilliseconds,
        });
        return normalized;
      })
      .catch(() => {
        const unavailable: ConnectionHealth = {
          state: "unavailable",
          checkedAt: this.now().toISOString(),
          issueCode: "HEALTH_CHECK_FAILED",
          retryable: true,
        };
        this.cache.set(connectionId, {
          value: unavailable,
          expiresAt: this.now().getTime() + this.ttlMilliseconds,
        });
        return unavailable;
      })
      .finally(() => this.active.delete(connectionId));
    this.active.set(connectionId, result);
    return result;
  }

  async statuses(
    options: { readonly force?: boolean } = {},
  ): Promise<readonly MarketplaceConnectionStatus[]> {
    return Promise.all(
      this.registry.statusDescriptors().map(async (status) => ({
        ...status,
        health: status.enabled
          ? await this.check(status.descriptor.connectionId, options)
          : { state: "disabled" as const },
      })),
    );
  }

  invalidate(connectionId?: string): void {
    if (connectionId === undefined) this.cache.clear();
    else this.cache.delete(connectionId);
  }
}
