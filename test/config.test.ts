import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConfigurationError, parseConfig } from "../src/index.js";

describe("application configuration", () => {
  it("validates the committed example with every side effect disabled", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as unknown;

    const config = parseConfig(value);

    expect(config.version).toBe(1);
    expect(config.pricingProfileDefaultsVersion).toBe(1);
    expect(config.confirmBeforeMarkingShipped).toBe(true);
    expect(config.priceUpdateQueue.delaySeconds).toBe(1);
    expect(config.inventoryAdditionQueue).toMatchObject({
      enabled: false,
      delaySeconds: 0,
    });
    expect(config.defaultMerchandiseProfileId).toBe("english-singles");
    expect(config.merchandiseProfiles).toEqual([
      expect.objectContaining({
        name: "English singles",
        language: "English",
        defaultCondition: "Near Mint",
        defaultPrinting: "Normal",
        pricingProfileId: "match-lowest",
      }),
    ]);
    expect(config.defaultRepricingProfileId).toBe("match-lowest");
    expect(config.repricingProfiles[0]).toMatchObject({
      name: "Smart conservative",
      sparseMarketFallback: "higher-of-market-and-lowest",
      gamePricingModules: [],
      ranges: [
        {
          maximumPrice: 1,
          minimumListings: 2,
          gapAction: "use-next",
          supportMode: "cluster",
          minimumSellerSupport: 2,
        },
        {
          maximumPrice: 5,
          minimumListings: 2,
          gapThresholdPercent: 3,
          gapAction: "use-next",
          supportMode: "cluster",
          minimumSellerSupport: 2,
        },
        {
          maximumPrice: 25,
          minimumListings: 2,
          gapThresholdPercent: 3,
          gapAction: "use-next",
          supportMode: "cluster",
          minimumSellerSupport: 2,
        },
        {
          maximumPrice: 100,
          minimumListings: 3,
          gapThresholdPercent: 3,
          gapAction: "skip",
          supportMode: "cluster",
          minimumSellerSupport: 2,
        },
        {
          minimumListings: 3,
          gapThresholdPercent: 3,
          gapAction: "skip",
          supportMode: "cluster",
          minimumSellerSupport: 2,
        },
      ],
    });
    expect(config.repricingProfiles[1]).toMatchObject({
      id: "sell-now",
      name: "Sell now",
      adjustmentCents: 1,
      allowPriceIncreases: true,
      sparseMarketFallback: "lowest-then-market",
      gamePricingModules: [],
      ranges: [
        {
          minimumListings: 0,
          priceSource: "lowest",
          gapAction: "follow-lowest",
          minimumSellerSupport: 1,
        },
      ],
    });
    expect(config.rules).toHaveLength(1);
    expect(config.actions["print-address-label"]).toMatchObject({
      enabled: false,
      omitLineValues: ["US", "USA"],
      page: { fontSize: 14 },
    });
  });

  it("keeps shipment confirmation enabled for older configuration files", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as Record<string, unknown>;
    delete value.confirmBeforeMarkingShipped;

    expect(parseConfig(value).confirmBeforeMarkingShipped).toBe(true);
  });

  it("migrates an older version-one config with inventory-addition defaults", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as Record<string, unknown>;
    delete value.inventoryAdditionQueue;
    delete value.merchandiseProfiles;
    delete value.defaultMerchandiseProfileId;
    delete value.repricingProfiles;
    delete value.defaultRepricingProfileId;

    expect(parseConfig(value).inventoryAdditionQueue).toEqual({
      enabled: true,
      stateFile: ".data/inventory-additions.json",
      delaySeconds: 0,
      rateLimitDelaySeconds: 300,
      historyLimit: 500,
    });
    expect(parseConfig(value).merchandiseProfiles).toEqual([
      {
        id: "english-singles",
        name: "English singles",
        language: "English",
        estimatedShippingPrice: 0,
        defaultCondition: "Near Mint",
        defaultPrinting: "Normal",
        pricingProfileId: "match-lowest",
      },
    ]);
    expect(parseConfig(value)).toMatchObject({
      pricingProfileDefaultsVersion: 1,
      repricingProfiles: [
        {
          id: "match-lowest",
          name: "Smart conservative",
          sparseMarketFallback: "higher-of-market-and-lowest",
        },
        {
          id: "sell-now",
          name: "Sell now",
          adjustmentCents: 1,
          allowPriceIncreases: true,
          sparseMarketFallback: "lowest-then-market",
          ranges: [
            {
              minimumListings: 0,
              priceSource: "lowest",
              gapAction: "follow-lowest",
              minimumSellerSupport: 1,
            },
          ],
        },
      ],
    });
  });

  it("preserves adjacent gap behavior for repricing profiles saved before seller bands", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      repricingProfiles: { ranges: Record<string, unknown>[] }[];
    };
    for (const range of value.repricingProfiles[0]?.ranges ?? []) {
      delete range.supportMode;
      delete range.minimumSellerSupport;
      delete range.supportWindowPercent;
    }

    const ranges = parseConfig(value).repricingProfiles[0]?.ranges;

    expect(ranges?.every((range) => range.supportMode === "adjacent")).toBe(
      true,
    );
    expect(ranges?.every((range) => range.minimumSellerSupport === 2)).toBe(
      true,
    );
    expect(ranges?.every((range) => range.supportWindowPercent === 5)).toBe(
      true,
    );
  });

  it("loads Magic rarity floors and defaults older profiles to no game modules", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      repricingProfiles: { gamePricingModules?: unknown }[];
    };
    const firstProfile = value.repricingProfiles[0];
    const secondProfile = value.repricingProfiles[1];
    if (firstProfile === undefined || secondProfile === undefined) {
      throw new Error("Missing pricing profile fixtures");
    }
    firstProfile.gamePricingModules = [
      {
        type: "magic-rarity-floor",
        enabled: true,
        floors: [
          { rarity: "Common", minimumPrice: 0.4 },
          { rarity: "Rare", minimumPrice: 0.75 },
        ],
      },
    ];
    delete secondProfile.gamePricingModules;

    const profiles = parseConfig(value).repricingProfiles;

    expect(profiles[0]?.gamePricingModules).toEqual([
      {
        type: "magic-rarity-floor",
        enabled: true,
        floors: [
          { rarity: "Common", minimumPrice: 0.4 },
          { rarity: "Rare", minimumPrice: 0.75 },
        ],
      },
    ]);
    expect(profiles[1]?.gamePricingModules).toEqual([]);
  });

  it("rejects duplicate or invalid Magic rarity floors", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      repricingProfiles: { gamePricingModules: unknown }[];
    };
    const firstProfile = value.repricingProfiles[0];
    if (firstProfile === undefined) {
      throw new Error("Missing pricing profile fixture");
    }
    firstProfile.gamePricingModules = [
      {
        type: "magic-rarity-floor",
        enabled: true,
        floors: [
          { rarity: "Rare", minimumPrice: 0 },
          { rarity: " rare ", minimumPrice: 0.75 },
        ],
      },
    ];

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });

  it("seeds Sell now once and preserves its later deletion", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      pricingProfileDefaultsVersion?: number;
      repricingProfiles: { id: string }[];
    };
    value.repricingProfiles = value.repricingProfiles.filter(
      (profile) => profile.id !== "sell-now",
    );
    delete value.pricingProfileDefaultsVersion;

    const migrated = parseConfig(value);
    const deleted = parseConfig({
      ...migrated,
      repricingProfiles: migrated.repricingProfiles.filter(
        (profile) => profile.id !== "sell-now",
      ),
    });

    expect(migrated.repricingProfiles.map((profile) => profile.id)).toContain(
      "sell-now",
    );
    expect(deleted.pricingProfileDefaultsVersion).toBe(1);
    expect(
      deleted.repricingProfiles.map((profile) => profile.id),
    ).not.toContain("sell-now");
  });

  it("migrates legacy merchandise pricing fields to a pricing-profile reference", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      merchandiseProfiles: Record<string, unknown>[];
    };
    const profile = value.merchandiseProfiles[0];
    if (profile === undefined) throw new Error("Missing merchandise profile");
    delete profile.defaultCondition;
    delete profile.defaultPrinting;
    delete profile.pricingProfileId;
    Object.assign(profile, {
      minimumPrice: 0.5,
      conditionPolicy: "same",
      priceBasis: "item",
      adjustmentCents: 5,
      noComparisonFallback: "market",
    });

    expect(parseConfig(value).merchandiseProfiles[0]).toMatchObject({
      language: "English",
      estimatedShippingPrice: 0,
      defaultCondition: "Near Mint",
      defaultPrinting: "Normal",
      pricingProfileId: "match-lowest",
    });
  });

  it("rejects invalid merchandise profiles and default references", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      defaultMerchandiseProfileId: string;
      merchandiseProfiles: { id: string }[];
    };
    value.merchandiseProfiles.push({
      ...value.merchandiseProfiles[0],
    } as { id: string });
    value.defaultMerchandiseProfileId = "missing-profile";

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });

  it("rejects a merchandise profile with a missing pricing profile", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      merchandiseProfiles: { pricingProfileId: string }[];
    };
    const profile = value.merchandiseProfiles[0];
    if (profile === undefined) throw new Error("Missing merchandise profile");
    profile.pricingProfileId = "missing-pricing-profile";

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });

  it("rejects unordered repricing ranges and invalid defaults", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      defaultRepricingProfileId: string;
      repricingProfiles: { ranges: Record<string, unknown>[] }[];
    };
    const profile = value.repricingProfiles[0];
    const source = profile?.ranges[0];
    if (profile === undefined || source === undefined)
      throw new Error("Missing repricing range fixture");
    profile.ranges = [
      { ...source, maximumPrice: 10 },
      { ...source, maximumPrice: 5 },
      { ...source },
    ];
    value.defaultRepricingProfileId = "missing-profile";

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });

  it("rejects an unsupported sparse-market fallback", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      repricingProfiles: { sparseMarketFallback: string }[];
    };
    const profile = value.repricingProfiles[0];
    if (profile === undefined) throw new Error("Missing pricing profile");
    profile.sparseMarketFallback = "guess";

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });

  it("reports multiple actionable configuration issues together", () => {
    expect(() =>
      parseConfig({
        version: 2,
        pollIntervalMinutes: 0,
        actionMaximumAttempts: 0,
        provider: {},
        printers: {},
        actions: {},
        rules: [],
      }),
    ).toThrow(ConfigurationError);

    try {
      parseConfig({ version: 2, printers: {}, actions: {}, rules: [] });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.length).toBeGreaterThan(3);
    }
  });

  it("rejects enabled printing while placeholder printers remain", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as Record<string, unknown>;
    const actions = value.actions as Record<string, { enabled: boolean }>;
    const address = actions["print-address-label"];
    if (address === undefined) throw new Error("Missing example action");
    address.enabled = true;

    expect(() => parseConfig(value)).toThrow(/Configuration is invalid/u);
  });

  it("allows disabled outputs to retain placeholder printers", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      actions: Record<string, { enabled: boolean }>;
    };
    for (const action of Object.values(value.actions)) action.enabled = false;

    expect(parseConfig(value).actions["print-address-label"]?.enabled).toBe(
      false,
    );
  });

  it("migrates a legacy dryRun configuration to disabled side effects", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      dryRun?: boolean;
      priceUpdateQueue: { enabled: boolean };
      inventoryAdditionQueue: { enabled: boolean };
      actions: Record<string, { enabled: boolean }>;
    };
    value.priceUpdateQueue.enabled = true;
    value.inventoryAdditionQueue.enabled = true;
    for (const action of Object.values(value.actions)) action.enabled = true;
    value.dryRun = true;

    const config = parseConfig(value);

    expect("dryRun" in config).toBe(false);
    expect(config.priceUpdateQueue.enabled).toBe(false);
    expect(config.inventoryAdditionQueue.enabled).toBe(false);
    expect(
      Object.values(config.actions).every((action) => !action.enabled),
    ).toBe(true);
  });

  it("rejects unknown label and command placeholders", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      printers: Record<
        string,
        { adapter: string; executable?: string; arguments?: string[] }
      >;
      actions: Record<string, { lines?: string[] }>;
    };
    const printer = value.printers["address-label-printer"];
    const action = value.actions["print-address-label"];
    if (printer === undefined || action === undefined) {
      throw new Error("Synthetic configuration fixture is incomplete.");
    }
    printer.adapter = "command";
    printer.executable = "synthetic-print-command";
    printer.arguments = ["{file}", "{unknown}"];
    action.lines = ["{secretField}"];

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });

  it("rejects a packing slip routed to the native-label adapter", async () => {
    const value = JSON.parse(
      await readFile("config/local.example.json", "utf8"),
    ) as {
      actions: Record<string, { printer: string }>;
    };
    const packingSlip = value.actions["print-packing-slip"];
    if (packingSlip === undefined) {
      throw new Error("Synthetic configuration fixture is incomplete.");
    }
    packingSlip.printer = "address-label-printer";

    expect(() => parseConfig(value)).toThrow(ConfigurationError);
  });
});
