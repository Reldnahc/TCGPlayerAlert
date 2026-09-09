import { describe, expect, it } from "vitest";
import type { LocalInventoryItem } from "../src/local-inventory.js";
import {
  planLocalInventoryImport,
  projectLocalInventoryWorkspace,
} from "../src/local-inventory-workspace.js";
import type { InventoryListResult } from "../src/marketplaces/inventory.js";

const completedAt = "2026-08-25T20:00:00.000Z";
const localInventoryId = "00000000-0000-4000-8000-000000000001";

describe("local inventory workspace", () => {
  it("links observations only by exact variant and retains unmatched listings", () => {
    const workspace = projectLocalInventoryWorkspace(
      [localItem()],
      marketplaceInventory(),
      completedAt,
    );

    expect(workspace.items).toHaveLength(1);
    expect(workspace.listings).toMatchObject([
      {
        descriptor: { connectionId: "first-main" },
        localInventoryId,
      },
      {
        descriptor: { connectionId: "second-main" },
      },
    ]);
    expect(workspace.listings[1]).not.toHaveProperty("localInventoryId");
  });

  it("keeps local stock available without any marketplace result", () => {
    expect(
      projectLocalInventoryWorkspace([localItem()], undefined, completedAt),
    ).toMatchObject({
      items: [{ localInventoryId, onHand: 2 }],
      listings: [],
      issues: [],
    });
  });

  it("groups cross-listed exact variants and uses the highest quantity without summing", () => {
    const inventory = marketplaceInventory();
    const first = inventory.connections[0];
    const second = inventory.connections[1];
    if (first === undefined || second === undefined) {
      throw new Error("Missing marketplace fixtures.");
    }
    const firstItem = first.items[0];
    const secondItem = second.items[0];
    if (firstItem === undefined || secondItem === undefined) {
      throw new Error("Missing marketplace inventory items.");
    }
    const preview = planLocalInventoryImport(
      [],
      {
        ...inventory,
        connections: [
          {
            ...first,
            items: [{ ...firstItem, quantity: 5 }],
          },
          {
            ...second,
            items: [
              {
                ...secondItem,
                quantity: 3,
                catalogIdentities: [
                  ...secondItem.catalogIdentities,
                  {
                    namespace: "tcgplayer.sku",
                    value: "101",
                    precision: "exact-variant",
                  },
                ],
              },
              {
                ...secondItem,
                inventoryKey: "product-only",
                catalogIdentities: [
                  {
                    namespace: "shared.product",
                    value: "303",
                    precision: "product",
                  },
                ],
              },
              {
                ...secondItem,
                inventoryKey: "zero-listing",
                quantity: 0,
              },
            ],
          },
        ],
      },
      completedAt,
    );

    expect(preview).toMatchObject({
      candidates: [
        {
          suggestedOnHand: 5,
          crossListed: true,
          observations: [
            { connectionId: "first-main", quantity: 5 },
            { connectionId: "second-main", quantity: 3 },
          ],
        },
      ],
      skippedWithoutExactIdentityCount: 1,
      skippedZeroQuantityCount: 1,
    });
    expect(
      planLocalInventoryImport([localItem()], inventory, completedAt),
    ).toMatchObject({ alreadyLinkedCount: 1 });
  });

  it("groups provider listings by a shared product and normalized complete variant", () => {
    const preview = planLocalInventoryImport(
      [],
      {
        connections: [
          inventoryConnection("tcgplayer-main", {
            inventoryKey: "tcg-sku-123",
            displayName: "Synthetic Card",
            quantity: 4,
            catalogIdentities: [
              {
                namespace: "tcgplayer.sku",
                value: "123",
                precision: "exact-variant",
              },
              {
                namespace: "tcgplayer.product",
                value: "456",
                precision: "product",
              },
            ],
            attributes: {
              language: "English",
              condition: "Near Mint",
              printing: "Normal",
            },
            quantityMutation: "absolute",
            priceMutable: false,
          }),
          inventoryConnection("manapool-main", {
            inventoryKey: "mana-product",
            displayName: "Synthetic Card",
            quantity: 3,
            catalogIdentities: [
              {
                namespace: "manapool.product",
                value: "mana-product",
                precision: "exact-variant",
              },
              {
                namespace: "tcgplayer.product",
                value: "456",
                precision: "product",
              },
            ],
            attributes: {
              language: "en",
              condition: "near_mint",
              finish: "nonfoil",
            },
            quantityMutation: "absolute",
            priceMutable: false,
          }),
        ],
        issues: [],
        completedAt,
      },
      completedAt,
    );

    expect(preview).toMatchObject({
      candidates: [
        {
          suggestedOnHand: 4,
          crossListed: true,
          observations: [
            { connectionId: "manapool-main", quantity: 3 },
            { connectionId: "tcgplayer-main", quantity: 4 },
          ],
        },
      ],
    });
    expect(preview.candidates[0]?.catalogIdentities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: "tcgplayer.sku", value: "123" }),
        expect.objectContaining({
          namespace: "manapool.product",
          value: "mana-product",
        }),
      ]),
    );
  });

  it("does not group product matches with incomplete variant attributes", () => {
    const inventory = marketplaceInventory();
    const connections = inventory.connections.map((connection) => ({
      ...connection,
      items: connection.items.map((item) => ({
        ...item,
        catalogIdentities: [
          ...item.catalogIdentities,
          {
            namespace: "tcgplayer.product",
            value: "456",
            precision: "product" as const,
          },
        ],
        attributes: { language: "English", condition: "Near Mint" },
      })),
    }));

    expect(
      planLocalInventoryImport([], { ...inventory, connections }, completedAt)
        .candidates,
    ).toHaveLength(2);
  });

  it("quarantines a fallback group with contradictory provider exact IDs", () => {
    const connection = (
      connectionId: string,
      sku: string,
    ): InventoryListResult["connections"][number] =>
      inventoryConnection(connectionId, {
        inventoryKey: sku,
        displayName: "Synthetic Card",
        quantity: 1,
        catalogIdentities: [
          {
            namespace: "tcgplayer.sku",
            value: sku,
            precision: "exact-variant",
          },
          {
            namespace: "tcgplayer.product",
            value: "456",
            precision: "product",
          },
        ],
        attributes: {
          language: "English",
          condition: "Near Mint",
          printing: "Normal",
        },
        quantityMutation: "absolute",
        priceMutable: false,
      });
    const preview = planLocalInventoryImport(
      [],
      {
        connections: [
          connection("first-main", "123"),
          connection("second-main", "999"),
        ],
        issues: [],
        completedAt,
      },
      completedAt,
    );

    expect(preview).toMatchObject({
      candidates: [],
      conflictingIdentityCount: 1,
    });
  });
});

function inventoryConnection(
  connectionId: string,
  item: InventoryListResult["connections"][number]["items"][number],
): InventoryListResult["connections"][number] {
  return {
    descriptor: {
      connectionId,
      providerId: connectionId.split("-")[0] ?? "provider",
      providerLabel: connectionId,
      connectionLabel: connectionId,
    },
    items: [item],
  };
}

function localItem(): LocalInventoryItem {
  return {
    localInventoryId,
    displayName: "Synthetic Card",
    onHand: 2,
    catalogIdentities: [
      {
        namespace: "tcgplayer.sku",
        value: "101",
        precision: "exact-variant",
      },
    ],
    attributes: { condition: "Near Mint" },
    createdAt: completedAt,
    updatedAt: completedAt,
  };
}

function marketplaceInventory(): InventoryListResult {
  return {
    connections: [
      {
        descriptor: {
          connectionId: "first-main",
          providerId: "first",
          providerLabel: "First",
          connectionLabel: "First store",
        },
        items: [
          {
            inventoryKey: "first-listing",
            displayName: "Synthetic Card",
            quantity: 2,
            catalogIdentities: [
              {
                namespace: "tcgplayer.sku",
                value: "101",
                precision: "exact-variant",
              },
            ],
            attributes: {},
            quantityMutation: "absolute",
            priceMutable: false,
          },
        ],
      },
      {
        descriptor: {
          connectionId: "second-main",
          providerId: "second",
          providerLabel: "Second",
          connectionLabel: "Second store",
        },
        items: [
          {
            inventoryKey: "second-listing",
            displayName: "Unmatched Card",
            quantity: 1,
            catalogIdentities: [
              {
                namespace: "second.sku",
                value: "202",
                precision: "exact-variant",
              },
            ],
            attributes: {},
            quantityMutation: "absolute",
            priceMutable: false,
          },
        ],
      },
    ],
    issues: [],
    completedAt,
  };
}
