import { describe, expect, it } from "vitest";
import { ConnectionHealthService } from "../src/marketplaces/health.js";
import { MarketplaceValidationError } from "../src/marketplaces/identity.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
} from "../src/marketplaces/registry.js";
import { syntheticFactory } from "./synthetic-marketplace.js";

describe("marketplace registries and health", () => {
  it("adds a third provider through factory registration and configuration only", () => {
    const third = syntheticFactory("third-marketplace", "Third Marketplace", {
      mutable: true,
    });
    const adapters = new ProviderAdapterRegistry([third.factory]);
    const connections = new MarketplaceConnectionRegistry({
      adapters,
      connections: {
        "third-main": {
          providerId: "third-marketplace",
          enabled: true,
          label: "Third store",
          settings: { fixture: "read-write" },
        },
        "third-disabled": {
          providerId: "third-marketplace",
          enabled: false,
          label: "Archived third store",
          settings: {},
        },
      },
      secrets: environmentSecretAccess({ SYNTHETIC_SECRET: "not-exposed" }),
    });

    expect(connections.list()).toHaveLength(1);
    expect(connections.require("third-main").descriptor).toMatchObject({
      providerId: "third-marketplace",
      connectionLabel: "Third store",
    });
    expect(connections.facet("third-main", "fulfillment")).toBeDefined();
    expect(connections.statusDescriptors()).toHaveLength(2);
    expect(connections.statusDescriptors()[0]).toMatchObject({
      enabled: false,
    });
    expect(() => connections.require("third-disabled")).toThrow(
      MarketplaceValidationError,
    );
  });

  it("rejects duplicate factories and enabled unknown adapters", () => {
    const first = syntheticFactory("duplicate-provider", "First");
    const second = syntheticFactory("duplicate-provider", "Second");
    expect(
      () => new ProviderAdapterRegistry([first.factory, second.factory]),
    ).toThrow(MarketplaceValidationError);
    expect(
      () =>
        new MarketplaceConnectionRegistry({
          adapters: new ProviderAdapterRegistry([]),
          connections: {
            "unknown-main": {
              providerId: "unknown-provider",
              enabled: true,
              label: "Unknown",
              settings: {},
            },
          },
          secrets: environmentSecretAccess({}),
        }),
    ).toThrow(MarketplaceValidationError);
  });

  it("caches read-only health checks for thirty seconds and supports refresh", async () => {
    let milliseconds = Date.parse("2026-08-24T12:00:00.000Z");
    const now = () => new Date(milliseconds);
    const synthetic = syntheticFactory("health-provider", "Health Provider");
    const registry = registryFor(synthetic.factory, now);
    const health = new ConnectionHealthService(registry, { now });

    const [first, coalesced] = await Promise.all([
      health.check("health-main"),
      health.check("health-main"),
    ]);
    milliseconds += 29_999;
    const cached = await health.check("health-main");
    const refreshed = await health.check("health-main", { force: true });

    expect(first.state).toBe("connected");
    expect(coalesced).toEqual(first);
    expect(cached).toEqual(first);
    expect(refreshed.checkedAt).toBe("2026-08-24T12:00:29.999Z");
    expect(synthetic.observation.healthChecks).toBe(2);
  });

  it("sanitizes failed health probes and projects disabled health", async () => {
    const synthetic = syntheticFactory("health-provider", "Health Provider", {
      failHealth: true,
    });
    const adapters = new ProviderAdapterRegistry([synthetic.factory]);
    const registry = new MarketplaceConnectionRegistry({
      adapters,
      connections: {
        "health-main": {
          providerId: "health-provider",
          enabled: true,
          label: "Health store",
          settings: {},
        },
        "health-disabled": {
          providerId: "health-provider",
          enabled: false,
          label: "Disabled health store",
          settings: {},
        },
      },
      secrets: environmentSecretAccess({}),
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    const health = new ConnectionHealthService(registry, {
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });

    const statuses = await health.statuses();

    expect(statuses.map((status) => status.health.state).sort()).toEqual([
      "disabled",
      "unavailable",
    ]);
    expect(JSON.stringify(statuses)).not.toContain("private health detail");
  });
});

function registryFor(
  factory: ReturnType<typeof syntheticFactory>["factory"],
  now: () => Date,
): MarketplaceConnectionRegistry {
  return new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([factory]),
    connections: {
      "health-main": {
        providerId: factory.providerId,
        enabled: true,
        label: "Health store",
        settings: {},
      },
    },
    secrets: environmentSecretAccess({}),
    now,
  });
}
