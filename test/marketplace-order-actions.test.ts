import { describe, expect, it, vi } from "vitest";
import { ConnectionHealthService } from "../src/marketplaces/health.js";
import {
  MarketplaceOrderActionService,
  resolveOrderActions,
} from "../src/marketplaces/order-actions.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
} from "../src/marketplaces/registry.js";
import { syntheticFactory } from "./synthetic-marketplace.js";

describe("provider-neutral order actions", () => {
  it("separates static support, order state, provider allowance, and missing data", () => {
    const actions = resolveOrderActions({
      lifecycle: "shipped",
      hasShippingAddress: false,
      supported: {
        "view-detail": true,
        "print-address-label": true,
        "packing-slip": false,
        "pirate-ship": true,
        "add-tracking": true,
        "mark-shipped": true,
        refund: true,
      },
      providerAllowed: new Set(["refund"]),
    });

    expect(actions["view-detail"]).toEqual({ state: "available" });
    expect(actions["packing-slip"]).toEqual({
      state: "unavailable",
      reason: "provider-unsupported",
    });
    expect(actions["print-address-label"]).toEqual({
      state: "unavailable",
      reason: "missing-data",
    });
    expect(actions["mark-shipped"]).toEqual({
      state: "unavailable",
      reason: "order-state",
    });
    expect(actions.refund).toEqual({ state: "available" });
  });

  it("routes mutations by qualified connection and invalidates only that order cache", async () => {
    const first = syntheticFactory("first-provider", "First", {
      mutable: true,
    });
    const second = syntheticFactory("second-provider", "Second", {
      mutable: true,
    });
    const registry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([first.factory, second.factory]),
      connections: {
        "first-main": {
          providerId: "first-provider",
          enabled: true,
          label: "First store",
          settings: { fixture: "mutable" },
        },
        "second-main": {
          providerId: "second-provider",
          enabled: true,
          label: "Second store",
          settings: { fixture: "mutable" },
        },
      },
      secrets: environmentSecretAccess({}),
    });
    const invalidate = vi.fn();
    const actions = new MarketplaceOrderActionService({
      registry,
      health: new ConnectionHealthService(registry),
      queries: { invalidate },
    });
    const ref = { connectionId: "second-main", remoteId: "shared-label" };

    await expect(
      actions.addTracking({ ref, trackingNumber: "synthetic-tracking" }),
    ).resolves.toEqual({ ref, outcome: "applied" });
    await expect(actions.markShipped({ ref })).resolves.toEqual({
      ref,
      outcome: "applied",
    });

    expect(first.observation.trackingCommands).toEqual([]);
    expect(second.observation.trackingCommands).toEqual(["synthetic-tracking"]);
    expect(second.observation.shippedRemoteIds).toEqual(["shared-label"]);
    expect(invalidate).toHaveBeenNthCalledWith(1, "second-main");
    expect(invalidate).toHaveBeenNthCalledWith(2, "second-main");
  });

  it("does not call mutation facets on an unhealthy connection", async () => {
    const synthetic = syntheticFactory("offline-provider", "Offline", {
      mutable: true,
      health: {
        state: "authentication-required",
        issueCode: "AUTHENTICATION_REQUIRED",
        retryable: false,
      },
    });
    const registry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([synthetic.factory]),
      connections: {
        "offline-main": {
          providerId: "offline-provider",
          enabled: true,
          label: "Offline store",
          settings: { fixture: "offline" },
        },
      },
      secrets: environmentSecretAccess({}),
    });
    const actions = new MarketplaceOrderActionService({
      registry,
      health: new ConnectionHealthService(registry),
    });

    await expect(
      actions.markShipped({
        ref: { connectionId: "offline-main", remoteId: "synthetic-order" },
      }),
    ).rejects.toThrow("unavailable for mutations");
    expect(synthetic.observation.shippedRemoteIds).toEqual([]);
  });
});
