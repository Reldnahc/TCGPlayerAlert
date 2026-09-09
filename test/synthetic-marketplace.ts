import type {
  CatalogIdentity,
  ConnectionHealth,
  FulfillmentMutator,
  InventoryMutationCommand,
  InventoryPage,
  InventoryPageQuery,
  MutationResult,
  NativeDocumentResult,
  OrderDetail,
  OrderPage,
  OrderPageQuery,
  OrderSummary,
  PullLine,
} from "../src/marketplaces/contracts.js";
import type {
  MarketplaceConnection,
  MarketplaceFacetId,
  ProviderAdapterFactory,
  ProviderFactoryContext,
} from "../src/marketplaces/registry.js";

export interface SyntheticFactoryControls {
  readonly pages?: Readonly<Record<string, OrderPage>>;
  readonly health?: ConnectionHealth;
  readonly failHealth?: boolean;
  readonly failOrders?: boolean;
  readonly orderFailure?: { enabled: boolean };
  readonly readOrderPage?: (query: OrderPageQuery) => Promise<OrderPage>;
  readonly mutable?: boolean;
  readonly detail?: OrderDetail;
  readonly nativeDocument?: NativeDocumentResult | Error;
  readonly pullLines?: readonly PullLine[] | Error;
  readonly catalogMetadata?:
    | Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
    | Error;
  readonly catalogSearch?: boolean;
  readonly inventoryPages?: Readonly<Record<string, InventoryPage>>;
  readonly readInventoryPage?: (
    query: InventoryPageQuery,
  ) => Promise<InventoryPage>;
  readonly inventoryMutation?:
    "applied" | "already-applied" | "review-required";
}

export interface SyntheticFactoryObservation {
  healthChecks: number;
  orderQueries: OrderPageQuery[];
  trackingCommands: string[];
  shippedRemoteIds: string[];
  detailRemoteIds: string[];
  nativeDocumentRemoteIds: string[];
  pullLineRemoteIds: string[][];
  catalogIdentityReads: CatalogIdentity[][];
  inventoryQueries: InventoryPageQuery[];
  inventoryMutations: InventoryMutationCommand[];
}

export function syntheticFactory(
  providerId: string,
  providerLabel: string,
  controls: SyntheticFactoryControls = {},
): {
  readonly factory: ProviderAdapterFactory;
  readonly observation: SyntheticFactoryObservation;
} {
  const nativeDocument = controls.nativeDocument;
  const pullLines = controls.pullLines;
  const catalogMetadata = controls.catalogMetadata;
  const inventoryPages = controls.inventoryPages;
  const observation: SyntheticFactoryObservation = {
    healthChecks: 0,
    orderQueries: [],
    trackingCommands: [],
    shippedRemoteIds: [],
    detailRemoteIds: [],
    nativeDocumentRemoteIds: [],
    pullLineRemoteIds: [],
    catalogIdentityReads: [],
    inventoryQueries: [],
    inventoryMutations: [],
  };
  const supportedFacets: MarketplaceFacetId[] = [
    "order-pages",
    "order-details",
    ...(controls.mutable === true ? (["fulfillment"] as const) : []),
    ...(nativeDocument === undefined ? [] : (["native-documents"] as const)),
    ...(pullLines === undefined ? [] : (["pull-lines"] as const)),
    ...(catalogMetadata === undefined ? [] : (["catalog-metadata"] as const)),
    ...(controls.catalogSearch === true ? (["catalog-search"] as const) : []),
    ...(inventoryPages === undefined && controls.readInventoryPage === undefined
      ? []
      : (["inventory-reader"] as const)),
    ...(controls.inventoryMutation === undefined
      ? []
      : (["inventory-mutator"] as const)),
  ];
  return {
    observation,
    factory: {
      providerId,
      providerLabel,
      supportedFacets,
      create(context: ProviderFactoryContext): MarketplaceConnection {
        validateSyntheticSettings(context.settings);
        const fulfillment: FulfillmentMutator | undefined =
          controls.mutable === true
            ? {
                addTracking(input): Promise<MutationResult> {
                  observation.trackingCommands.push(input.trackingNumber);
                  return Promise.resolve({
                    ref: input.ref,
                    outcome: "applied",
                  });
                },
                markShipped(input): Promise<MutationResult> {
                  observation.shippedRemoteIds.push(input.ref.remoteId);
                  return Promise.resolve({
                    ref: input.ref,
                    outcome: "applied",
                  });
                },
              }
            : undefined;
        return {
          descriptor: {
            connectionId: context.connectionId,
            providerId,
            providerLabel,
            connectionLabel: context.connectionLabel,
          },
          health: {
            checkHealth(): Promise<ConnectionHealth> {
              observation.healthChecks += 1;
              if (controls.failHealth === true) {
                return Promise.reject(
                  new Error("synthetic private health detail"),
                );
              }
              return Promise.resolve(controls.health ?? { state: "connected" });
            },
          },
          facets: {
            orderPages: {
              readOrderPage(query): Promise<OrderPage> {
                observation.orderQueries.push(query);
                if (controls.readOrderPage !== undefined) {
                  return controls.readOrderPage(query);
                }
                if (
                  controls.failOrders === true ||
                  controls.orderFailure?.enabled === true
                ) {
                  return Promise.reject(
                    new Error("synthetic private order detail"),
                  );
                }
                return Promise.resolve(
                  controls.pages?.[query.cursor ?? "first"] ?? { orders: [] },
                );
              },
            },
            orderDetails: {
              getOrder(ref): Promise<OrderDetail> {
                observation.detailRemoteIds.push(ref.remoteId);
                if (controls.detail !== undefined) {
                  return Promise.resolve({ ...controls.detail, ref });
                }
                return Promise.reject(new Error("unused synthetic detail"));
              },
            },
            ...(fulfillment === undefined ? {} : { fulfillment }),
            ...(nativeDocument === undefined
              ? {}
              : {
                  nativeDocuments: {
                    getDocument(input): Promise<NativeDocumentResult> {
                      observation.nativeDocumentRemoteIds.push(
                        input.ref.remoteId,
                      );
                      return nativeDocument instanceof Error
                        ? Promise.reject(nativeDocument)
                        : Promise.resolve(nativeDocument);
                    },
                  },
                }),
            ...(pullLines === undefined
              ? {}
              : {
                  pullLines: {
                    getPullLines(refs): Promise<readonly PullLine[]> {
                      observation.pullLineRemoteIds.push(
                        refs.map((ref) => ref.remoteId),
                      );
                      return pullLines instanceof Error
                        ? Promise.reject(pullLines)
                        : Promise.resolve(pullLines);
                    },
                  },
                }),
            ...(catalogMetadata === undefined
              ? {}
              : {
                  catalogMetadata: {
                    readCatalogMetadata(
                      identities: readonly CatalogIdentity[],
                    ): Promise<
                      Readonly<
                        Record<
                          string,
                          Readonly<Record<string, readonly string[]>>
                        >
                      >
                    > {
                      observation.catalogIdentityReads.push([...identities]);
                      return catalogMetadata instanceof Error
                        ? Promise.reject(catalogMetadata)
                        : Promise.resolve(catalogMetadata);
                    },
                  },
                }),
            ...(controls.catalogSearch === true
              ? { catalogSearch: { kind: "catalog-search" as const } }
              : {}),
            ...(inventoryPages === undefined &&
            controls.readInventoryPage === undefined
              ? {}
              : {
                  inventoryReader: {
                    readInventoryPage(
                      query: InventoryPageQuery,
                    ): Promise<InventoryPage> {
                      observation.inventoryQueries.push(query);
                      if (controls.readInventoryPage !== undefined) {
                        return controls.readInventoryPage(query);
                      }
                      return Promise.resolve(
                        inventoryPages?.[query.cursor ?? "first"] ?? {
                          items: [],
                        },
                      );
                    },
                  },
                }),
            ...(controls.inventoryMutation === undefined
              ? {}
              : {
                  inventoryMutator: {
                    updateInventory(
                      input: InventoryMutationCommand,
                    ): Promise<
                      "applied" | "already-applied" | "review-required"
                    > {
                      observation.inventoryMutations.push(input);
                      return Promise.resolve(
                        controls.inventoryMutation ?? "review-required",
                      );
                    },
                  },
                }),
          },
        };
      },
    },
  };
}

export function syntheticNormalizedOrder(input: {
  readonly connectionId: string;
  readonly remoteId: string;
  readonly displayOrderNumber?: string;
  readonly createdAt?: string;
}): OrderSummary {
  return {
    ref: { connectionId: input.connectionId, remoteId: input.remoteId },
    displayOrderNumber: input.displayOrderNumber ?? input.remoteId,
    providerStatus: "Synthetic ready",
    providerStatusCode: "READY",
    lifecycle: "ready-to-ship",
    createdAt: input.createdAt ?? "2026-08-24T12:00:00.000Z",
    shippingMethod: "Synthetic shipping",
    totals: {
      subtotal: { currency: "USD", minorUnits: 100 },
      shipping: { currency: "USD", minorUnits: 0 },
      total: { currency: "USD", minorUnits: 100 },
    },
    actions: {
      "view-detail": { state: "available" },
      "print-address-label": { state: "available" },
      "packing-slip": { state: "available" },
      "pirate-ship": { state: "available" },
      "add-tracking": { state: "unavailable", reason: "provider-unsupported" },
      "mark-shipped": { state: "unavailable", reason: "provider-unsupported" },
      refund: { state: "unavailable", reason: "provider-unsupported" },
    },
  };
}

function validateSyntheticSettings(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "fixture")
  ) {
    throw new Error("Invalid synthetic settings.");
  }
}
