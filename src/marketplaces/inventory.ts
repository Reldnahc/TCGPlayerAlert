import {
  parseInventoryMutationCommand,
  parseInventoryPage,
  type InventoryItem,
  type InventoryMutationCommand,
  type InventoryMutationOutcome,
  type MarketplaceConnectionDescriptor,
  type ProviderIssue,
} from "./contracts.js";
import type { ConnectionHealthService } from "./health.js";
import { MarketplaceValidationError, parseConnectionId } from "./identity.js";
import type {
  MarketplaceConnection,
  MarketplaceConnectionRegistry,
} from "./registry.js";

export interface InventoryPagingSettings {
  readonly pageSize: number;
  readonly maximumPages: number;
}

export interface ConnectionInventory {
  readonly descriptor: MarketplaceConnectionDescriptor;
  readonly items: readonly InventoryItem[];
}

export interface InventoryListResult {
  readonly connections: readonly ConnectionInventory[];
  readonly issues: readonly ProviderIssue[];
  readonly completedAt: string;
}

export interface InventoryMutationResult {
  readonly connectionId: string;
  readonly inventoryKey: string;
  readonly outcome: InventoryMutationOutcome;
}

export class AggregateInventoryError extends Error {
  readonly code:
    "NO_INVENTORY_CONNECTIONS" | "ALL_INVENTORY_CONNECTIONS_FAILED";

  constructor(
    code: AggregateInventoryError["code"],
    readonly issues: readonly ProviderIssue[],
  ) {
    super(
      code === "NO_INVENTORY_CONNECTIONS"
        ? "No enabled marketplace connection supplies inventory."
        : "Every eligible marketplace inventory connection failed.",
    );
    this.name = "AggregateInventoryError";
    this.code = code;
  }
}

export class MarketplaceInventoryService {
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      readonly registry: MarketplaceConnectionRegistry;
      readonly health: ConnectionHealthService;
      readonly paging: (connectionId: string) => InventoryPagingSettings;
      readonly concurrency: () => number | Promise<number>;
      readonly now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async listAll(signal?: AbortSignal): Promise<InventoryListResult> {
    const eligible = this.options.registry
      .list()
      .filter((connection) => connection.facets.inventoryReader !== undefined);
    if (eligible.length === 0) {
      throw new AggregateInventoryError("NO_INVENTORY_CONNECTIONS", []);
    }
    const concurrency = validateConcurrency(await this.options.concurrency());
    const results = await mapConcurrent(
      eligible,
      concurrency,
      async (connection) => {
        try {
          return {
            inventory: await this.readConnection(connection, signal),
          } as const;
        } catch (error) {
          signal?.throwIfAborted();
          return {
            issue: inventoryIssue(connection.descriptor.connectionId, error),
          } as const;
        }
      },
    );
    const connections = results.flatMap((result) =>
      "inventory" in result ? [result.inventory] : [],
    );
    const issues = results.flatMap((result) =>
      "issue" in result ? [result.issue] : [],
    );
    if (connections.length === 0) {
      throw new AggregateInventoryError(
        "ALL_INVENTORY_CONNECTIONS_FAILED",
        issues,
      );
    }
    return {
      connections: connections.sort((left, right) =>
        left.descriptor.connectionId.localeCompare(
          right.descriptor.connectionId,
        ),
      ),
      issues,
      completedAt: this.now().toISOString(),
    };
  }

  async listConnection(
    rawConnectionId: string,
    signal?: AbortSignal,
  ): Promise<ConnectionInventory> {
    const connectionId = parseConnectionId(rawConnectionId);
    const connection = this.options.registry.require(connectionId);
    if (connection.facets.inventoryReader === undefined) {
      throw new MarketplaceValidationError(
        "The marketplace connection does not support inventory reads.",
      );
    }
    return this.readConnection(connection, signal);
  }

  async update(
    rawConnectionId: string,
    value: InventoryMutationCommand,
    signal?: AbortSignal,
  ): Promise<InventoryMutationResult> {
    const connectionId = parseConnectionId(rawConnectionId);
    const command = parseInventoryMutationCommand(value);
    await this.assertReadable(connectionId, signal);
    const outcome: unknown = await this.options.registry
      .facet(connectionId, "inventoryMutator")
      .updateInventory(command, signal);
    if (
      outcome !== "applied" &&
      outcome !== "already-applied" &&
      outcome !== "review-required"
    ) {
      throw new MarketplaceValidationError(
        "The provider returned an invalid inventory mutation result.",
      );
    }
    return {
      connectionId,
      inventoryKey: command.inventoryKey,
      outcome,
    };
  }

  private async readConnection(
    connection: MarketplaceConnection,
    signal?: AbortSignal,
  ): Promise<ConnectionInventory> {
    const connectionId = connection.descriptor.connectionId;
    await this.assertReadable(connectionId, signal);
    const reader = this.options.registry.facet(connectionId, "inventoryReader");
    const paging = validatePaging(this.options.paging(connectionId));
    const items: InventoryItem[] = [];
    const itemKeys = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let pageNumber = 1;
      pageNumber <= paging.maximumPages;
      pageNumber += 1
    ) {
      const page = parseInventoryPage(
        await reader.readInventoryPage(
          {
            ...(cursor === undefined ? {} : { cursor }),
            pageSize: paging.pageSize,
          },
          signal,
        ),
      );
      for (const item of page.items) {
        if (itemKeys.has(item.inventoryKey)) {
          throw new InventoryContractError("DUPLICATE_INVENTORY_ITEM");
        }
        itemKeys.add(item.inventoryKey);
        items.push(item);
      }
      if (page.nextCursor === undefined) {
        return {
          descriptor: connection.descriptor,
          items: items.sort((left, right) =>
            left.displayName.localeCompare(right.displayName),
          ),
        };
      }
      if (page.items.length === 0) {
        throw new InventoryContractError("EMPTY_INVENTORY_PAGE_WITH_CURSOR");
      }
      if (cursors.has(page.nextCursor)) {
        throw new InventoryContractError("REPEATED_INVENTORY_CURSOR");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new InventoryContractError("INVENTORY_PAGE_LIMIT_EXCEEDED");
  }

  private async assertReadable(
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const health = await this.options.health.check(connectionId, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (health.state !== "connected" && health.state !== "degraded") {
      throw new InventoryConnectionError(
        health.issueCode ??
          `HEALTH_${health.state.toUpperCase().replaceAll("-", "_")}`,
        health.retryable ?? false,
      );
    }
  }
}

class InventoryContractError extends Error {
  constructor(readonly issueCode: string) {
    super(issueCode);
    this.name = "InventoryContractError";
  }
}

class InventoryConnectionError extends Error {
  constructor(
    readonly issueCode: string,
    readonly retryable: boolean,
  ) {
    super("The marketplace connection is unavailable for inventory.");
    this.name = "InventoryConnectionError";
  }
}

function inventoryIssue(connectionId: string, error: unknown): ProviderIssue {
  if (error instanceof InventoryConnectionError) {
    return {
      connectionId,
      operation: "inventory",
      code: error.issueCode,
      retryable: error.retryable,
    };
  }
  return {
    connectionId,
    operation: "inventory",
    code:
      error instanceof InventoryContractError
        ? error.issueCode
        : "INVENTORY_READ_FAILED",
    retryable: !(error instanceof InventoryContractError),
  };
}

function validatePaging(
  value: InventoryPagingSettings,
): InventoryPagingSettings {
  if (
    !Number.isSafeInteger(value.pageSize) ||
    value.pageSize < 1 ||
    value.pageSize > 500 ||
    !Number.isSafeInteger(value.maximumPages) ||
    value.maximumPages < 1 ||
    value.maximumPages > 1_000
  ) {
    throw new MarketplaceValidationError(
      "The inventory paging settings are invalid.",
    );
  }
  return value;
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
    throw new MarketplaceValidationError(
      "Inventory concurrency must be an integer from 1 through 8.",
    );
  }
  return value;
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(values.length, concurrency) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    }),
  );
  return results;
}
