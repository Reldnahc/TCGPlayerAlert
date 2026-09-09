import { describe, expect, it } from "vitest";
import type { InventoryItem } from "../src/marketplaces/contracts.js";
import { ConnectionHealthService } from "../src/marketplaces/health.js";
import {
  AggregateInventoryError,
  MarketplaceInventoryService,
} from "../src/marketplaces/inventory.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
  type ProviderAdapterFactory,
} from "../src/marketplaces/registry.js";
import { syntheticFactory } from "./synthetic-marketplace.js";

const now = new Date("2026-08-31T12:34:56.789Z");

describe("generic marketplace inventory", () => {
  it("walks every page and keeps equal provider keys separate by connection", async () => {
    const first = syntheticFactory("first", "First", {
      inventoryPages: {
        first: { items: [item("shared", "Zulu")], nextCursor: "next" },
        next: { items: [item("first-only", "Alpha")] },
      },
    });
    const second = syntheticFactory("second", "Second", {
      inventoryPages: { first: { items: [item("shared", "Beta")] } },
    });
    const service = inventoryService([first.factory, second.factory]);

    const result = await service.listAll();

    expect(result.connections).toHaveLength(2);
    expect(
      result.connections[0]?.items.map((entry) => entry.displayName),
    ).toEqual(["Alpha", "Zulu"]);
    expect(
      result.connections.flatMap((connection) =>
        connection.items.filter((entry) => entry.inventoryKey === "shared"),
      ),
    ).toHaveLength(2);
    expect(
      first.observation.inventoryQueries.map((query) => query.cursor),
    ).toEqual([undefined, "next"]);
  });

  it("returns good data with a safe issue when another provider fails", async () => {
    const healthy = syntheticFactory("healthy", "Healthy", {
      inventoryPages: { first: { items: [item("healthy", "Healthy item")] } },
    });
    const failing = syntheticFactory("failing", "Failing", {
      readInventoryPage: () =>
        Promise.reject(new Error("private upstream inventory detail")),
    });

    const result = await inventoryService([
      healthy.factory,
      failing.factory,
    ]).listAll();

    expect(result.connections).toHaveLength(1);
    expect(result.issues).toEqual([
      {
        connectionId: "failing-main",
        operation: "inventory",
        code: "INVENTORY_READ_FAILED",
        retryable: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private upstream");
  });

  it("distinguishes all-provider failure from no inventory provider", async () => {
    const failing = syntheticFactory("failing", "Failing", {
      readInventoryPage: () => Promise.reject(new Error("private")),
    });
    await expect(
      inventoryService([failing.factory]).listAll(),
    ).rejects.toMatchObject({
      code: "ALL_INVENTORY_CONNECTIONS_FAILED",
    });

    const noInventory = syntheticFactory("orders", "Orders");
    await expect(
      inventoryService([noInventory.factory]).listAll(),
    ).rejects.toBeInstanceOf(AggregateInventoryError);
    await expect(
      inventoryService([noInventory.factory]).listAll(),
    ).rejects.toMatchObject({ code: "NO_INVENTORY_CONNECTIONS", issues: [] });
  });

  it("rejects repeated cursors and duplicate items across pages", async () => {
    const repeated = syntheticFactory("repeated", "Repeated", {
      inventoryPages: {
        first: { items: [item("one", "One")], nextCursor: "same" },
        same: { items: [item("two", "Two")], nextCursor: "same" },
      },
    });
    await expect(
      inventoryService([repeated.factory]).listConnection("repeated-main"),
    ).rejects.toThrow("REPEATED_INVENTORY_CURSOR");

    const duplicate = syntheticFactory("duplicate", "Duplicate", {
      inventoryPages: {
        first: { items: [item("same", "One")], nextCursor: "next" },
        next: { items: [item("same", "Two")] },
      },
    });
    await expect(
      inventoryService([duplicate.factory]).listConnection("duplicate-main"),
    ).rejects.toThrow("DUPLICATE_INVENTORY_ITEM");
  });

  it("routes mutation only to the exact qualified connection", async () => {
    const first = syntheticFactory("first", "First", {
      inventoryPages: { first: { items: [] } },
      inventoryMutation: "applied",
    });
    const second = syntheticFactory("second", "Second", {
      inventoryPages: { first: { items: [] } },
      inventoryMutation: "applied",
    });
    const result = await inventoryService([
      first.factory,
      second.factory,
    ]).update("second-main", {
      inventoryKey: "same-provider-key",
      quantity: 4,
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    });

    expect(result).toMatchObject({
      connectionId: "second-main",
      outcome: "applied",
    });
    expect(first.observation.inventoryMutations).toHaveLength(0);
    expect(second.observation.inventoryMutations).toHaveLength(1);
  });
});

function item(inventoryKey: string, displayName: string): InventoryItem {
  return {
    inventoryKey,
    displayName,
    quantity: 1,
    price: { currency: "USD", minorUnits: 100 },
    catalogIdentities: [],
    attributes: {},
    quantityMutation: "absolute",
    priceMutable: true,
  };
}

function inventoryService(
  factories: readonly ProviderAdapterFactory[],
  maximumPages = 10,
): MarketplaceInventoryService {
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry(factories),
    connections: Object.fromEntries(
      factories.map((factory) => [
        `${factory.providerId}-main`,
        {
          providerId: factory.providerId,
          enabled: true,
          label: `${factory.providerLabel} store`,
          settings: {},
        },
      ]),
    ),
    secrets: environmentSecretAccess({}),
    now: () => now,
  });
  return new MarketplaceInventoryService({
    registry,
    health: new ConnectionHealthService(registry, { now: () => now }),
    paging: () => ({ pageSize: 2, maximumPages }),
    concurrency: () => 2,
    now: () => now,
  });
}
