export interface PullListBinDimensionConfig {
  readonly field: string;
  readonly fallback: string;
}

export interface PullListBinRuleConfig {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Case-insensitive exact product-line name, or * for every product line. */
  readonly productLine: string;
  readonly prefix: string;
  readonly dimensions: readonly PullListBinDimensionConfig[];
}

export interface PullListBinningConfig {
  readonly enabled: boolean;
  readonly fallback: string;
  readonly rules: readonly PullListBinRuleConfig[];
}

export interface PullListGroupingSettings {
  readonly groupLands: boolean;
  readonly groupMulticolored: boolean;
  readonly binning: PullListBinningConfig;
}

export interface PullListBinFacts {
  readonly productLine: string;
  readonly productName: string;
  readonly setName: string;
  readonly number: string;
  readonly rarity: string;
  readonly condition: string;
  readonly setReleaseDate: string;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

export const PULL_LIST_BIN_FIELD_OPTIONS = [
  ["productLine", "Product line"],
  ["colorGroup", "Color group (Land/Multicolored settings)"],
  ["color", "Provider color"],
  ["cardType", "Card type"],
  ["fullType", "Full type line"],
  ["power", "Power"],
  ["toughness", "Toughness"],
  ["convertedCost", "Mana value"],
  ["rarity", "Rarity"],
  ["condition", "Condition"],
  ["printing", "Printing (Foil/Normal)"],
  ["setName", "Set"],
  ["number", "Collector number"],
  ["releaseDate", "Release date"],
  ["stage", "Pokemon stage"],
  ["energyType", "Pokemon energy type"],
  ["hp", "Pokemon HP"],
  ["retreatCost", "Pokemon retreat cost"],
  ["inkType", "Lorcana ink"],
  ["costInk", "Lorcana ink cost"],
  ["strength", "Lorcana strength"],
  ["willpower", "Lorcana willpower"],
  ["loreValue", "Lorcana lore"],
  ["classification", "Lorcana classification"],
  ["attribute", "YuGiOh attribute"],
  ["monsterType", "YuGiOh monster type"],
  ["level", "YuGiOh level"],
  ["attack", "YuGiOh attack"],
  ["defense", "YuGiOh defense"],
  ["linkArrows", "YuGiOh link arrows"],
] as const;

export const DEFAULT_PULL_LIST_BINNING_CONFIG: PullListBinningConfig = {
  enabled: true,
  fallback: "Unsorted",
  rules: [
    {
      id: "magic-default",
      name: "Magic",
      enabled: true,
      productLine: "Magic: The Gathering",
      prefix: "MTG",
      dimensions: [
        { field: "colorGroup", fallback: "Unknown color" },
        { field: "cardType", fallback: "Other type" },
        { field: "power", fallback: "No power" },
      ],
    },
  ],
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function safeText(
  value: unknown,
  path: string,
  issues: string[],
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > 128 ||
    hasControlCharacters(value)
  ) {
    issues.push(path + " must be a safe string no longer than 128 characters.");
    return "";
  }
  return value.trim();
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}

export function parsePullListBinningConfig(
  value: unknown,
  path: string,
): {
  readonly config: PullListBinningConfig;
  readonly issues: readonly string[];
} {
  const issues: string[] = [];
  const source = record(value);
  if (source === undefined) issues.push(path + " must be an object.");
  if (typeof source?.enabled !== "boolean") {
    issues.push(path + ".enabled must be a boolean.");
  }
  const fallback = safeText(source?.fallback, path + ".fallback", issues);
  const ruleValues = source?.rules;
  if (!Array.isArray(ruleValues) || ruleValues.length > 20) {
    issues.push(path + ".rules must contain at most 20 rules.");
  }
  const rules = (Array.isArray(ruleValues) ? ruleValues : []).map(
    (value, ruleIndex): PullListBinRuleConfig => {
      const rule = record(value);
      const rulePath = path + ".rules[" + String(ruleIndex) + "]";
      if (rule === undefined) issues.push(rulePath + " must be an object.");
      const id = safeText(rule?.id, rulePath + ".id", issues);
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) {
        issues.push(
          rulePath + ".id must use lowercase letters, digits, and hyphens.",
        );
      }
      if (typeof rule?.enabled !== "boolean") {
        issues.push(rulePath + ".enabled must be a boolean.");
      }
      const dimensionValues = rule?.dimensions;
      if (
        !Array.isArray(dimensionValues) ||
        dimensionValues.length < 1 ||
        dimensionValues.length > 8
      ) {
        issues.push(
          rulePath + ".dimensions must contain between 1 and 8 fields.",
        );
      }
      const dimensions = (
        Array.isArray(dimensionValues) ? dimensionValues : []
      ).map((value, dimensionIndex): PullListBinDimensionConfig => {
        const dimension = record(value);
        const dimensionPath =
          rulePath + ".dimensions[" + String(dimensionIndex) + "]";
        if (dimension === undefined) {
          issues.push(dimensionPath + " must be an object.");
        }
        const field = safeText(
          dimension?.field,
          dimensionPath + ".field",
          issues,
        );
        if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(field)) {
          issues.push(dimensionPath + ".field must be a product field name.");
        }
        return {
          field,
          fallback: safeText(
            dimension?.fallback,
            dimensionPath + ".fallback",
            issues,
          ),
        };
      });
      return {
        id,
        name: safeText(rule?.name, rulePath + ".name", issues),
        enabled: rule?.enabled === true,
        productLine: safeText(
          rule?.productLine,
          rulePath + ".productLine",
          issues,
        ),
        prefix: safeText(rule?.prefix, rulePath + ".prefix", issues, true),
        dimensions,
      };
    },
  );
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    issues.push(path + ".rules ids must be unique.");
  }
  return {
    config: {
      enabled: source?.enabled === true,
      fallback,
      rules,
    },
    issues,
  };
}

function distinctValues(
  values: readonly string[] | undefined,
): readonly string[] {
  const distinct = new Map<string, string>();
  for (const value of values ?? []) {
    const normalized = value.trim();
    if (normalized.length > 0) {
      distinct.set(normalized.toLocaleLowerCase("en-US"), normalized);
    }
  }
  return [...distinct.values()];
}

export function pullListColorGroup(
  attributes: Readonly<Record<string, readonly string[]>>,
  settings: Pick<PullListGroupingSettings, "groupLands" | "groupMulticolored">,
): readonly string[] {
  const cardTypes = attributes.cardType;
  if (
    settings.groupLands &&
    cardTypes?.some((cardType) => /\bland\b/iu.test(cardType))
  ) {
    return ["Land"];
  }
  const colors = distinctValues(attributes.color);
  return settings.groupMulticolored && colors.length >= 2
    ? ["Multicolored"]
    : colors;
}

function factValues(
  facts: PullListBinFacts,
  field: string,
  settings: PullListGroupingSettings,
): readonly string[] {
  switch (field) {
    case "productLine":
      return [facts.productLine];
    case "productName":
      return [facts.productName];
    case "setName":
      return [facts.setName];
    case "number":
      return [facts.number];
    case "rarity":
      return [facts.rarity];
    case "condition":
      return [facts.condition];
    case "printing":
      return [/\bfoil\b/iu.test(facts.condition) ? "Foil" : "Normal"];
    case "releaseDate":
      return facts.attributes.releaseDate ?? [facts.setReleaseDate];
    case "colorGroup":
      return pullListColorGroup(facts.attributes, settings);
    default:
      return facts.attributes[field] ?? [];
  }
}

export function pullListBin(
  facts: PullListBinFacts,
  settings: PullListGroupingSettings,
): string {
  if (!settings.binning.enabled) return "";
  const rule = settings.binning.rules.find(
    (candidate) =>
      candidate.enabled &&
      (candidate.productLine === "*" ||
        candidate.productLine.localeCompare(facts.productLine, "en-US", {
          sensitivity: "accent",
        }) === 0),
  );
  if (rule === undefined) return settings.binning.fallback;
  const segments = [
    ...(rule.prefix.length === 0 ? [] : [rule.prefix]),
    ...rule.dimensions.map((dimension) => {
      const values = distinctValues(
        factValues(facts, dimension.field, settings),
      );
      return values.length === 0 ? dimension.fallback : values.join(" + ");
    }),
  ];
  return segments.join(" / ");
}

export function pullListSettingsKey(
  settings: PullListGroupingSettings,
): string {
  return JSON.stringify(settings);
}
