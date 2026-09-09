import type {
  MarketplaceListing,
  MarketplaceProduct,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { randomUUID } from "node:crypto";
import {
  parseInventoryItem,
  parseInventoryPage,
  type InventoryItem,
  type InventoryMutator,
  type InventoryPage,
  type InventoryPageQuery,
  type InventoryReader,
} from "../../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
} from "../../marketplaces/identity.js";
import { normalizeTcgplayerProductLine } from "./normalization.js";
import { majorUnitsToMoney } from "../../marketplaces/money.js";

const CURRENCY = "USD";

export type TcgplayerInventoryClient = Pick<
  TcgplayerSellerClient,
  | "listSellerInventory"
  | "updateSellerPrices"
  | "addSellerInventory"
  | "removeSellerInventory"
>;

interface TcgplayerInventoryRecord {
  readonly product: MarketplaceProduct;
  readonly listing: MarketplaceListing;
}

export class TcgplayerInventoryFacet
  implements InventoryReader, InventoryMutator
{
  private readonly snapshots = new Map<
    string,
    {
      readonly records: readonly TcgplayerInventoryRecord[];
      readonly byKey: ReadonlyMap<string, TcgplayerInventoryRecord>;
    }
  >();

  constructor(
    private readonly client: TcgplayerInventoryClient,
    private readonly sellerKey: () => string,
    connectionId: string,
    private readonly maximumProviderPages: number,
  ) {
    parseConnectionId(connectionId);
    if (
      !Number.isSafeInteger(maximumProviderPages) ||
      maximumProviderPages < 1 ||
      maximumProviderPages > 1_000
    ) {
      throw new MarketplaceValidationError(
        "The TCGplayer inventory page limit is invalid.",
      );
    }
  }

  async readInventoryPage(
    query: InventoryPageQuery,
    signal?: AbortSignal,
  ): Promise<InventoryPage> {
    validateQuery(query);
    const parsedCursor = parseCursor(query.cursor);
    const snapshotId = parsedCursor?.snapshotId ?? randomUUID();
    const offset = parsedCursor?.offset ?? 0;
    const snapshot =
      parsedCursor === undefined
        ? await this.readSnapshot(signal)
        : this.snapshots.get(snapshotId);
    if (snapshot === undefined || offset > snapshot.records.length) {
      throw new MarketplaceValidationError(
        "The TCGplayer inventory cursor is stale or invalid.",
      );
    }
    if (parsedCursor === undefined) {
      if (this.snapshots.size >= 8) {
        const oldest = this.snapshots.keys().next().value;
        if (oldest !== undefined) this.snapshots.delete(oldest);
      }
      this.snapshots.set(snapshotId, snapshot);
    }
    const records = snapshot.records.slice(offset, offset + query.pageSize);
    const nextOffset = offset + records.length;
    if (nextOffset >= snapshot.records.length)
      this.snapshots.delete(snapshotId);
    return parseInventoryPage({
      items: records.map(({ product, listing }) =>
        normalizeTcgplayerInventoryItem(product, listing),
      ),
      ...(nextOffset < snapshot.records.length
        ? { nextCursor: `snapshot/${snapshotId}/offset/${String(nextOffset)}` }
        : {}),
    });
  }

  async updateInventory(
    input: Parameters<InventoryMutator["updateInventory"]>[0],
    signal?: AbortSignal,
  ): ReturnType<InventoryMutator["updateInventory"]> {
    if (input.price !== undefined && input.price.currency !== CURRENCY) {
      throw new MarketplaceValidationError(
        "TCGplayer inventory prices must use USD.",
      );
    }
    const identity = parseInventoryKey(input.inventoryKey);
    const currentSnapshot = await this.readSnapshot(signal);
    const record = currentSnapshot.byKey.get(input.inventoryKey);
    if (
      record?.listing.productConditionId !== identity.productConditionId ||
      record.listing.channelId !== identity.channelId
    ) {
      throw new MarketplaceValidationError(
        "The TCGplayer inventory item is unavailable or changed.",
      );
    }
    const { product, listing } = record;
    if (listing.customData.customListingId !== undefined) {
      throw new MarketplaceValidationError(
        "Custom TCGplayer listings cannot be changed automatically.",
      );
    }
    const price = input.price?.minorUnits ?? Math.round(listing.price * 100);
    const currentPrice = Math.round(listing.price * 100);
    if (input.quantity === 0 && listing.quantity === 0) {
      return "already-applied";
    }
    if (input.quantity === listing.quantity && price === currentPrice) {
      return "already-applied";
    }
    const requestOptions = signal === undefined ? undefined : { signal };
    const base = {
      productId: product.productId,
      productName: product.productName,
      productConditionId: listing.productConditionId,
      conditionId: listing.conditionId,
      channelId: listing.channelId,
      categoryName: product.productLineName,
      storePriceCustomId: null,
      reserveQuantity: 0,
    };
    if (input.quantity > listing.quantity) {
      const result = await this.client.addSellerInventory(
        {
          additions: [
            {
              ...base,
              currentQuantity: listing.quantity,
              addQuantity: input.quantity - listing.quantity,
              price: price / 100,
            },
          ],
        },
        requestOptions,
      );
      return submitted(
        result.submittedProductConditionIds,
        listing.productConditionId,
      );
    }
    if (input.quantity === 0) {
      const result = await this.client.removeSellerInventory(
        {
          removals: [
            {
              ...base,
              currentQuantity: listing.quantity,
              price: listing.price,
            },
          ],
        },
        requestOptions,
      );
      return submitted(
        result.submittedProductConditionIds,
        listing.productConditionId,
      );
    }
    if (input.quantity !== listing.quantity) {
      throw new MarketplaceValidationError(
        "TCGplayer inventory can be increased or cleared, but not partially decreased.",
      );
    }
    const result = await this.client.updateSellerPrices(
      {
        updates: [
          {
            ...base,
            quantity: listing.quantity,
            price: price / 100,
          },
        ],
      },
      requestOptions,
    );
    return submitted(
      result.submittedProductConditionIds,
      listing.productConditionId,
    );
  }

  private async readSnapshot(signal?: AbortSignal): Promise<{
    readonly records: readonly TcgplayerInventoryRecord[];
    readonly byKey: ReadonlyMap<string, TcgplayerInventoryRecord>;
  }> {
    const sellerKey = this.sellerKey();
    const options = signal === undefined ? undefined : { signal };
    const [primary, secondary] = await Promise.all([
      this.client.listSellerInventory(
        {
          sellerKey,
          channelId: 0,
          maximumPages: this.maximumProviderPages,
        },
        options,
      ),
      this.client.listSellerInventory(
        {
          sellerKey,
          channelId: 1,
          maximumPages: this.maximumProviderPages,
        },
        options,
      ),
    ]);
    const records = [...primary, ...secondary].flatMap((product) =>
      product.listings
        .filter((listing) => listing.sellerKey === sellerKey)
        .map((listing) => ({ product, listing })),
    );
    const byKey = new Map<string, TcgplayerInventoryRecord>();
    for (const record of records) {
      const key = inventoryKey(record.listing);
      if (byKey.has(key)) {
        throw new MarketplaceValidationError(
          "TCGplayer returned duplicate inventory listings.",
        );
      }
      byKey.set(key, record);
    }
    return { records, byKey };
  }
}

export function normalizeTcgplayerInventoryItem(
  product: MarketplaceProduct,
  listing: MarketplaceListing,
): InventoryItem {
  const mutable = listing.customData.customListingId === undefined;
  return parseInventoryItem({
    inventoryKey: inventoryKey(listing),
    displayName: product.productName,
    quantity: listing.quantity,
    price: majorUnitsToMoney(listing.price, CURRENCY),
    catalogIdentities: [
      {
        namespace: "tcgplayer.sku",
        value: String(listing.productConditionId),
        precision: "exact-variant",
      },
      {
        namespace: "tcgplayer.product",
        value: String(product.productId),
        precision: "product",
      },
    ],
    attributes: nonEmptyAttributes([
      ["productLine", normalizeTcgplayerProductLine(product.productLineName)],
      ["set", product.setName],
      ["rarity", product.rarityName],
      ["condition", listing.condition],
      ["printing", listing.printing],
      ["language", listing.language],
      ["channel", listing.channelId === 0 ? "Marketplace" : "Direct"],
    ]),
    quantityMutation: mutable ? "increase-or-clear" : "unavailable",
    priceMutable: mutable,
  });
}

function nonEmptyAttributes(
  entries: readonly (readonly [string, string])[],
): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value.trim().length > 0) attributes[key] = value;
  }
  return attributes;
}

function inventoryKey(listing: MarketplaceListing): string {
  return `sku/${String(listing.productConditionId)}/channel/${String(listing.channelId)}`;
}

function parseInventoryKey(value: string): {
  readonly productConditionId: number;
  readonly channelId: number;
} {
  const match = /^sku\/(\d{1,16})\/channel\/(\d{1,8})$/u.exec(value);
  const productConditionId = Number(match?.[1]);
  const channelId = Number(match?.[2]);
  if (
    !Number.isSafeInteger(productConditionId) ||
    productConditionId < 1 ||
    !Number.isSafeInteger(channelId) ||
    channelId < 0
  ) {
    throw new MarketplaceValidationError(
      "The TCGplayer inventory key is invalid.",
    );
  }
  return { productConditionId, channelId };
}

function parseCursor(
  value: string | undefined,
): { readonly snapshotId: string; readonly offset: number } | undefined {
  if (value === undefined) return undefined;
  const match =
    /^snapshot\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/offset\/(\d{1,12})$/iu.exec(
      value,
    );
  const snapshotId = match?.[1];
  const offset = Number(match?.[2]);
  if (!Number.isSafeInteger(offset) || offset < 1) {
    throw new MarketplaceValidationError(
      "The TCGplayer inventory cursor is invalid.",
    );
  }
  if (snapshotId === undefined) {
    throw new MarketplaceValidationError(
      "The TCGplayer inventory cursor is invalid.",
    );
  }
  return { snapshotId, offset };
}

function validateQuery(query: InventoryPageQuery): void {
  if (
    !Number.isSafeInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 500
  ) {
    throw new MarketplaceValidationError(
      "The TCGplayer inventory page query is invalid.",
    );
  }
}

function submitted(
  submittedIds: readonly number[],
  expected: number,
): "applied" | "review-required" {
  return submittedIds.includes(expected) ? "applied" : "review-required";
}
