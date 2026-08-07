import { describe, expect, it } from "vitest";
import {
  effectiveMinimumPrice,
  parseGamePricingModules,
  type GamePricingModuleConfig,
} from "../src/game-pricing.js";

const magicFloors: readonly GamePricingModuleConfig[] = [
  {
    type: "magic-rarity-floor",
    enabled: true,
    floors: [
      { rarity: "Common", minimumPrice: 0.25 },
      { rarity: "Rare", minimumPrice: 0.75 },
    ],
  },
];

describe("game pricing modules", () => {
  it("raises the general floor for a matching Magic rarity", () => {
    expect(
      effectiveMinimumPrice(
        0.35,
        {
          productLineName: "Magic: The Gathering",
          rarityName: "rare",
        },
        magicFloors,
      ),
    ).toEqual({
      minimumPrice: 0.75,
      source: {
        moduleType: "magic-rarity-floor",
        label: "Magic Rare",
      },
    });
  });

  it("never lowers the general floor and ignores other games", () => {
    expect(
      effectiveMinimumPrice(
        0.35,
        {
          productLineName: "Magic: The Gathering",
          rarityName: "Common",
        },
        magicFloors,
      ),
    ).toEqual({ minimumPrice: 0.35 });
    expect(
      effectiveMinimumPrice(
        0.35,
        { productLineName: "Synthetic Game", rarityName: "Rare" },
        magicFloors,
      ),
    ).toEqual({ minimumPrice: 0.35 });
  });

  it("validates module types, prices, and case-insensitive rarity uniqueness", () => {
    const issues: string[] = [];

    parseGamePricingModules(
      [
        {
          type: "magic-rarity-floor",
          enabled: true,
          floors: [
            { rarity: "Rare", minimumPrice: 0 },
            { rarity: " rare ", minimumPrice: 0.5 },
          ],
        },
      ],
      "profile.gamePricingModules",
      issues,
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("minimumPrice"),
        expect.stringContaining("unique rarity names"),
      ]),
    );
  });
});
