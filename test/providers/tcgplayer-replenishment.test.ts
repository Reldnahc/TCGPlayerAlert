import { describe, expect, it, vi } from "vitest";
import { tcgplayerReplenishmentGateway } from "../../src/providers/tcgplayer/replenishment.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
} from "../../src/marketplaces/registry.js";
import {
  syntheticFactory,
  syntheticNormalizedOrder,
} from "../synthetic-marketplace.js";
import type { LocalInventoryItem } from "../../src/local-inventory-contracts.js";
import type { MarketplaceListing } from "tcgplayer-private-api";

const item: LocalInventoryItem = {
  localInventoryId: "00000000-0000-4000-8000-000000000001",
  displayName: "Synthetic Promo",
  onHand: 4,
  catalogIdentities: [
    { namespace: "tcgplayer.sku", value: "456", precision: "exact-variant" },
    { namespace: "tcgplayer.product", value: "123", precision: "product" },
  ],
  attributes: {},
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};
function setup(
  secondary = false,
  lifecycle: "ready-to-ship" | "shipped" | "canceled" = "ready-to-ship",
) {
  const factory = syntheticFactory("tcgplayer", "Synthetic", {
    detail: {
      ...syntheticNormalizedOrder({
        connectionId: "tcgplayer-main",
        remoteId: "synthetic",
      }),
      lifecycle,
      shippingAddress: {
        recipientName: "Synthetic Buyer",
        addressOne: "1 Example Street",
        city: "Example",
        territory: "CA",
        country: "US",
        postalCode: "00000",
      },
      lines: [],
      trackingNumbers: [],
    },
  });
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([factory.factory]),
    connections: {
      "tcgplayer-main": {
        providerId: "tcgplayer",
        enabled: true,
        label: "Synthetic Store",
        settings: {},
      },
    },
    secrets: environmentSecretAccess({}),
  });
  const apply = vi.fn(() => Promise.resolve());
  const getCatalogProduct = vi.fn(() =>
    Promise.resolve({
      productId: 123,
      productName: "Synthetic Promo",
      productLineName: "Synthetic Game",
      setName: "Synthetic Set",
      rarityName: "",
      cardNumber: "",
      imageUrl: "https://product-images.tcgplayer.com/fit-in/200x279/123.jpg",
      marketPrice: 2,
      sellerListable: true,
      skus: [
        {
          productConditionId: 456,
          conditionId: 6,
          condition: "Unopened",
          printing: "Normal",
          language: "English",
        },
      ],
    }),
  );
  const listing: MarketplaceListing = {
    listingId: 1,
    productId: 123,
    productConditionId: 456,
    conditionId: 6,
    condition: "Unopened",
    printing: "Normal",
    language: "English",
    languageId: 1,
    channelId: 1,
    sellerKey: "synthetic-seller",
    sellerName: "Synthetic Store",
    quantity: 1,
    price: 2,
    shippingPrice: 0,
    customData: {},
  };
  let fixed: Readonly<Record<string, number>> = {};
  const liveListing = {
    inventoryKey: "sku/456/channel/0",
    displayName: "Synthetic Promo",
    quantity: 1,
    catalogIdentities: [],
    attributes: {},
    quantityMutation: "increase-or-clear" as const,
    priceMutable: true,
  };
  const readListings = vi.fn(() => Promise.resolve([liveListing]));
  const wait = vi.fn(() => Promise.resolve());
  const profilePrice = vi.fn(() => Promise.resolve(1.75));
  const gateway = tcgplayerReplenishmentGateway({
    profilePrice,
    readListings,
    wait,
    connectionId: "tcgplayer-main",
    registry,
    sellerKey: () => "synthetic-seller",
    executor: { apply },
    prices: { fixedPrices: () => Promise.resolve(fixed) },
    reservedElsewhere: () => Promise.resolve(2),
    client: {
      getCatalogProduct,
      searchMarketplaceProducts: (input) =>
        Promise.resolve({
          totalProducts: secondary && input.channelId === 1 ? 1 : 0,
          products:
            secondary && input.channelId === 1
              ? [
                  {
                    productId: 123,
                    productName: "Synthetic Promo",
                    productLineName: "Synthetic Game",
                    setName: "Synthetic Set",
                    rarityName: "",
                    marketPrice: 2,
                    totalListings: 1,
                    listings: [listing],
                  },
                ]
              : [],
        }),
    },
  });
  return {
    gateway,
    readListings,
    liveListing,
    wait,
    profilePrice,
    apply,
    getCatalogProduct,
    setFixed: () => {
      fixed = { "456:0": 2.5 };
    },
  };
}
describe("TCGplayer replenishment adapter", () => {
  it("waits for delayed visibility using reads only", async () => {
    const f = setup();
    f.readListings.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const prepared = await f.gateway.prepare(item, 2);
    await prepared.submit(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.readListings).toHaveBeenCalledTimes(3);
    expect(f.wait).toHaveBeenCalledTimes(2);
  });
  it.each(["missing", "wrong quantity", "wrong SKU", "read failure"])(
    "rejects apparent success when live inventory has %s without submitting twice",
    async (failure) => {
      const f = setup();
      if (failure === "missing") f.readListings.mockResolvedValue([]);
      if (failure === "wrong quantity")
        f.readListings.mockResolvedValue([{ ...f.liveListing, quantity: 2 }]);
      if (failure === "wrong SKU")
        f.readListings.mockResolvedValue([
          { ...f.liveListing, inventoryKey: "sku/999/channel/0" },
        ]);
      if (failure === "read failure")
        f.readListings.mockRejectedValue(new Error("Read failed"));
      const prepared = await f.gateway.prepare(item, 2);
      await expect(prepared.submit(1)).rejects.toThrow(
        "expected live quantity could not be confirmed",
      );
      expect(f.apply).toHaveBeenCalledTimes(1);
      expect(f.readListings).toHaveBeenCalledTimes(3);
    },
  );
  it("recalculates the selected profile for each replacement and never falls back to a stale price", async () => {
    const f = setup();
    const first = await f.gateway.prepare(item, 99, "smart");
    expect(first.price).toBe(1.75);
    await first.submit(1);
    expect(f.profilePrice).toHaveBeenCalledWith(123, 456, "smart");
    f.profilePrice.mockResolvedValue(2.25);
    const next = await f.gateway.prepare(item, 99, "smart");
    await next.submit(1);
    expect(f.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: 2.25 }),
      "add",
    );
    f.profilePrice.mockRejectedValue(new Error("Missing profile"));
    await expect(f.gateway.prepare(item, 99, "missing")).rejects.toThrow(
      "Missing profile",
    );
    expect(f.apply).toHaveBeenCalledTimes(2);
    f.setFixed();
    const fixed = await f.gateway.prepare(item, 99, "missing");
    expect(fixed.price).toBe(2.5);
    await fixed.submit(1);
    expect(f.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: 2.5 }),
      "add",
    );
  });
  it("recreates a missing exact sealed SKU through the live-validating executor and honors a newly saved fixed price", async () => {
    const f = setup();
    const prepared = await f.gateway.prepare(item, 1.5);
    expect(prepared.quantity).toBe(0);
    expect(prepared.reservedQuantity).toBe(2);
    f.setFixed();
    await prepared.submit(1);
    expect(f.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 123,
        productConditionId: 456,
        conditionId: 6,
        currentQuantity: 0,
        addQuantity: 1,
        price: 2.5,
      }),
      "add",
    );
    expect(f.gateway.accountScope()).not.toContain("synthetic-seller");
  });
  it("holds secondary inventory and rejects missing exact product identity", async () => {
    await expect(setup(true).gateway.prepare(item, 2)).rejects.toThrow(
      "secondary",
    );
    await expect(
      setup().gateway.prepare({ ...item, catalogIdentities: [] }, 2),
    ).rejects.toThrow("exact");
  });
  it("accepts a fresh shipped status and rejects canceled orders", async () => {
    const ref = { connectionId: "tcgplayer-main", remoteId: "synthetic" };
    expect(await setup(false, "shipped").gateway.isShipped(ref)).toBe(true);
    expect(await setup(false, "canceled").gateway.isShipped(ref)).toBe(false);
  });
  it("does not infer shipment from disappearance or a different connection", async () => {
    const f = setup();
    expect(
      await f.gateway.isShipped({
        connectionId: "other",
        remoteId: "synthetic",
      }),
    ).toBe(false);
    expect(
      await f.gateway.isShipped({
        connectionId: "tcgplayer-main",
        remoteId: "synthetic",
      }),
    ).toBe(false);
  });
});
