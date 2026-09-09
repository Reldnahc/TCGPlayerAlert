import type {
  ManaPoolSellerClient,
  SellerInventoryItem,
} from "manapool-seller-api";
import {
  parseInventoryItem,
  parseInventoryPage,
  type CatalogIdentity,
  type InventoryItem,
  type InventoryMutator,
  type InventoryPublisher,
  type InventoryPage,
  type InventoryPageQuery,
  type InventoryReader,
} from "../../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
} from "../../marketplaces/identity.js";

export type ManaPoolInventoryClient = Pick<
  ManaPoolSellerClient,
  | "listSellerInventory"
  | "getSellerInventoryByTcgplayerSku"
  | "updateSellerInventoryByTcgplayerSku"
  | "setSellerInventoryByTcgplayerSkus"
>;

export class ManaPoolInventoryFacet
  implements InventoryReader, InventoryMutator, InventoryPublisher
{
  constructor(
    private readonly client: ManaPoolInventoryClient,
    connectionId: string,
  ) {
    parseConnectionId(connectionId);
  }

  async readInventoryPage(
    query: InventoryPageQuery,
    signal?: AbortSignal,
  ): Promise<InventoryPage> {
    validateQuery(query);
    const result = await this.client.listSellerInventory(
      {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.pageSize,
        minimumQuantity: 0,
      },
      signal === undefined ? undefined : { signal },
    );
    return parseInventoryPage({
      items: result.inventory.map(normalizeManaPoolInventoryItem),
      ...(result.pagination.nextCursor === null
        ? {}
        : { nextCursor: result.pagination.nextCursor }),
    });
  }

  async updateInventory(
    input: Parameters<InventoryMutator["updateInventory"]>[0],
    signal?: AbortSignal,
  ): ReturnType<InventoryMutator["updateInventory"]> {
    const identity = parseMutableInventoryKey(input.inventoryKey);
    if (input.price !== undefined && input.price.currency !== "USD") {
      throw new MarketplaceValidationError(
        "ManaPool inventory prices must use USD.",
      );
    }
    const options = signal === undefined ? undefined : { signal };
    const current = await this.client.getSellerInventoryByTcgplayerSku(
      identity.tcgplayerSku,
      options,
    );
    if (current.id !== identity.inventoryId) {
      throw new MarketplaceValidationError(
        "The ManaPool inventory identity no longer matches.",
      );
    }
    const priceCents = input.price?.minorUnits ?? current.priceCents;
    if (
      current.quantity === input.quantity &&
      current.priceCents === priceCents
    ) {
      return "already-applied";
    }
    const updated = await this.client.updateSellerInventoryByTcgplayerSku(
      {
        tcgplayerSku: identity.tcgplayerSku,
        quantity: input.quantity,
        priceCents,
      },
      options,
    );
    return updated.id === identity.inventoryId &&
      updated.quantity === input.quantity &&
      updated.priceCents === priceCents
      ? "applied"
      : "review-required";
  }

  async readExactInventory(
    identity: CatalogIdentity,
    signal?: AbortSignal,
  ): Promise<InventoryItem | undefined> {
    const tcgplayerSku = exactTcgplayerSku(identity);
    try {
      return normalizeManaPoolInventoryItem(
        await this.client.getSellerInventoryByTcgplayerSku(
          tcgplayerSku,
          signal === undefined ? undefined : { signal },
        ),
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async publishExactInventory(
    input: Parameters<InventoryPublisher["publishExactInventory"]>[0],
    signal?: AbortSignal,
  ): ReturnType<InventoryPublisher["publishExactInventory"]> {
    const tcgplayerSku = exactTcgplayerSku(input.exactIdentity);
    if (input.price.currency !== "USD") {
      throw new MarketplaceValidationError(
        "ManaPool inventory prices must use USD.",
      );
    }
    const result = await this.client.setSellerInventoryByTcgplayerSkus(
      [
        {
          tcgplayerSku,
          priceCents: input.price.minorUnits,
          quantity: input.quantity,
        },
      ],
      signal === undefined ? undefined : { signal },
    );
    const item = result.inventory.find(
      (candidate) => candidate.product.tcgplayerSku === tcgplayerSku,
    );
    if (item !== undefined) {
      return { outcome: "applied", item: normalizeManaPoolInventoryItem(item) };
    }
    const skipped = result.skipped.find(
      (candidate) => candidate.tcgplayerSku === tcgplayerSku,
    );
    return {
      outcome: "review-required",
      reasonCode: skipped?.reason ?? "MISSING_UPDATE_RESULT",
    };
  }
}

function exactTcgplayerSku(identity: CatalogIdentity): number {
  if (
    identity.namespace !== "tcgplayer.sku" ||
    identity.precision !== "exact-variant" ||
    !/^\d{1,10}$/u.test(identity.value)
  ) {
    throw new MarketplaceValidationError(
      "ManaPool publication requires an exact TCGplayer SKU.",
    );
  }
  const value = Number(identity.value);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new MarketplaceValidationError("The exact TCGplayer SKU is invalid.");
  }
  return value;
}

export function normalizeManaPoolInventoryItem(
  item: SellerInventoryItem,
): InventoryItem {
  const single = item.product.single;
  const sealed = item.product.sealed;
  const name = single?.name ?? sealed?.name ?? "ManaPool product";
  const identities: CatalogIdentity[] = [
    {
      namespace: "manapool.product",
      value: item.productId,
      precision: "exact-variant",
    },
    ...(item.product.tcgplayerSku === null
      ? []
      : [
          {
            namespace: "tcgplayer.sku",
            value: String(item.product.tcgplayerSku),
            precision: "exact-variant" as const,
          },
        ]),
    ...(single === null
      ? []
      : [
          {
            namespace: "scryfall.printing",
            value: single.scryfallId,
            precision: "product" as const,
          },
        ]),
    ...(single?.tcgplayerId === null || single?.tcgplayerId === undefined
      ? []
      : [
          {
            namespace: "tcgplayer.product",
            value: String(single.tcgplayerId),
            precision: "product" as const,
          },
        ]),
    ...(sealed?.tcgplayerId === null || sealed?.tcgplayerId === undefined
      ? []
      : [
          {
            namespace: "tcgplayer.product",
            value: String(sealed.tcgplayerId),
            precision: "product" as const,
          },
        ]),
    ...(single === null && sealed === null
      ? []
      : [
          {
            namespace: "mtgjson.uuid",
            value: (single ?? sealed)?.mtgjsonId ?? "",
            precision: "product" as const,
          },
        ]),
  ];
  const mutable = item.product.tcgplayerSku !== null;
  return parseInventoryItem({
    inventoryKey:
      item.product.tcgplayerSku === null
        ? `item/${encodeURIComponent(item.id)}`
        : mutableInventoryKey(item.product.tcgplayerSku, item.id),
    displayName: name,
    quantity: item.quantity,
    price: { currency: "USD", minorUnits: item.priceCents },
    catalogIdentities: identities,
    attributes: Object.fromEntries(
      Object.entries({
        productType: item.productType,
        set: single?.set ?? sealed?.set ?? "",
        setCode: single?.set ?? sealed?.set ?? "",
        number: single?.number ?? "",
        collectorNumber: single?.number ?? "",
        language: single?.languageId ?? sealed?.languageId ?? "",
        condition: single?.conditionId ?? "",
        finish: single?.finishId ?? "",
      }).filter((entry): entry is [string, string] => entry[1] !== ""),
    ),
    quantityMutation: mutable ? "absolute" : "unavailable",
    priceMutable: mutable,
  });
}

function mutableInventoryKey(
  tcgplayerSku: number,
  inventoryId: string,
): string {
  return `sku/${String(tcgplayerSku)}/item/${encodeURIComponent(inventoryId)}`;
}

function parseMutableInventoryKey(value: string): {
  readonly tcgplayerSku: number;
  readonly inventoryId: string;
} {
  const match = /^sku\/(\d{1,16})\/item\/(.+)$/u.exec(value);
  const skuText = match?.[1];
  const encodedId = match?.[2];
  if (skuText === undefined || encodedId === undefined) {
    throw new MarketplaceValidationError(
      "This ManaPool inventory item cannot be changed automatically.",
    );
  }
  const tcgplayerSku = Number(skuText);
  let inventoryId: string;
  try {
    inventoryId = decodeURIComponent(encodedId);
  } catch {
    throw new MarketplaceValidationError(
      "The ManaPool inventory key is invalid.",
    );
  }
  if (
    !Number.isSafeInteger(tcgplayerSku) ||
    tcgplayerSku < 1 ||
    inventoryId.trim() === "" ||
    Array.from(inventoryId).length > 256
  ) {
    throw new MarketplaceValidationError(
      "The ManaPool inventory key is invalid.",
    );
  }
  return { tcgplayerSku, inventoryId };
}

function validateQuery(query: InventoryPageQuery): void {
  if (
    !Number.isSafeInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 500 ||
    (query.cursor !== undefined &&
      (query.cursor.length === 0 || query.cursor.length > 1_024))
  ) {
    throw new MarketplaceValidationError(
      "The ManaPool inventory page query is invalid.",
    );
  }
}
