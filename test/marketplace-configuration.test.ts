import { describe, expect, it } from "vitest";
import {
  migrateMarketplaceConfigurationDocument,
  parseMarketplaceConfiguration,
} from "../src/marketplaces/configuration.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
} from "../src/marketplaces/registry.js";
import { syntheticFactory } from "./synthetic-marketplace.js";

const providerLabel = (providerId: string) =>
  providerId === "tcgplayer" ? "TCGplayer" : "Synthetic provider";

describe("marketplace configuration v6", () => {
  it("purely migrates the v5 singular provider to its default qualified connection", () => {
    const source = {
      version: 5,
      unrelated: { retained: true },
      provider: {
        type: "tcgplayer",
        authCookieEnv: "TCGPLAYER_AUTH_COOKIE",
        sellerKeyEnv: "TCGPLAYER_SELLER_KEY",
        pageSize: 100,
        maximumPages: 100,
      },
    };
    const before = structuredClone(source);

    const parsed = parseMarketplaceConfiguration(source, { providerLabel });
    const document = migrateMarketplaceConfigurationDocument(source, {
      providerLabel,
    });

    expect(source).toEqual(before);
    expect(parsed).toMatchObject({
      version: 6,
      migratedFromVersion: 5,
      providers: {
        synchronizationConcurrency: 2,
        connections: {
          "tcgplayer-main": {
            providerId: "tcgplayer",
            enabled: true,
            label: "TCGplayer",
            settings: {
              authCookieEnv: "TCGPLAYER_AUTH_COOKIE",
              sellerKeyEnv: "TCGPLAYER_SELLER_KEY",
              pageSize: 100,
              maximumPages: 100,
            },
          },
        },
      },
    });
    expect(document).toMatchObject({
      version: 6,
      unrelated: { retained: true },
      providers: parsed.providers,
    });
    expect(document).not.toHaveProperty("provider");
  });

  it("instantiates a third provider from v6 registration and configuration", () => {
    const parsed = parseMarketplaceConfiguration(
      {
        version: 6,
        providers: {
          synchronizationConcurrency: 3,
          connections: {
            "third-main": {
              providerId: "third-marketplace",
              enabled: true,
              label: "Third store",
              settings: { fixture: "read-only" },
            },
          },
        },
      },
      { providerLabel },
    );
    const third = syntheticFactory("third-marketplace", "Third Marketplace");

    const registry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([third.factory]),
      connections: parsed.providers.connections,
      secrets: environmentSecretAccess({}),
    });

    expect(parsed.providers.synchronizationConcurrency).toBe(3);
    expect(registry.require("third-main").descriptor.providerId).toBe(
      "third-marketplace",
    );
  });

  it.each([
    {
      providers: { synchronizationConcurrency: 0, connections: {} },
    },
    {
      providers: {
        synchronizationConcurrency: 2,
        connections: {
          "invalid-main": {
            providerId: "invalid-provider",
            enabled: true,
            label: "Invalid",
            settings: {},
            surprise: true,
          },
        },
      },
    },
  ])("rejects malformed v6 configuration", (value) => {
    expect(() =>
      parseMarketplaceConfiguration(
        { version: 6, ...value },
        { providerLabel },
      ),
    ).toThrow();
  });
});
