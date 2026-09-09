import { describe, expect, it } from "vitest";
import { MasterPullListService } from "../src/fulfillment/pull-list.js";
import {
  emptyQualifiedPullListProgressState,
  type QualifiedPullListProgressState,
  type QualifiedPullListProgressStore,
} from "../src/fulfillment/pull-list-progress.js";
import { ConnectionHealthService } from "../src/marketplaces/health.js";
import { OrderQueryService } from "../src/marketplaces/order-query.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
  type ProviderAdapterFactory,
} from "../src/marketplaces/registry.js";
import {
  DEFAULT_PULL_LIST_BINNING_CONFIG,
  type PullListGroupingSettings,
} from "../src/pull-list-binning.js";
import { marketplaceOrderDetail } from "./marketplace-ui-fixtures.js";
import {
  syntheticFactory,
  syntheticNormalizedOrder,
} from "./synthetic-marketplace.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const GROUPING: PullListGroupingSettings = {
  groupLands: true,
  groupMulticolored: true,
  binning: { enabled: false, fallback: "", rules: [] },
};

class MemoryProgressStore implements QualifiedPullListProgressStore {
  state: QualifiedPullListProgressState = emptyQualifiedPullListProgressState();

  load(): Promise<QualifiedPullListProgressState> {
    return Promise.resolve(structuredClone(this.state));
  }

  save(state: QualifiedPullListProgressState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

describe("provider-neutral master pull list", () => {
  it("combines native and detail-derived allocations by shared exact identity", async () => {
    const firstRef = { connectionId: "first-main", remoteId: "ORDER-1" };
    const secondRef = { connectionId: "second-main", remoteId: "ORDER-2" };
    const exact = {
      namespace: "shared.variant",
      value: "CARD-1-NM-NONFOIL",
      precision: "exact-variant" as const,
    };
    const native = syntheticFactory("first-provider", "First", {
      pages: {
        first: {
          orders: [syntheticNormalizedOrder(firstRef)],
        },
      },
      pullLines: [
        {
          description: "Shared café card",
          quantity: 2,
          attributes: {
            productLine: "Magic: The Gathering",
            condition: "Near Mint",
          },
          catalogIdentities: [
            exact,
            {
              namespace: "tcgplayer.product",
              value: "123",
              precision: "product",
            },
          ],
          allocations: [{ order: firstRef, lineKey: "line-a", quantity: 2 }],
        },
      ],
      catalogMetadata: {
        "tcgplayer.product:123": {
          color: ["Blue"],
          cardType: ["Creature"],
        },
      },
    });
    const fallback = syntheticFactory("second-provider", "Second", {
      pages: {
        first: {
          orders: [syntheticNormalizedOrder(secondRef)],
        },
      },
      detail: detail(secondRef, "line-b", 1, [exact], {
        productLine: "Magic: The Gathering",
        condition: "Near Mint",
      }),
    });
    const fixture = service([native.factory, fallback.factory]);

    const list = await fixture.pullList.getMasterPullList();

    expect(list).toMatchObject({
      orderCount: 2,
      totalQuantity: 3,
      remainingQuantity: 3,
      issues: [],
    });
    expect(list.rows).toEqual([
      expect.objectContaining({
        rowKey: "shared.variant:CARD-1-NM-NONFOIL",
        productName: "Shared café card",
        orderQuantity: 3,
        metadata: [{ label: "Color", values: ["Blue"] }],
        canTrackPullProgress: true,
      }),
    ]);
    expect(native.observation.pullLineRemoteIds).toEqual([["ORDER-1"]]);
    expect(native.observation.detailRemoteIds).toEqual([]);
    expect(native.observation.catalogIdentityReads).toHaveLength(1);
    expect(fallback.observation.detailRemoteIds).toEqual(["ORDER-2"]);
  });

  it("uses any capable catalog connection to restore color and bin metadata", async () => {
    const manaRef = { connectionId: "mana-main", remoteId: "ORDER-1" };
    const catalog = syntheticFactory("tcg-provider", "TCG", {
      pages: { first: { orders: [] } },
      catalogMetadata: {
        "tcgplayer.product:456": {
          color: ["Blue"],
          cardType: ["Creature"],
        },
      },
    });
    const mana = syntheticFactory("mana-provider", "Mana", {
      pages: { first: { orders: [syntheticNormalizedOrder(manaRef)] } },
      pullLines: [
        {
          description: "Cross-provider card",
          quantity: 1,
          attributes: {
            productLine: "Magic: The Gathering",
            language: "en",
            condition: "near_mint",
            finish: "nonfoil",
          },
          catalogIdentities: [
            {
              namespace: "manapool.product",
              value: "mana-card",
              precision: "exact-variant",
            },
            {
              namespace: "tcgplayer.product",
              value: "456",
              precision: "product",
            },
          ],
          allocations: [{ order: manaRef, lineKey: "mana-line", quantity: 1 }],
        },
      ],
    });
    const grouping: PullListGroupingSettings = {
      groupLands: true,
      groupMulticolored: true,
      binning: DEFAULT_PULL_LIST_BINNING_CONFIG,
    };

    const list = await service(
      [catalog.factory, mana.factory],
      new MemoryProgressStore(),
      grouping,
    ).pullList.getMasterPullList();

    expect(list.rows).toEqual([
      expect.objectContaining({
        productLine: "Magic: The Gathering",
        metadata: [{ label: "Color", values: ["Blue"] }],
        bin: "MTG / Blue / Creature / No power",
      }),
    ]);
    expect(catalog.observation.catalogIdentityReads).toHaveLength(1);
  });

  it("combines providers by a shared product and normalized complete variant", async () => {
    const tcgRef = { connectionId: "tcg-main", remoteId: "ORDER-1" };
    const manaRef = { connectionId: "mana-main", remoteId: "ORDER-2" };
    const tcg = syntheticFactory("tcg-provider", "TCG", {
      pages: { first: { orders: [syntheticNormalizedOrder(tcgRef)] } },
      pullLines: [
        {
          description: "Synthetic Card",
          quantity: 1,
          attributes: {
            language: "English",
            condition: "Near Mint",
            printing: "Normal",
          },
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
          allocations: [{ order: tcgRef, lineKey: "tcg-line", quantity: 1 }],
        },
      ],
    });
    const mana = syntheticFactory("mana-provider", "Mana", {
      pages: { first: { orders: [syntheticNormalizedOrder(manaRef)] } },
      pullLines: [
        {
          description: "Synthetic Card",
          quantity: 1,
          attributes: {
            language: "en",
            condition: "near_mint",
            finish: "nonfoil",
          },
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
          allocations: [{ order: manaRef, lineKey: "mana-line", quantity: 1 }],
        },
      ],
    });

    const list = await service([
      tcg.factory,
      mana.factory,
    ]).pullList.getMasterPullList();

    expect(list).toMatchObject({ totalQuantity: 2, issues: [] });
    expect(list.rows).toEqual([
      expect.objectContaining({
        rowKey:
          "normalized.tcgplayer-variant.v1:%5B%22456%22%2C%22en%22%2C%22near-mint%22%2C%22nonfoil%22%5D",
        orderQuantity: 2,
      }),
    ]);
  });

  it("merges transitive exact identities but never product-only identities", async () => {
    const refs = [
      { connectionId: "bridge-main", remoteId: "ORDER-A" },
      { connectionId: "bridge-main", remoteId: "ORDER-B" },
      { connectionId: "bridge-main", remoteId: "ORDER-C" },
      { connectionId: "bridge-main", remoteId: "ORDER-D" },
      { connectionId: "bridge-main", remoteId: "ORDER-E" },
    ];
    const exactA = {
      namespace: "exact",
      value: "A",
      precision: "exact-variant" as const,
    };
    const exactB = {
      namespace: "exact",
      value: "B",
      precision: "exact-variant" as const,
    };
    const product = {
      namespace: "catalog.product",
      value: "SAME-PRODUCT",
      precision: "product" as const,
    };
    const provider = syntheticFactory("bridge-provider", "Bridge", {
      pages: {
        first: { orders: refs.map(syntheticNormalizedOrder) },
      },
      pullLines: [
        pullLine(refs[0], "a", [exactA]),
        pullLine(refs[1], "b", [exactA, exactB]),
        pullLine(refs[2], "c", [exactB]),
        pullLine(refs[3], "d", [product]),
        pullLine(refs[4], "e", [product]),
      ],
    });

    const list = await service([provider.factory]).pullList.getMasterPullList();

    expect(list.rows).toHaveLength(3);
    expect(list.rows.find((row) => row.rowKey === "exact:A")).toMatchObject({
      orderQuantity: 3,
    });
    expect(
      list.rows.filter((row) => row.rowKey.startsWith("allocation:")),
    ).toHaveLength(2);
  });

  it("isolates a conflicting exact component and keeps healthy provider data", async () => {
    const refs = [
      { connectionId: "conflict-main", remoteId: "ORDER-A" },
      { connectionId: "conflict-main", remoteId: "ORDER-B" },
      { connectionId: "conflict-main", remoteId: "ORDER-C" },
    ];
    const exact = {
      namespace: "exact",
      value: "VARIANT-1",
      precision: "exact-variant" as const,
    };
    const provider = syntheticFactory("conflict-provider", "Conflict", {
      pages: { first: { orders: refs.map(syntheticNormalizedOrder) } },
      pullLines: [
        pullLine(refs[0], "a", [exact], "Near Mint"),
        pullLine(refs[1], "b", [exact], "Lightly Played"),
        pullLine(refs[2], "c", [
          { namespace: "exact", value: "SAFE", precision: "exact-variant" },
        ]),
      ],
    });

    const list = await service([provider.factory]).pullList.getMasterPullList();

    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.rowKey).toBe("exact:SAFE");
    expect(list.issues).toContainEqual({
      connectionId: "conflict-main",
      operation: "pull-lines",
      code: "PULL_VARIANT_CONFLICT",
      retryable: false,
    });
  });

  it("returns partial issues when one connection's pull source fails", async () => {
    const failedRef = { connectionId: "failed-main", remoteId: "FAILED-1" };
    const healthyRef = { connectionId: "healthy-main", remoteId: "HEALTHY-1" };
    const failed = syntheticFactory("failed-provider", "Failed", {
      pages: { first: { orders: [syntheticNormalizedOrder(failedRef)] } },
      pullLines: new Error("private provider response"),
    });
    const healthy = syntheticFactory("healthy-provider", "Healthy", {
      pages: { first: { orders: [syntheticNormalizedOrder(healthyRef)] } },
      detail: detail(healthyRef, "line", 1, [], { condition: "Near Mint" }),
    });

    const list = await service([
      failed.factory,
      healthy.factory,
    ]).pullList.getMasterPullList();

    expect(list.rows).toHaveLength(1);
    expect(list.issues).toEqual([
      {
        connectionId: "failed-main",
        operation: "pull-lines",
        code: "PULL_LINE_READER_FAILED",
        retryable: true,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain("private provider response");
  });

  it("fails the aggregate instead of presenting an empty list when every pull source fails", async () => {
    const ref = { connectionId: "failed-main", remoteId: "FAILED-1" };
    const failed = syntheticFactory("failed-provider", "Failed", {
      pages: { first: { orders: [syntheticNormalizedOrder(ref)] } },
      pullLines: new Error("private provider response"),
    });

    await expect(
      service([failed.factory]).pullList.getMasterPullList(),
    ).rejects.toMatchObject({
      code: "ALL_PULL_CONNECTIONS_FAILED",
      issues: [
        {
          connectionId: "failed-main",
          operation: "pull-lines",
          code: "PULL_LINE_READER_FAILED",
        },
      ],
    });
  });

  it("classifies detail-fallback failures as get-order issues", async () => {
    const ref = { connectionId: "detail-main", remoteId: "FAILED-DETAIL" };
    const failed = syntheticFactory("detail-provider", "Detail", {
      pages: { first: { orders: [syntheticNormalizedOrder(ref)] } },
    });

    await expect(
      service([failed.factory]).pullList.getMasterPullList(),
    ).rejects.toMatchObject({
      issues: [
        {
          connectionId: "detail-main",
          operation: "get-order",
          code: "ORDER_DETAIL_PULL_FAILED",
        },
      ],
    });
  });

  it("keeps the operational list when optional catalog enrichment fails", async () => {
    const ref = { connectionId: "metadata-main", remoteId: "ORDER-1" };
    const provider = syntheticFactory("metadata-provider", "Metadata", {
      pages: { first: { orders: [syntheticNormalizedOrder(ref)] } },
      pullLines: [
        pullLine(ref, "line", [
          { namespace: "exact", value: "SAFE", precision: "exact-variant" },
          {
            namespace: "catalog.product",
            value: "PRODUCT-1",
            precision: "product",
          },
        ]),
      ],
      catalogMetadata: new Error("private catalog failure"),
    });

    const list = await service([provider.factory]).pullList.getMasterPullList();

    expect(list.rows).toHaveLength(1);
    expect(list.issues).toEqual([
      {
        connectionId: "metadata-main",
        operation: "pull-lines",
        code: "CATALOG_METADATA_FAILED",
        retryable: true,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain("private catalog failure");
  });

  it("restores qualified progress and removes only a shipped order allocation", async () => {
    const firstRef = { connectionId: "first-main", remoteId: "DUPLICATE" };
    const secondRef = { connectionId: "second-main", remoteId: "DUPLICATE" };
    const exact = {
      namespace: "exact",
      value: "SHARED",
      precision: "exact-variant" as const,
    };
    const first = syntheticFactory("first-provider", "First", {
      pages: { first: { orders: [syntheticNormalizedOrder(firstRef)] } },
      detail: detail(firstRef, "same-line", 2, [exact]),
    });
    const second = syntheticFactory("second-provider", "Second", {
      pages: { first: { orders: [syntheticNormalizedOrder(secondRef)] } },
      detail: detail(secondRef, "same-line", 1, [exact]),
    });
    const progress = new MemoryProgressStore();
    const firstRuntime = service([first.factory, second.factory], progress);
    const initial = await firstRuntime.pullList.getMasterPullList();

    await firstRuntime.pullList.setRowPulled(
      initial.rows[0]?.rowKey ?? "",
      true,
    );
    const restarted = service([first.factory, second.factory], progress);
    expect(
      (await restarted.pullList.getMasterPullList()).rows[0],
    ).toMatchObject({
      pulled: true,
      pulledQuantity: 3,
    });

    await restarted.pullList.removeOrder(firstRef);
    const remaining = await restarted.pullList.getMasterPullList();

    expect(remaining).toMatchObject({
      orderCount: 1,
      totalQuantity: 1,
      pulledQuantity: 1,
      remainingQuantity: 0,
    });
    expect(progress.state.allocations).toEqual([
      expect.objectContaining({
        connectionId: "second-main",
        remoteId: "DUPLICATE",
        lineKey: "same-line",
        quantity: 1,
      }),
    ]);
  });
});

function service(
  factories: readonly ProviderAdapterFactory[],
  progress = new MemoryProgressStore(),
  grouping: PullListGroupingSettings = GROUPING,
): {
  readonly pullList: MasterPullListService;
  readonly progress: MemoryProgressStore;
} {
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry(factories),
    connections: Object.fromEntries(
      factories.map((factory) => [
        `${factory.providerId.replace("-provider", "")}-main`,
        {
          providerId: factory.providerId,
          enabled: true,
          label: `${factory.providerLabel} store`,
          settings: {},
        },
      ]),
    ),
    secrets: environmentSecretAccess({}),
    now: () => NOW,
  });
  const orders = new OrderQueryService({
    registry,
    health: new ConnectionHealthService(registry, { now: () => NOW }),
    paging: () => ({ pageSize: 100, maximumPages: 10 }),
    now: () => NOW,
  });
  return {
    progress,
    pullList: new MasterPullListService({
      registry,
      orders,
      progress,
      grouping: () => Promise.resolve(grouping),
      now: () => NOW,
    }),
  };
}

function detail(
  ref: { readonly connectionId: string; readonly remoteId: string },
  lineKey: string,
  quantity: number,
  catalogIdentities: ReturnType<typeof pullLine>["catalogIdentities"],
  attributes: Readonly<Record<string, string>> = {},
) {
  const value = marketplaceOrderDetail({
    ...ref,
    quantity,
    description: "Shared café card",
  });
  const [line] = value.lines;
  if (line === undefined)
    throw new Error("The detail fixture requires a line.");
  return {
    ...value,
    lines: [{ ...line, lineKey, attributes, catalogIdentities }],
  };
}

function pullLine(
  ref: { readonly connectionId: string; readonly remoteId: string } | undefined,
  lineKey: string,
  catalogIdentities: readonly {
    readonly namespace: string;
    readonly value: string;
    readonly precision: "exact-variant" | "product";
  }[],
  condition = "Near Mint",
) {
  if (ref === undefined)
    throw new Error("The pull-line fixture ref is missing.");
  return {
    description: `Card ${lineKey}`,
    quantity: 1,
    attributes: { condition },
    catalogIdentities,
    allocations: [{ order: ref, lineKey, quantity: 1 }],
  };
}
