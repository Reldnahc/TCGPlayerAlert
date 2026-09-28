import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { LocalInventoryItem } from "../../local-inventory-contracts.js";
import type { TcgplayerSellerClient } from "tcgplayer-private-api";
import {
  ReplenishmentVerificationError,
  type ReplenishmentGateway,
} from "../../replenishment.js";
import type { InventoryAdditionExecutor } from "../../inventory-additions.js";
import type { MarketplaceConnectionRegistry } from "../../marketplaces/registry.js";
import type { PriceUpdateQueueStore } from "../../price-update-queue.js";
import {
  parseOrderDetail,
  type InventoryItem,
} from "../../marketplaces/contracts.js";
import {
  orderRefKey,
  MarketplaceValidationError,
} from "../../marketplaces/identity.js";

export function tcgplayerReplenishmentGateway(options: {
  readonly connectionId: string;
  readonly sellerKey: () => string;
  readonly client: Pick<
    TcgplayerSellerClient,
    "getCatalogProduct" | "searchMarketplaceProducts"
  >;
  readonly registry: MarketplaceConnectionRegistry;
  readonly executor: InventoryAdditionExecutor;
  readonly readListings: () => Promise<readonly InventoryItem[]>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly prices: Pick<PriceUpdateQueueStore, "fixedPrices">;
  readonly pricingProfiles?: ReplenishmentGateway["pricingProfiles"];
  readonly profilePrice?: (
    productId: number,
    skuId: number,
    profileId: string,
  ) => Promise<number>;
  readonly withIdleSku?: <T>(
    skuId: number,
    work: () => Promise<T>,
  ) => Promise<T>;
  readonly reservedElsewhere?: (item: LocalInventoryItem) => Promise<number>;
}): ReplenishmentGateway {
  return {
    connectionId: options.connectionId,
    accountScope: () =>
      createHash("sha256")
        .update(options.sellerKey().trim().toLowerCase())
        .digest("hex"),
    ...(options.pricingProfiles === undefined
      ? {}
      : { pricingProfiles: options.pricingProfiles }),
    async isShipped(ref) {
      if (ref.connectionId !== options.connectionId) return false;
      const detail = parseOrderDetail(
        await options.registry
          .facet(ref.connectionId, "orderDetails")
          .getOrder(ref),
      );
      return (
        orderRefKey(detail.ref) === orderRefKey(ref) &&
        (detail.lifecycle === "shipped" || detail.lifecycle === "delivered")
      );
    },
    async prepare(item, price, pricingProfileId) {
      const skuIds = item.catalogIdentities.filter(
        (i) =>
          i.namespace === "tcgplayer.sku" && i.precision === "exact-variant",
      );
      const productIds = item.catalogIdentities.filter(
        (i) => i.namespace === "tcgplayer.product",
      );
      const skuId = Number(skuIds[0]?.value);
      const productId = Number(productIds[0]?.value);
      if (
        skuIds.length !== 1 ||
        productIds.length !== 1 ||
        !Number.isSafeInteger(skuId) ||
        skuId < 1 ||
        !Number.isSafeInteger(productId) ||
        productId < 1
      )
        throw new MarketplaceValidationError(
          "Auto-relisting requires an exact TCGplayer SKU and product link.",
        );
      const product = await options.client.getCatalogProduct({ productId });
      const sku = product.skus.find((s) => s.productConditionId === skuId);
      if (sku === undefined || !product.sellerListable)
        throw new MarketplaceValidationError("The exact SKU is not listable.");
      const sellerKey = options.sellerKey();
      const [primary, secondary] = await Promise.all(
        [0, 1].map((channelId) =>
          options.client.searchMarketplaceProducts({
            productIds: [productId],
            sellerKey,
            channelId,
            limit: 24,
          }),
        ),
      );
      const listing = primary?.products
        .flatMap((p) => p.listings)
        .find(
          (l) =>
            l.sellerKey === sellerKey &&
            l.productConditionId === skuId &&
            l.channelId === 0,
        );
      if (
        listing?.customData.customListingId !== undefined ||
        secondary?.products.some((p) =>
          p.listings.some(
            (l) => l.sellerKey === sellerKey && l.productConditionId === skuId,
          ),
        )
      )
        throw new MarketplaceValidationError(
          "Custom or secondary inventory cannot auto-relist.",
        );
      const fixedPrice = (await options.prices.fixedPrices())[
        `${String(skuId)}:0`
      ];
      if (pricingProfileId !== undefined && fixedPrice === undefined) {
        if (options.profilePrice === undefined)
          throw new MarketplaceValidationError(
            "Profile pricing is unavailable.",
          );
        price = await options.profilePrice(productId, skuId, pricingProfileId);
      }
      const proposedPrice = fixedPrice ?? price;
      const quantity = listing?.quantity ?? 0;
      const reservedQuantity = (await options.reservedElsewhere?.(item)) ?? 0;
      return {
        quantity,
        price: proposedPrice,
        reservedQuantity,
        async submit(addQuantity) {
          const submit = async () => {
            const fixed = (await options.prices.fixedPrices())[
              `${String(skuId)}:0`
            ];
            await options.executor.apply(
              {
                productId,
                productName: product.productName,
                productConditionId: skuId,
                conditionId: sku.conditionId,
                channelId: 0,
                categoryName: product.productLineName,
                currentQuantity: quantity,
                addQuantity,
                price: fixed ?? proposedPrice,
                storePriceCustomId: null,
                reserveQuantity: 0,
              },
              "add",
            );
            // Retry only fresh inventory reads; never repeat an accepted mutation.
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) await (options.wait ?? delay)(2000);
              try {
                const listings = await options.readListings();
                const matches = listings.filter(
                  (entry) =>
                    entry.inventoryKey === `sku/${String(skuId)}/channel/0`,
                );
                if (
                  options.sellerKey() === sellerKey &&
                  matches.length === 1 &&
                  matches[0]?.quantity === quantity + addQuantity
                )
                  return;
              } catch {
                // A failed verification read is not evidence that the write failed.
              }
            }
            throw new ReplenishmentVerificationError();
          };
          if (options.withIdleSku === undefined) await submit();
          else await options.withIdleSku(skuId, submit);
        },
      };
    },
  };
}
