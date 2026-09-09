import { describe, expect, it } from "vitest";
import {
  AggregateOrderQueryError,
  ConnectionHealthService,
  MarketplaceConnectionRegistry,
  MarketplaceReadyOrderSource,
  OrderQueryService,
  ProviderAdapterRegistry,
  environmentSecretAccess,
} from "../src/index.js";
import {
  syntheticFactory,
  syntheticNormalizedOrder,
} from "./synthetic-marketplace.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");

describe("MarketplaceReadyOrderSource", () => {
  it("bounds independent connection synchronization by configured concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: (() => void)[] = [];
    const connections = ["one-main", "two-main", "three-main"];
    const factories = connections.map((connectionId) =>
      syntheticFactory(
        connectionId.replace("-main", "-provider"),
        connectionId,
        {
          readOrderPage: async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
            return { orders: [] };
          },
        },
      ),
    );
    const source = sourceFor(factories, connections, 2);

    const refresh = source.refresh();
    await waitUntil(() => releases.length === 2);
    expect(maximumActive).toBe(2);
    releases.splice(0).forEach((release) => release());
    await waitUntil(() => releases.length === 1);
    releases.splice(0).forEach((release) => release());

    await expect(refresh).resolves.toMatchObject({
      successfulConnectionIds: ["one-main", "three-main", "two-main"],
      issues: [],
    });
    expect(maximumActive).toBe(2);
  });

  it("preserves the last complete snapshot when every connection later fails", async () => {
    const failure = { enabled: false };
    const connectionId = "only-main";
    const factory = syntheticFactory("only-provider", "Only", {
      orderFailure: failure,
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId,
              remoteId: "ORDER-1",
            }),
          ],
        },
      },
    });
    const source = sourceFor([factory], [connectionId], 1);
    const complete = await source.refresh();
    failure.enabled = true;

    await expect(source.refresh()).rejects.toBeInstanceOf(
      AggregateOrderQueryError,
    );
    expect(source.snapshot()).toEqual(complete);
  });
});

function sourceFor(
  factories: readonly ReturnType<typeof syntheticFactory>[],
  connectionIds: readonly string[],
  concurrency: number,
): MarketplaceReadyOrderSource {
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry(
      factories.map((entry) => entry.factory),
    ),
    connections: Object.fromEntries(
      connectionIds.map((connectionId, index) => [
        connectionId,
        {
          providerId: factories[index]?.factory.providerId ?? "missing",
          enabled: true,
          label: connectionId,
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
  return new MarketplaceReadyOrderSource({
    registry,
    orders,
    concurrency: () => concurrency,
    now: () => NOW,
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for source.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
