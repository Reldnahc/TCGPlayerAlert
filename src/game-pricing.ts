export const MAGIC_RARITY_FLOOR_MODULE = "magic-rarity-floor" as const;
export const MAGIC_PRODUCT_LINE_NAME = "Magic: The Gathering" as const;

export const DEFAULT_MAGIC_RARITIES = [
  "Common",
  "Uncommon",
  "Rare",
  "Mythic Rare",
  "Special",
] as const;

export interface RarityMinimumPrice {
  readonly rarity: string;
  readonly minimumPrice: number;
}

export interface MagicRarityFloorModuleConfig {
  readonly type: typeof MAGIC_RARITY_FLOOR_MODULE;
  readonly enabled: boolean;
  readonly floors: readonly RarityMinimumPrice[];
}

export type GamePricingModuleConfig = MagicRarityFloorModuleConfig;

export interface GamePricingProduct {
  readonly productLineName: string;
  readonly rarityName: string;
}

export interface EffectiveMinimumPrice {
  readonly minimumPrice: number;
  readonly source?: {
    readonly moduleType: GamePricingModuleConfig["type"];
    readonly label: string;
  };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 80 &&
    !containsControlCharacter(value)
  );
}

function parseMinimumPrice(
  value: unknown,
  path: string,
  issues: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0.01 ||
    value > 1_000_000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-9
  ) {
    issues.push(`${path} must be $0.01-$1,000,000 with at most two decimals.`);
    return 0.01;
  }
  return value;
}

export function parseGamePricingModules(
  value: unknown,
  path: string,
  issues: string[],
): readonly GamePricingModuleConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) {
    issues.push(`${path} must be an array containing at most 10 modules.`);
    return [];
  }
  const modules = value.map((moduleValue, moduleIndex) => {
    const modulePath = `${path}[${String(moduleIndex)}]`;
    const source = record(moduleValue);
    if (source?.type !== MAGIC_RARITY_FLOOR_MODULE) {
      issues.push(`${modulePath}.type is not supported.`);
    }
    if (typeof source?.enabled !== "boolean") {
      issues.push(`${modulePath}.enabled must be true or false.`);
    }
    const floorValues = source?.floors;
    if (!Array.isArray(floorValues) || floorValues.length > 50) {
      issues.push(`${modulePath}.floors must contain at most 50 rarities.`);
    }
    const floors = (Array.isArray(floorValues) ? floorValues : []).map(
      (floorValue, floorIndex) => {
        const floorPath = `${modulePath}.floors[${String(floorIndex)}]`;
        const floorSource = record(floorValue);
        const rarity = floorSource?.rarity;
        if (!validName(rarity)) {
          issues.push(`${floorPath}.rarity must be 1-80 safe characters.`);
        }
        return {
          rarity: typeof rarity === "string" ? rarity.trim() : "Invalid",
          minimumPrice: parseMinimumPrice(
            floorSource?.minimumPrice,
            `${floorPath}.minimumPrice`,
            issues,
          ),
        };
      },
    );
    if (
      new Set(floors.map((floor) => normalizedName(floor.rarity))).size !==
      floors.length
    ) {
      issues.push(`${modulePath}.floors must use unique rarity names.`);
    }
    return {
      type: MAGIC_RARITY_FLOOR_MODULE,
      enabled: source?.enabled === true,
      floors,
    } satisfies MagicRarityFloorModuleConfig;
  });
  if (new Set(modules.map((module) => module.type)).size !== modules.length) {
    issues.push(`${path} cannot contain the same module more than once.`);
  }
  return modules;
}

export function effectiveMinimumPrice(
  profileMinimumPrice: number,
  product: GamePricingProduct,
  modules: readonly GamePricingModuleConfig[],
): EffectiveMinimumPrice {
  let result: EffectiveMinimumPrice = { minimumPrice: profileMinimumPrice };
  for (const module of modules) {
    if (
      !module.enabled ||
      normalizedName(product.productLineName) !==
        normalizedName(MAGIC_PRODUCT_LINE_NAME)
    ) {
      continue;
    }
    const rarity = normalizedName(product.rarityName);
    const floor = module.floors.find(
      (candidate) => normalizedName(candidate.rarity) === rarity,
    );
    if (floor === undefined || floor.minimumPrice <= result.minimumPrice) {
      continue;
    }
    result = {
      minimumPrice: floor.minimumPrice,
      source: {
        moduleType: module.type,
        label: `Magic ${floor.rarity}`,
      },
    };
  }
  return result;
}
