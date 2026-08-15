import { describe, expect, it } from "vitest";
import {
  DEFAULT_PULL_LIST_BINNING_CONFIG,
  parsePullListBinningConfig,
  pullListBin,
  pullListColorGroup,
  type PullListBinFacts,
  type PullListGroupingSettings,
} from "../src/pull-list-binning.js";

const magicFacts: PullListBinFacts = {
  productLine: "Magic: The Gathering",
  productName: "Synthetic Adept",
  setName: "Synthetic Set",
  number: "42",
  rarity: "Rare",
  condition: "Near Mint Foil",
  setReleaseDate: "2026-01-01",
  attributes: {
    color: ["Blue", "Red"],
    cardType: ["Creature"],
    fullType: ["Creature — Wizard"],
    convertedCost: ["3"],
    power: ["2"],
    toughness: ["4"],
  },
};

const defaultSettings: PullListGroupingSettings = {
  groupLands: true,
  groupMulticolored: true,
  binning: DEFAULT_PULL_LIST_BINNING_CONFIG,
};

describe("pull-list binning", () => {
  it("assigns an exact Magic product to the configured metadata hierarchy", () => {
    expect(pullListBin(magicFacts, defaultSettings)).toBe(
      "MTG / Multicolored / Creature / 2",
    );
  });

  it("uses real product-line-specific fields and per-level missing fallbacks", () => {
    const settings: PullListGroupingSettings = {
      ...defaultSettings,
      binning: {
        enabled: true,
        fallback: "Unsorted",
        rules: [
          {
            id: "pokemon",
            name: "Pokemon",
            enabled: true,
            productLine: "Pokemon",
            prefix: "PKM",
            dimensions: [
              { field: "energyType", fallback: "No energy" },
              { field: "stage", fallback: "No stage" },
              { field: "hp", fallback: "No HP" },
              { field: "customShelf", fallback: "Overflow" },
            ],
          },
        ],
      },
    };
    expect(
      pullListBin(
        {
          ...magicFacts,
          productLine: "Pokemon",
          attributes: {
            energyType: ["Lightning"],
            stage: ["Basic"],
            hp: ["190"],
          },
        },
        settings,
      ),
    ).toBe("PKM / Lightning / Basic / 190 / Overflow");
  });

  it("treats lands and color pairs according to the saved grouping settings", () => {
    expect(
      pullListColorGroup(
        { color: ["Colorless"], cardType: ["Basic Land"] },
        defaultSettings,
      ),
    ).toEqual(["Land"]);
    expect(pullListColorGroup(magicFacts.attributes, defaultSettings)).toEqual([
      "Multicolored",
    ]);
    expect(
      pullListColorGroup(magicFacts.attributes, {
        groupLands: false,
        groupMulticolored: false,
      }),
    ).toEqual(["Blue", "Red"]);
  });

  it("validates arbitrary provider attribute keys without accepting code", () => {
    const parsed = parsePullListBinningConfig(
      {
        enabled: true,
        fallback: "Unsorted",
        rules: [
          {
            id: "lorcana",
            name: "Lorcana",
            enabled: true,
            productLine: "Disney Lorcana",
            prefix: "LOR",
            dimensions: [
              { field: "inkType", fallback: "No ink" },
              { field: "strength", fallback: "No strength" },
            ],
          },
        ],
      },
      "binning",
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.config.rules[0]?.dimensions[1]?.field).toBe("strength");

    expect(
      parsePullListBinningConfig(
        {
          ...parsed.config,
          rules: [
            {
              ...parsed.config.rules[0],
              dimensions: [{ field: "power();", fallback: "No power" }],
            },
          ],
        },
        "binning",
      ).issues,
    ).toContain(
      "binning.rules[0].dimensions[0].field must be a product field name.",
    );
  });
});
