import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  JsonLocalInventoryStore,
  LocalInventoryService,
} from "../src/local-inventory.js";
import { MarketplacePublicationService } from "../src/marketplace-publications.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  type ProviderAdapterFactory,
} from "../src/marketplaces/registry.js";

const localId = "00000000-0000-4000-8000-000000000001";
const previewId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000003";

describe("marketplace publication", () => {
  it("quotes an exact identity through the destination provider", async () => {
    const quoteExactListing = vi.fn(() =>
      Promise.resolve({
        price: { currency: "USD", minorUnits: 299 },
        source: "market-low" as const,
        availableQuantity: 4,
        asOf: "2026-09-08T12:00:00.000Z",
      }),
    );
    const path = await statePath();
    const { service } = await publicationFixture(
      path,
      {
        readExactInventory: vi.fn(() => Promise.resolve(undefined)),
        publishExactInventory: vi.fn(),
      },
      quoteExactListing,
    );

    await expect(
      service.quote({
        connectionId: "manapool-main",
        exactIdentity: exactSku(),
      }),
    ).resolves.toMatchObject({
      connectionId: "manapool-main",
      connectionLabel: "ManaPool",
      price: { currency: "USD", minorUnits: 299 },
      source: "market-low",
    });
    expect(quoteExactListing).toHaveBeenCalledWith(exactSku(), undefined);
  });

  it("reviews live state, persists intent, and publishes exact local stock", async () => {
    const readExactInventory = vi.fn(() => Promise.resolve(undefined));
    const publishExactInventory = vi.fn(() =>
      Promise.resolve({
        outcome: "applied" as const,
        item: inventoryItem(2, 250),
      }),
    );
    const path = await statePath();
    const service = await publicationService(path, {
      readExactInventory,
      publishExactInventory,
    });

    const preview = await service.preview({
      connectionId: "manapool-main",
      localInventoryId: localId,
      quantity: 2,
      price: { currency: "USD", minorUnits: 250 },
    });
    expect(preview.currentListing).toBeUndefined();

    await expect(service.publish(preview.id)).resolves.toMatchObject({
      id: jobId,
      status: "submitted",
      quantity: 2,
    });
    expect(readExactInventory).toHaveBeenCalledTimes(2);
    expect(publishExactInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        exactIdentity: {
          namespace: "tcgplayer.sku",
          value: "456",
          precision: "exact-variant",
        },
        quantity: 2,
        price: { currency: "USD", minorUnits: 250 },
        idempotencyKey: jobId,
      }),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      jobs: [{ id: jobId, status: "submitted" }],
    });
  });

  it("blocks publication when local stock changes after preview", async () => {
    const publisher = {
      readExactInventory: vi.fn(() => Promise.resolve(undefined)),
      publishExactInventory: vi.fn(() =>
        Promise.resolve({
          outcome: "applied" as const,
          item: inventoryItem(2, 250),
        }),
      ),
    };
    const path = await statePath();
    const { service, local } = await publicationFixture(path, publisher);
    const preview = await service.preview({
      connectionId: "manapool-main",
      localInventoryId: localId,
      quantity: 2,
      price: { currency: "USD", minorUnits: 250 },
    });
    await local.setQuantity(localId, 1);

    await expect(service.publish(preview.id)).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
    });
    expect(publisher.publishExactInventory).not.toHaveBeenCalled();
  });
});

async function publicationService(
  path: string,
  publisher: Publisher,
): Promise<MarketplacePublicationService> {
  return (await publicationFixture(path, publisher)).service;
}

async function publicationFixture(
  path: string,
  publisher: Publisher,
  quoteExactListing?: (identity: ReturnType<typeof exactSku>) => Promise<{
    readonly price: { readonly currency: string; readonly minorUnits: number };
    readonly source: "market-low";
    readonly availableQuantity: number;
    readonly asOf: string;
  }>,
) {
  const local = new LocalInventoryService(
    new JsonLocalInventoryStore(`${path}.local.json`),
    {
      now: () => new Date("2026-09-03T20:00:00.000Z"),
      id: () => localId,
    },
  );
  await local.add({
    displayName: "Synthetic Card",
    quantity: 3,
    catalogIdentities: [
      {
        namespace: "tcgplayer.sku",
        value: "456",
        precision: "exact-variant",
      },
    ],
    attributes: { condition: "Near Mint" },
  });
  const factory: ProviderAdapterFactory = {
    providerId: "manapool",
    providerLabel: "ManaPool",
    supportedFacets: [
      "inventory-publisher",
      ...(quoteExactListing === undefined ? [] : (["listing-quotes"] as const)),
    ],
    create: (context) => ({
      descriptor: {
        connectionId: context.connectionId,
        providerId: "manapool",
        providerLabel: "ManaPool",
        connectionLabel: context.connectionLabel,
      },
      health: { checkHealth: () => Promise.resolve({ state: "connected" }) },
      facets: {
        inventoryPublisher: publisher,
        ...(quoteExactListing === undefined
          ? {}
          : { listingQuotes: { quoteExactListing } }),
      },
    }),
  };
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([factory]),
    connections: {
      "manapool-main": {
        providerId: "manapool",
        enabled: true,
        label: "ManaPool",
        settings: {},
      },
    },
    secrets: { get: () => undefined },
  });
  const ids = [previewId, jobId];
  return {
    local,
    service: new MarketplacePublicationService(path, local, registry, {
      now: () => new Date("2026-09-03T20:00:00.000Z"),
      id: () => ids.shift() ?? jobId,
    }),
  };
}

interface Publisher {
  readExactInventory: (identity: {
    readonly namespace: string;
    readonly value: string;
    readonly precision: "exact-variant" | "product";
  }) => Promise<ReturnType<typeof inventoryItem> | undefined>;
  publishExactInventory: (input: unknown) => Promise<{
    readonly outcome: "applied";
    readonly item: ReturnType<typeof inventoryItem>;
  }>;
}

function inventoryItem(quantity: number, minorUnits: number) {
  return {
    inventoryKey: "sku/456/item/synthetic",
    displayName: "Synthetic Card",
    quantity,
    price: { currency: "USD", minorUnits },
    catalogIdentities: [
      {
        namespace: "tcgplayer.sku",
        value: "456",
        precision: "exact-variant" as const,
      },
    ],
    attributes: {},
    quantityMutation: "absolute" as const,
    priceMutable: true,
  };
}

function exactSku() {
  return {
    namespace: "tcgplayer.sku",
    value: "456",
    precision: "exact-variant" as const,
  };
}

async function statePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "publication-test-")), "state.json");
}
