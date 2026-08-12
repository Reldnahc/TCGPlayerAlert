import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import {
  parseGamePricingModules,
  type GamePricingModuleConfig,
} from "./game-pricing.js";
import type {
  SparseMarketFallback,
  UnsupportedSellerBandAction,
} from "./repricing.js";
import type { DiscordNotificationSettings } from "./notifications/contracts.js";

export type RuleField =
  | "order.status"
  | "order.channel"
  | "order.fulfillment"
  | "order.shippingType"
  | "order.totalAmount"
  | "order.buyerPaid"
  | "order.productCount"
  | "order.itemQuantity";

export type RuleOperator = "eq" | "neq" | "in" | "gte" | "lte";

export interface RulePredicateConfig {
  readonly field: RuleField;
  readonly operator: RuleOperator;
  readonly value: string | number | boolean | readonly string[];
}

export interface RuleConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly when: {
    readonly all?: readonly RulePredicateConfig[];
    readonly any?: readonly RulePredicateConfig[];
  };
  readonly actions: readonly string[];
}

export interface CommandPrinterConfig {
  readonly adapter: "command";
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly printerName: string;
  readonly timeoutSeconds: number;
}

export interface WindowsNativeLabelPrinterConfig {
  readonly adapter: "windows-native-label";
  readonly printerName: string;
  readonly timeoutSeconds: number;
}

export interface WindowsPdfPrinterConfig {
  readonly adapter: "windows-pdf";
  readonly printerName: string;
  readonly timeoutSeconds: number;
  readonly dpi: number;
  readonly scale: "actual-size" | "fit" | "shrink";
}

export type PrinterConfig =
  | CommandPrinterConfig
  | WindowsNativeLabelPrinterConfig
  | WindowsPdfPrinterConfig;

export interface AddressLabelActionConfig {
  readonly type: "print-address-label";
  readonly enabled?: boolean;
  readonly printer: string;
  readonly page: {
    readonly widthMm: number;
    readonly heightMm: number;
    readonly marginMm: number;
    readonly fontSize: number;
  };
  readonly lines: readonly string[];
  /** Case-insensitive exact rendered lines to omit, such as domestic country codes. */
  readonly omitLineValues?: readonly string[];
}

export interface PackingSlipActionConfig {
  readonly type: "print-packing-slip";
  readonly enabled?: boolean;
  readonly printer: string;
}

export type ActionConfig = AddressLabelActionConfig | PackingSlipActionConfig;

export interface PriceUpdateQueueConfig {
  readonly enabled: boolean;
  readonly stateFile: string;
  /** Minimum time between requests accepted by the local worker. */
  readonly delaySeconds: number;
  /** Pause before retrying a request that TCGplayer explicitly rejected with 429. */
  readonly rateLimitDelaySeconds: number;
  readonly historyLimit: number;
}

export interface InventoryAdditionQueueConfig {
  readonly enabled: boolean;
  readonly stateFile: string;
  readonly delaySeconds: number;
  readonly rateLimitDelaySeconds: number;
  readonly historyLimit: number;
}

export interface ShipmentScannerConfig {
  readonly enabled: boolean;
  readonly automaticallyMarkShipped: boolean;
  readonly soundEnabled: boolean;
  readonly camera: {
    readonly enabled: boolean;
    /** Adapter-owned stable device identifier. An empty value selects the system default. */
    readonly deviceId: string;
  };
  readonly stateFile: string;
}

export interface MasterPullListConfig {
  readonly groupLands: boolean;
  readonly groupMulticolored: boolean;
}

export interface MerchandiseProfileConfig {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly estimatedShippingPrice: number;
  readonly defaultCondition:
    | "Near Mint"
    | "Lightly Played"
    | "Moderately Played"
    | "Heavily Played"
    | "Damaged"
    | "Unopened";
  readonly defaultPrinting: "Normal" | "Foil";
  readonly pricingProfileId: string;
}

export interface RepricingRangeConfig {
  readonly maximumPrice?: number;
  readonly minimumListings: number;
  readonly priceSource: "lowest" | "market";
  readonly percentage: number;
  readonly gapThresholdPercent: number;
  readonly gapAction: "follow-lowest" | "use-next" | "skip";
  readonly supportMode?: "adjacent" | "cluster";
  readonly minimumSellerSupport?: number;
  readonly supportWindowPercent?: number;
}

export interface RepricingProfileConfig {
  readonly id: string;
  readonly name: string;
  readonly minimumPrice: number;
  readonly conditionPolicy: "same" | "same-or-better";
  readonly priceBasis: "item" | "delivered";
  readonly adjustmentCents: number;
  readonly allowPriceIncreases: boolean;
  readonly unsupportedSellerBandAction: UnsupportedSellerBandAction;
  readonly automaticDecreaseGuard: boolean;
  readonly automaticDecreaseThresholdPercent: number;
  readonly automaticDecreaseThresholdAmount: number;
  readonly sparseMarketFallback: SparseMarketFallback;
  readonly gamePricingModules: readonly GamePricingModuleConfig[];
  readonly ranges: readonly RepricingRangeConfig[];
}

export const CURRENT_CONFIG_VERSION = 4 as const;

export interface AppConfig {
  readonly version: typeof CURRENT_CONFIG_VERSION;
  readonly pricingProfileDefaultsVersion: 1;
  readonly pollIntervalMinutes: number;
  readonly confirmBeforeMarkingShipped: boolean;
  readonly masterPullList: MasterPullListConfig;
  readonly shipmentScanner: ShipmentScannerConfig;
  readonly actionMaximumAttempts: number;
  readonly stateFile: string;
  readonly spoolDirectory: string;
  readonly timezoneOffsetMinutes: number | "local";
  readonly priceUpdateQueue: PriceUpdateQueueConfig;
  readonly inventoryAdditionQueue: InventoryAdditionQueueConfig;
  readonly merchandiseProfiles: readonly MerchandiseProfileConfig[];
  readonly defaultMerchandiseProfileId: string;
  readonly repricingProfiles: readonly RepricingProfileConfig[];
  readonly defaultRepricingProfileId: string;
  readonly notifications: {
    readonly discord: DiscordNotificationSettings;
  };
  readonly provider: {
    readonly type: "tcgplayer";
    readonly authCookieEnv: string;
    readonly sellerKeyEnv: string;
    readonly pageSize: number;
    readonly maximumPages: number;
  };
  readonly printers: Readonly<Record<string, PrinterConfig>>;
  readonly actions: Readonly<Record<string, ActionConfig>>;
  readonly rules: readonly RuleConfig[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function text(
  source: UnknownRecord | undefined,
  key: string,
  path: string,
  issues: string[],
): string {
  const value = source?.[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1024 ||
    containsControlCharacter(value)
  ) {
    issues.push(`${path}.${key} must be a non-empty safe string.`);
    return "";
  }
  return value.trim();
}

function booleanValue(
  source: UnknownRecord | undefined,
  key: string,
  path: string,
  issues: string[],
): boolean {
  const value = source?.[key];
  if (typeof value !== "boolean") {
    issues.push(`${path}.${key} must be a boolean.`);
    return false;
  }
  return value;
}

function integer(
  source: UnknownRecord | undefined,
  key: string,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  const value = source?.[key];
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    issues.push(
      `${path}.${key} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
    return minimum;
  }
  return Number(value);
}

function numberValue(
  source: UnknownRecord | undefined,
  key: string,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  const value = source?.[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    issues.push(
      `${path}.${key} must be between ${String(minimum)} and ${String(maximum)}.`,
    );
    return minimum;
  }
  return value;
}

function timezoneOffset(
  source: UnknownRecord | undefined,
  issues: string[],
): number | "local" {
  const value = source?.timezoneOffsetMinutes;
  if (value === "local") return value;
  if (!Number.isInteger(value) || Number(value) < -840 || Number(value) > 840) {
    issues.push(
      "config.timezoneOffsetMinutes must be local or an integer between -840 and 840.",
    );
    return "local";
  }
  return Number(value);
}

function identifier(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    issues.push(`${path} must use lowercase letters, digits, and hyphens.`);
    return "invalid";
  }
  return value;
}

const RULE_FIELDS = new Set<RuleField>([
  "order.status",
  "order.channel",
  "order.fulfillment",
  "order.shippingType",
  "order.totalAmount",
  "order.buyerPaid",
  "order.productCount",
  "order.itemQuantity",
]);
const RULE_OPERATORS = new Set<RuleOperator>(["eq", "neq", "in", "gte", "lte"]);
const NUMERIC_RULE_FIELDS = new Set<RuleField>([
  "order.totalAmount",
  "order.productCount",
  "order.itemQuantity",
]);
const ADDRESS_TEMPLATE_FIELDS = new Set([
  "recipientName",
  "addressOne",
  "addressTwo",
  "city",
  "territory",
  "postalCode",
  "country",
]);

const DEFAULT_MERCHANDISE_PROFILE: MerchandiseProfileConfig = {
  id: "english-singles",
  name: "English singles",
  language: "English",
  estimatedShippingPrice: 0,
  defaultCondition: "Near Mint",
  defaultPrinting: "Normal",
  pricingProfileId: "match-lowest",
};

const DEFAULT_REPRICING_PROFILE: RepricingProfileConfig = {
  id: "match-lowest",
  name: "Smart conservative",
  minimumPrice: 0.35,
  conditionPolicy: "same-or-better",
  priceBasis: "delivered",
  adjustmentCents: 0,
  allowPriceIncreases: false,
  unsupportedSellerBandAction: "wait",
  automaticDecreaseGuard: true,
  automaticDecreaseThresholdPercent: 25,
  automaticDecreaseThresholdAmount: 0.5,
  sparseMarketFallback: "higher-of-market-and-lowest",
  gamePricingModules: [],
  ranges: [
    {
      maximumPrice: 1,
      minimumListings: 2,
      priceSource: "lowest",
      percentage: 100,
      gapThresholdPercent: 20,
      gapAction: "use-next",
      supportMode: "cluster",
      minimumSellerSupport: 2,
      supportWindowPercent: 5,
    },
    {
      maximumPrice: 5,
      minimumListings: 2,
      priceSource: "lowest",
      percentage: 100,
      gapThresholdPercent: 3,
      gapAction: "use-next",
      supportMode: "cluster",
      minimumSellerSupport: 2,
      supportWindowPercent: 5,
    },
    {
      maximumPrice: 25,
      minimumListings: 2,
      priceSource: "lowest",
      percentage: 100,
      gapThresholdPercent: 3,
      gapAction: "use-next",
      supportMode: "cluster",
      minimumSellerSupport: 2,
      supportWindowPercent: 5,
    },
    {
      maximumPrice: 100,
      minimumListings: 3,
      priceSource: "lowest",
      percentage: 100,
      gapThresholdPercent: 3,
      gapAction: "skip",
      supportMode: "cluster",
      minimumSellerSupport: 2,
      supportWindowPercent: 5,
    },
    {
      minimumListings: 3,
      priceSource: "lowest",
      percentage: 100,
      gapThresholdPercent: 3,
      gapAction: "skip",
      supportMode: "cluster",
      minimumSellerSupport: 2,
      supportWindowPercent: 5,
    },
  ],
};

const DEFAULT_DISCORD_NOTIFICATIONS: DiscordNotificationSettings = {
  enabled: false,
  webhookUrlEnv: "DISCORD_WEBHOOK_URL",
  events: {
    authenticationRequired: true,
    inboundMessage: true,
    orderCanceled: true,
    shipmentMarkAttempt: true,
  },
};

const SELL_NOW_REPRICING_PROFILE: RepricingProfileConfig = {
  id: "sell-now",
  name: "Sell now",
  minimumPrice: 0.35,
  conditionPolicy: "same-or-better",
  priceBasis: "delivered",
  adjustmentCents: 1,
  allowPriceIncreases: true,
  unsupportedSellerBandAction: "fallback",
  automaticDecreaseGuard: false,
  automaticDecreaseThresholdPercent: 25,
  automaticDecreaseThresholdAmount: 0.5,
  sparseMarketFallback: "lowest-then-market",
  gamePricingModules: [],
  ranges: [
    {
      minimumListings: 0,
      priceSource: "lowest",
      percentage: 100,
      gapThresholdPercent: 0,
      gapAction: "follow-lowest",
      supportMode: "cluster",
      minimumSellerSupport: 1,
      supportWindowPercent: 5,
    },
  ],
};

function parseMerchandiseProfile(
  value: unknown,
  index: number,
  issues: string[],
  fallbackPricingProfileId: string,
): MerchandiseProfileConfig {
  const source = record(value);
  const path = `config.merchandiseProfiles[${String(index)}]`;
  const defaultCondition = source?.defaultCondition ?? "Near Mint";
  const defaultPrinting = source?.defaultPrinting ?? "Normal";
  if (
    defaultCondition !== "Near Mint" &&
    defaultCondition !== "Lightly Played" &&
    defaultCondition !== "Moderately Played" &&
    defaultCondition !== "Heavily Played" &&
    defaultCondition !== "Damaged" &&
    defaultCondition !== "Unopened"
  ) {
    issues.push(`${path}.defaultCondition is invalid.`);
  }
  if (defaultPrinting !== "Normal" && defaultPrinting !== "Foil") {
    issues.push(`${path}.defaultPrinting must be Normal or Foil.`);
  }
  return {
    id: identifier(source?.id, `${path}.id`, issues),
    name: text(source, "name", path, issues),
    language: text(source, "language", path, issues),
    estimatedShippingPrice: numberValue(
      source,
      "estimatedShippingPrice",
      path,
      0,
      1_000_000,
      issues,
    ),
    defaultCondition:
      defaultCondition as MerchandiseProfileConfig["defaultCondition"],
    defaultPrinting:
      defaultPrinting as MerchandiseProfileConfig["defaultPrinting"],
    pricingProfileId: identifier(
      source?.pricingProfileId ?? fallbackPricingProfileId,
      `${path}.pricingProfileId`,
      issues,
    ),
  };
}

function parseRepricingProfile(
  value: unknown,
  index: number,
  issues: string[],
): RepricingProfileConfig {
  const source = record(value);
  const path = `config.repricingProfiles[${String(index)}]`;
  const conditionPolicy = source?.conditionPolicy;
  const priceBasis = source?.priceBasis;
  if (conditionPolicy !== "same" && conditionPolicy !== "same-or-better") {
    issues.push(`${path}.conditionPolicy must be same or same-or-better.`);
  }
  if (priceBasis !== "item" && priceBasis !== "delivered") {
    issues.push(`${path}.priceBasis must be item or delivered.`);
  }
  const sparseMarketFallback =
    source?.sparseMarketFallback ??
    (source?.id === DEFAULT_REPRICING_PROFILE.id
      ? DEFAULT_REPRICING_PROFILE.sparseMarketFallback
      : "skip");
  if (
    sparseMarketFallback !== "skip" &&
    sparseMarketFallback !== "higher-of-market-and-lowest" &&
    sparseMarketFallback !== "market-then-lowest" &&
    sparseMarketFallback !== "lowest-then-market"
  ) {
    issues.push(`${path}.sparseMarketFallback is invalid.`);
  }
  const unsupportedSellerBandAction =
    source?.unsupportedSellerBandAction ??
    (source?.id === DEFAULT_REPRICING_PROFILE.id ? "wait" : "fallback");
  if (
    unsupportedSellerBandAction !== "wait" &&
    unsupportedSellerBandAction !== "fallback"
  ) {
    issues.push(`${path}.unsupportedSellerBandAction is invalid.`);
  }
  const profileSource = {
    ...source,
    automaticDecreaseGuard:
      source?.automaticDecreaseGuard ??
      source?.id === DEFAULT_REPRICING_PROFILE.id,
    automaticDecreaseThresholdPercent:
      source?.automaticDecreaseThresholdPercent ?? 25,
    automaticDecreaseThresholdAmount:
      source?.automaticDecreaseThresholdAmount ?? 0.5,
  };
  const rangeValues = source?.ranges;
  if (!Array.isArray(rangeValues)) {
    issues.push(`${path}.ranges must be an array.`);
  }
  const ranges = (Array.isArray(rangeValues) ? rangeValues : []).map(
    (range, rangeIndex) =>
      parseRepricingRange(
        range,
        `${path}.ranges[${String(rangeIndex)}]`,
        rangeIndex,
        Array.isArray(rangeValues) ? rangeValues.length : 0,
        issues,
      ),
  );
  if (ranges.length < 1 || ranges.length > 20) {
    issues.push(`${path}.ranges must contain between 1 and 20 ranges.`);
  }
  for (let rangeIndex = 1; rangeIndex < ranges.length; rangeIndex += 1) {
    const previous = ranges[rangeIndex - 1]?.maximumPrice;
    const current = ranges[rangeIndex]?.maximumPrice;
    if (
      previous === undefined ||
      (current !== undefined && current <= previous)
    ) {
      issues.push(`${path}.ranges maximum prices must increase.`);
      break;
    }
  }
  return {
    id: identifier(source?.id, `${path}.id`, issues),
    name: text(source, "name", path, issues),
    minimumPrice: numberValue(
      source,
      "minimumPrice",
      path,
      0.01,
      1_000_000,
      issues,
    ),
    conditionPolicy:
      conditionPolicy as RepricingProfileConfig["conditionPolicy"],
    priceBasis: priceBasis as RepricingProfileConfig["priceBasis"],
    adjustmentCents: integer(
      source,
      "adjustmentCents",
      path,
      0,
      100_000,
      issues,
    ),
    allowPriceIncreases: booleanValue(
      source,
      "allowPriceIncreases",
      path,
      issues,
    ),
    unsupportedSellerBandAction:
      unsupportedSellerBandAction as UnsupportedSellerBandAction,
    automaticDecreaseGuard: booleanValue(
      profileSource,
      "automaticDecreaseGuard",
      path,
      issues,
    ),
    automaticDecreaseThresholdPercent: numberValue(
      profileSource,
      "automaticDecreaseThresholdPercent",
      path,
      0.1,
      100,
      issues,
    ),
    automaticDecreaseThresholdAmount: numberValue(
      profileSource,
      "automaticDecreaseThresholdAmount",
      path,
      0.01,
      1_000_000,
      issues,
    ),
    sparseMarketFallback: sparseMarketFallback as SparseMarketFallback,
    gamePricingModules: parseGamePricingModules(
      source?.gamePricingModules,
      `${path}.gamePricingModules`,
      issues,
    ),
    ranges,
  };
}

function parseRepricingRange(
  value: unknown,
  path: string,
  index: number,
  count: number,
  issues: string[],
): RepricingRangeConfig {
  const source = record(value);
  const priceSource = source?.priceSource;
  const gapAction = source?.gapAction;
  const supportMode = source?.supportMode ?? "adjacent";
  if (priceSource !== "lowest" && priceSource !== "market") {
    issues.push(`${path}.priceSource must be lowest or market.`);
  }
  if (
    gapAction !== "follow-lowest" &&
    gapAction !== "use-next" &&
    gapAction !== "skip"
  ) {
    issues.push(`${path}.gapAction is invalid.`);
  }
  if (supportMode !== "adjacent" && supportMode !== "cluster") {
    issues.push(`${path}.supportMode is invalid.`);
  }
  let maximumPrice: number | undefined;
  if (index < count - 1) {
    maximumPrice = numberValue(
      source,
      "maximumPrice",
      path,
      0.01,
      1_000_000,
      issues,
    );
  } else if (source?.maximumPrice !== undefined) {
    issues.push(`${path}.maximumPrice must be omitted for the final range.`);
  }
  return {
    ...(maximumPrice === undefined ? {} : { maximumPrice }),
    minimumListings:
      source?.minimumListings === undefined
        ? 0
        : integer(source, "minimumListings", path, 0, 100, issues),
    priceSource: priceSource as RepricingRangeConfig["priceSource"],
    percentage: numberValue(source, "percentage", path, 1, 500, issues),
    gapThresholdPercent: numberValue(
      source,
      "gapThresholdPercent",
      path,
      0,
      10_000,
      issues,
    ),
    gapAction: gapAction as RepricingRangeConfig["gapAction"],
    supportMode: supportMode as NonNullable<
      RepricingRangeConfig["supportMode"]
    >,
    minimumSellerSupport:
      source?.minimumSellerSupport === undefined
        ? 2
        : integer(source, "minimumSellerSupport", path, 1, 100, issues),
    supportWindowPercent:
      source?.supportWindowPercent === undefined
        ? 5
        : numberValue(source, "supportWindowPercent", path, 0, 100, issues),
  };
}

function parsePredicate(
  value: unknown,
  path: string,
  issues: string[],
): RulePredicateConfig {
  const source = record(value);
  const fieldValue = source?.field;
  const operatorValue = source?.operator;
  if (
    typeof fieldValue !== "string" ||
    !RULE_FIELDS.has(fieldValue as RuleField)
  ) {
    issues.push(`${path}.field is unsupported.`);
  }
  if (
    typeof operatorValue !== "string" ||
    !RULE_OPERATORS.has(operatorValue as RuleOperator)
  ) {
    issues.push(`${path}.operator is unsupported.`);
  }
  const predicateValue = source?.value;
  const validValue =
    typeof predicateValue === "string" ||
    typeof predicateValue === "boolean" ||
    (typeof predicateValue === "number" && Number.isFinite(predicateValue)) ||
    (Array.isArray(predicateValue) &&
      predicateValue.length > 0 &&
      predicateValue.every((entry) => typeof entry === "string"));
  if (!validValue) issues.push(`${path}.value has an unsupported type.`);
  if (operatorValue === "in" && !Array.isArray(predicateValue)) {
    issues.push(`${path}.value must be a string array for the in operator.`);
  }
  if (
    (operatorValue === "gte" || operatorValue === "lte") &&
    (typeof predicateValue !== "number" ||
      !NUMERIC_RULE_FIELDS.has(fieldValue as RuleField))
  ) {
    issues.push(`${path} must compare a numeric field to a number.`);
  }
  return {
    field: fieldValue as RuleField,
    operator: operatorValue as RuleOperator,
    value: predicateValue as RulePredicateConfig["value"],
  };
}

function parseStringArray(
  value: unknown,
  path: string,
  issues: string[],
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    issues.push(
      `${path} must be ${allowEmpty ? "an" : "a non-empty"} array of strings.`,
    );
    return [];
  }
  return value.map((entry) => String(entry));
}

function requireField(
  source: UnknownRecord | undefined,
  key: string,
  path: string,
  issues: string[],
  version: 2 | 3 | 4,
): void {
  if (source?.[key] === undefined) {
    issues.push(
      `${path}.${key} is required in configuration version ${String(version)}.`,
    );
  }
}

function validateVersionTwoShape(
  root: UnknownRecord | undefined,
  issues: string[],
  version: 2 | 3 | 4,
): void {
  for (const key of [
    "pricingProfileDefaultsVersion",
    "confirmBeforeMarkingShipped",
    "shipmentScanner",
    "inventoryAdditionQueue",
    "merchandiseProfiles",
    "defaultMerchandiseProfileId",
    "repricingProfiles",
    "defaultRepricingProfileId",
  ]) {
    requireField(root, key, "config", issues, version);
  }
  if (root?.dryRun !== undefined) {
    issues.push(
      "config.dryRun was removed in configuration version 2; disable individual actions and queues instead.",
    );
  }

  const shipmentScanner = record(root?.shipmentScanner);
  if (shipmentScanner !== undefined) {
    requireField(
      shipmentScanner,
      "camera",
      "config.shipmentScanner",
      issues,
      version,
    );
    const camera = record(shipmentScanner.camera);
    if (camera !== undefined) {
      requireField(
        camera,
        "enabled",
        "config.shipmentScanner.camera",
        issues,
        version,
      );
      requireField(
        camera,
        "deviceId",
        "config.shipmentScanner.camera",
        issues,
        version,
      );
    }
  }

  if (Array.isArray(root?.merchandiseProfiles)) {
    for (const [index, value] of root.merchandiseProfiles.entries()) {
      const profile = record(value);
      const path = `config.merchandiseProfiles[${String(index)}]`;
      requireField(profile, "defaultCondition", path, issues, version);
      requireField(profile, "defaultPrinting", path, issues, version);
      requireField(profile, "pricingProfileId", path, issues, version);
    }
  }

  if (Array.isArray(root?.repricingProfiles)) {
    for (const [profileIndex, value] of root.repricingProfiles.entries()) {
      const profile = record(value);
      const profilePath = `config.repricingProfiles[${String(profileIndex)}]`;
      requireField(
        profile,
        "sparseMarketFallback",
        profilePath,
        issues,
        version,
      );
      requireField(profile, "gamePricingModules", profilePath, issues, version);
      if (!Array.isArray(profile?.ranges)) continue;
      for (const [rangeIndex, rangeValue] of profile.ranges.entries()) {
        const range = record(rangeValue);
        const rangePath = `${profilePath}.ranges[${String(rangeIndex)}]`;
        requireField(range, "minimumListings", rangePath, issues, version);
        requireField(range, "supportMode", rangePath, issues, version);
        requireField(range, "minimumSellerSupport", rangePath, issues, version);
        requireField(range, "supportWindowPercent", rangePath, issues, version);
      }
    }
  }

  const actions = record(root?.actions);
  for (const [actionId, value] of Object.entries(actions ?? {})) {
    const action = record(value);
    const path = `config.actions.${actionId}`;
    requireField(action, "enabled", path, issues, version);
    if (action?.type === "print-address-label") {
      requireField(action, "omitLineValues", path, issues, version);
    }
  }
}

function validateVersionThreeShape(
  root: UnknownRecord | undefined,
  issues: string[],
  version: 3 | 4,
): void {
  requireField(root, "notifications", "config", issues, version);
  const notifications = record(root?.notifications);
  requireField(
    notifications,
    "discord",
    "config.notifications",
    issues,
    version,
  );
  const discord = record(notifications?.discord);
  for (const key of ["enabled", "webhookUrlEnv", "events"]) {
    requireField(discord, key, "config.notifications.discord", issues, version);
  }
  const events = record(discord?.events);
  for (const key of [
    "authenticationRequired",
    "inboundMessage",
    "orderCanceled",
    "shipmentMarkAttempt",
  ]) {
    requireField(
      events,
      key,
      "config.notifications.discord.events",
      issues,
      version,
    );
  }
}

function validateVersionFourShape(
  root: UnknownRecord | undefined,
  issues: string[],
): void {
  requireField(root, "masterPullList", "config", issues, 4);
  const masterPullList = record(root?.masterPullList);
  for (const key of ["groupLands", "groupMulticolored"]) {
    requireField(masterPullList, key, "config.masterPullList", issues, 4);
  }
}

export function parseConfig(value: unknown): AppConfig {
  const issues: string[] = [];
  const root = record(value);
  if (root === undefined) issues.push("config must be an object.");
  const sourceVersion = root?.version;
  const isVersionOne = sourceVersion === 1;
  const isVersionTwo = sourceVersion === 2;
  const isVersionThree = sourceVersion === 3;
  const isVersionFour = sourceVersion === CURRENT_CONFIG_VERSION;
  if (!isVersionOne && !isVersionTwo && !isVersionThree && !isVersionFour) {
    issues.push(
      `config.version must be 1, 2, 3, or ${String(CURRENT_CONFIG_VERSION)}; newer versions require an application update.`,
    );
  }
  if (isVersionTwo) validateVersionTwoShape(root, issues, 2);
  if (isVersionThree) validateVersionTwoShape(root, issues, 3);
  if (isVersionFour) validateVersionTwoShape(root, issues, 4);
  if (isVersionThree) validateVersionThreeShape(root, issues, 3);
  if (isVersionFour) validateVersionThreeShape(root, issues, 4);
  if (isVersionFour) validateVersionFourShape(root, issues);
  const disableLegacySideEffects = isVersionOne && root?.dryRun === true;
  if (
    root?.pricingProfileDefaultsVersion !== undefined &&
    root.pricingProfileDefaultsVersion !== 1
  ) {
    issues.push("config.pricingProfileDefaultsVersion must be 1.");
  }

  const provider = record(root?.provider);
  if (provider?.type !== "tcgplayer") {
    issues.push("config.provider.type must be tcgplayer.");
  }
  const priceUpdateQueue = record(root?.priceUpdateQueue);
  if (priceUpdateQueue === undefined) {
    issues.push("config.priceUpdateQueue must be an object.");
  }
  const inventoryAdditionQueue = record(root?.inventoryAdditionQueue);
  const shipmentScanner = record(root?.shipmentScanner);
  const masterPullList = record(root?.masterPullList);
  const shipmentScannerCamera = record(shipmentScanner?.camera);
  const notifications = record(root?.notifications);
  const discordNotifications = record(notifications?.discord);
  const discordEvents = record(discordNotifications?.events);
  const legacyRepricingProfileValues = root?.repricingProfiles;
  const firstLegacyRepricingProfile = Array.isArray(
    legacyRepricingProfileValues,
  )
    ? record(legacyRepricingProfileValues[0])
    : undefined;
  const fallbackPricingProfileId =
    typeof root?.defaultRepricingProfileId === "string"
      ? root.defaultRepricingProfileId
      : typeof firstLegacyRepricingProfile?.id === "string"
        ? firstLegacyRepricingProfile.id
        : DEFAULT_REPRICING_PROFILE.id;
  const merchandiseProfileValues = root?.merchandiseProfiles;
  if (
    merchandiseProfileValues !== undefined &&
    !Array.isArray(merchandiseProfileValues)
  ) {
    issues.push("config.merchandiseProfiles must be an array.");
  }
  const merchandiseProfiles =
    merchandiseProfileValues === undefined
      ? [DEFAULT_MERCHANDISE_PROFILE]
      : (Array.isArray(merchandiseProfileValues)
          ? merchandiseProfileValues
          : []
        ).map((profile, index) =>
          parseMerchandiseProfile(
            profile,
            index,
            issues,
            fallbackPricingProfileId,
          ),
        );
  if (merchandiseProfiles.length < 1 || merchandiseProfiles.length > 20) {
    issues.push(
      "config.merchandiseProfiles must contain between 1 and 20 profiles.",
    );
  }
  if (
    new Set(merchandiseProfiles.map((profile) => profile.id)).size !==
    merchandiseProfiles.length
  ) {
    issues.push("config.merchandiseProfiles ids must be unique.");
  }
  const defaultMerchandiseProfileId =
    root?.defaultMerchandiseProfileId === undefined
      ? (merchandiseProfiles[0]?.id ?? DEFAULT_MERCHANDISE_PROFILE.id)
      : identifier(
          root.defaultMerchandiseProfileId,
          "config.defaultMerchandiseProfileId",
          issues,
        );
  if (
    !merchandiseProfiles.some(
      (profile) => profile.id === defaultMerchandiseProfileId,
    )
  ) {
    issues.push(
      "config.defaultMerchandiseProfileId must reference a merchandise profile.",
    );
  }
  const repricingProfileValues = root?.repricingProfiles;
  if (
    repricingProfileValues !== undefined &&
    !Array.isArray(repricingProfileValues)
  ) {
    issues.push("config.repricingProfiles must be an array.");
  }
  const parsedRepricingProfiles =
    repricingProfileValues === undefined
      ? [DEFAULT_REPRICING_PROFILE, SELL_NOW_REPRICING_PROFILE]
      : (Array.isArray(repricingProfileValues)
          ? repricingProfileValues
          : []
        ).map((profile, index) =>
          parseRepricingProfile(profile, index, issues),
        );
  const seedSellNowProfile =
    isVersionOne &&
    root?.pricingProfileDefaultsVersion === undefined &&
    repricingProfileValues !== undefined &&
    parsedRepricingProfiles.length < 20 &&
    !parsedRepricingProfiles.some(
      (profile) => profile.id === SELL_NOW_REPRICING_PROFILE.id,
    );
  const repricingProfiles = seedSellNowProfile
    ? [...parsedRepricingProfiles, SELL_NOW_REPRICING_PROFILE]
    : parsedRepricingProfiles;
  if (repricingProfiles.length < 1 || repricingProfiles.length > 20) {
    issues.push(
      "config.repricingProfiles must contain between 1 and 20 profiles.",
    );
  }
  if (
    new Set(repricingProfiles.map((profile) => profile.id)).size !==
    repricingProfiles.length
  ) {
    issues.push("config.repricingProfiles ids must be unique.");
  }
  const defaultRepricingProfileId =
    root?.defaultRepricingProfileId === undefined
      ? (repricingProfiles[0]?.id ?? DEFAULT_REPRICING_PROFILE.id)
      : identifier(
          root.defaultRepricingProfileId,
          "config.defaultRepricingProfileId",
          issues,
        );
  if (
    !repricingProfiles.some(
      (profile) => profile.id === defaultRepricingProfileId,
    )
  ) {
    issues.push(
      "config.defaultRepricingProfileId must reference a repricing profile.",
    );
  }
  for (const [index, profile] of merchandiseProfiles.entries()) {
    if (
      !repricingProfiles.some(
        (pricingProfile) => pricingProfile.id === profile.pricingProfileId,
      )
    ) {
      issues.push(
        `config.merchandiseProfiles[${String(index)}].pricingProfileId must reference a pricing profile.`,
      );
    }
  }

  const printersSource = record(root?.printers);
  if (printersSource === undefined)
    issues.push("config.printers must be an object.");
  const printers: Record<string, PrinterConfig> = {};
  for (const [rawId, value] of Object.entries(printersSource ?? {})) {
    const id = identifier(rawId, `config.printers.${rawId}`, issues);
    const source = record(value);
    const path = `config.printers.${rawId}`;
    const printerName = text(source, "printerName", path, issues);
    const timeoutSeconds = integer(
      source,
      "timeoutSeconds",
      path,
      1,
      300,
      issues,
    );
    if (source?.adapter === "command") {
      const printerConfig: CommandPrinterConfig = {
        adapter: "command",
        executable: text(source, "executable", path, issues),
        arguments: parseStringArray(
          source.arguments,
          `${path}.arguments`,
          issues,
          true,
        ),
        printerName,
        timeoutSeconds,
      };
      printers[id] = printerConfig;
      if (
        !printerConfig.arguments.some((argument) => argument.includes("{file}"))
      ) {
        issues.push(`${path}.arguments must include {file}.`);
      }
      if (
        printerConfig.arguments.some((argument) => {
          const withoutKnownFields = argument.replace(
            /\{(?:file|printer|job)\}/gu,
            "",
          );
          return /[{}]/u.test(withoutKnownFields);
        })
      ) {
        issues.push(`${path}.arguments has an unknown placeholder.`);
      }
    } else if (source?.adapter === "windows-native-label") {
      printers[id] = {
        adapter: "windows-native-label",
        printerName,
        timeoutSeconds,
      };
    } else if (source?.adapter === "windows-pdf") {
      const scale = source.scale;
      if (scale !== "actual-size" && scale !== "fit" && scale !== "shrink") {
        issues.push(`${path}.scale must be actual-size, fit, or shrink.`);
      }
      printers[id] = {
        adapter: "windows-pdf",
        printerName,
        timeoutSeconds,
        dpi: integer(source, "dpi", path, 72, 600, issues),
        scale: scale as WindowsPdfPrinterConfig["scale"],
      };
    } else {
      issues.push(
        `${path}.adapter must be command, windows-native-label, or windows-pdf.`,
      );
    }
  }

  const actionsSource = record(root?.actions);
  if (actionsSource === undefined)
    issues.push("config.actions must be an object.");
  const actions: Record<string, ActionConfig> = {};
  for (const [rawId, value] of Object.entries(actionsSource ?? {})) {
    const id = identifier(rawId, `config.actions.${rawId}`, issues);
    const source = record(value);
    const type = source?.type;
    const enabled =
      source?.enabled === undefined
        ? true
        : booleanValue(source, "enabled", `config.actions.${rawId}`, issues);
    const printer = text(source, "printer", `config.actions.${rawId}`, issues);
    if (printer && printers[printer] === undefined) {
      issues.push(
        `config.actions.${rawId}.printer references an unknown printer.`,
      );
    }
    if (type === "print-address-label") {
      const page = record(source?.page);
      const lines = parseStringArray(
        source?.lines,
        `config.actions.${rawId}.lines`,
        issues,
      );
      const omitLineValues =
        source?.omitLineValues === undefined
          ? []
          : parseStringArray(
              source.omitLineValues,
              `config.actions.${rawId}.omitLineValues`,
              issues,
              true,
            );
      for (const line of lines) {
        for (const match of line.matchAll(/\{([^{}]+)\}/gu)) {
          if (!ADDRESS_TEMPLATE_FIELDS.has(match[1] ?? "")) {
            issues.push(
              `config.actions.${rawId}.lines has an unknown placeholder.`,
            );
          }
        }
      }
      actions[id] = {
        type,
        enabled,
        printer,
        page: {
          widthMm: numberValue(
            page,
            "widthMm",
            `config.actions.${rawId}.page`,
            20,
            300,
            issues,
          ),
          heightMm: numberValue(
            page,
            "heightMm",
            `config.actions.${rawId}.page`,
            20,
            300,
            issues,
          ),
          marginMm: numberValue(
            page,
            "marginMm",
            `config.actions.${rawId}.page`,
            0,
            50,
            issues,
          ),
          fontSize: numberValue(
            page,
            "fontSize",
            `config.actions.${rawId}.page`,
            6,
            72,
            issues,
          ),
        },
        lines,
        omitLineValues,
      };
    } else if (type === "print-packing-slip") {
      if (printers[printer]?.adapter === "windows-native-label") {
        issues.push(
          `config.actions.${rawId}.printer does not accept PDF documents.`,
        );
      }
      actions[id] = { type, enabled, printer };
    } else {
      issues.push(`config.actions.${rawId}.type is unsupported.`);
    }
  }

  const rulesValue = root?.rules;
  if (!Array.isArray(rulesValue)) issues.push("config.rules must be an array.");
  const rules = (Array.isArray(rulesValue) ? rulesValue : []).map(
    (value, index): RuleConfig => {
      const path = `config.rules[${String(index)}]`;
      const source = record(value);
      const id = identifier(source?.id, `${path}.id`, issues);
      const when = record(source?.when);
      if (when === undefined) issues.push(`${path}.when must be an object.`);
      const allValue = when?.all;
      const anyValue = when?.any;
      if (allValue !== undefined && !Array.isArray(allValue))
        issues.push(`${path}.when.all must be an array.`);
      if (anyValue !== undefined && !Array.isArray(anyValue))
        issues.push(`${path}.when.any must be an array.`);
      const actionIds = parseStringArray(
        source?.actions,
        `${path}.actions`,
        issues,
        true,
      );
      for (const actionId of actionIds) {
        if (actions[actionId] === undefined)
          issues.push(`${path}.actions references unknown action ${actionId}.`);
      }
      return {
        id,
        enabled: booleanValue(source, "enabled", path, issues),
        when: {
          ...(Array.isArray(allValue)
            ? {
                all: allValue.map((predicate, predicateIndex) =>
                  parsePredicate(
                    predicate,
                    `${path}.when.all[${String(predicateIndex)}]`,
                    issues,
                  ),
                ),
              }
            : {}),
          ...(Array.isArray(anyValue)
            ? {
                any: anyValue.map((predicate, predicateIndex) =>
                  parsePredicate(
                    predicate,
                    `${path}.when.any[${String(predicateIndex)}]`,
                    issues,
                  ),
                ),
              }
            : {}),
        },
        actions: actionIds,
      };
    },
  );
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    issues.push("config.rules ids must be unique.");
  }

  const pollIntervalMinutes = integer(
    root,
    "pollIntervalMinutes",
    "config",
    1,
    1440,
    issues,
  );
  const confirmBeforeMarkingShipped =
    root?.confirmBeforeMarkingShipped === undefined
      ? true
      : booleanValue(root, "confirmBeforeMarkingShipped", "config", issues);
  const masterPullListConfig: MasterPullListConfig =
    masterPullList === undefined
      ? { groupLands: true, groupMulticolored: true }
      : {
          groupLands: booleanValue(
            masterPullList,
            "groupLands",
            "config.masterPullList",
            issues,
          ),
          groupMulticolored: booleanValue(
            masterPullList,
            "groupMulticolored",
            "config.masterPullList",
            issues,
          ),
        };
  const shipmentScannerConfig: ShipmentScannerConfig =
    shipmentScanner === undefined
      ? {
          enabled: false,
          automaticallyMarkShipped: false,
          soundEnabled: true,
          camera: { enabled: false, deviceId: "" },
          stateFile: ".data/shipment-scans.json",
        }
      : (() => {
          const cameraDeviceId = shipmentScannerCamera?.deviceId ?? "";
          if (
            typeof cameraDeviceId !== "string" ||
            cameraDeviceId.length > 256 ||
            containsControlCharacter(cameraDeviceId)
          ) {
            issues.push(
              "config.shipmentScanner.camera.deviceId must be a safe string no longer than 256 characters.",
            );
          }
          return {
            enabled: booleanValue(
              shipmentScanner,
              "enabled",
              "config.shipmentScanner",
              issues,
            ),
            automaticallyMarkShipped: booleanValue(
              shipmentScanner,
              "automaticallyMarkShipped",
              "config.shipmentScanner",
              issues,
            ),
            soundEnabled: booleanValue(
              shipmentScanner,
              "soundEnabled",
              "config.shipmentScanner",
              issues,
            ),
            camera:
              shipmentScannerCamera === undefined
                ? { enabled: false, deviceId: "" }
                : {
                    enabled: booleanValue(
                      shipmentScannerCamera,
                      "enabled",
                      "config.shipmentScanner.camera",
                      issues,
                    ),
                    deviceId:
                      typeof cameraDeviceId === "string"
                        ? cameraDeviceId.trim()
                        : "",
                  },
            stateFile: text(
              shipmentScanner,
              "stateFile",
              "config.shipmentScanner",
              issues,
            ),
          };
        })();
  if (
    shipmentScannerConfig.automaticallyMarkShipped &&
    !shipmentScannerConfig.enabled
  ) {
    issues.push(
      "config.shipmentScanner must be enabled before automatic shipment changes can be enabled.",
    );
  }
  if (shipmentScannerConfig.camera.enabled && !shipmentScannerConfig.enabled) {
    issues.push(
      "config.shipmentScanner must be enabled before the background camera can be enabled.",
    );
  }
  const actionMaximumAttempts = integer(
    root,
    "actionMaximumAttempts",
    "config",
    1,
    10,
    issues,
  );
  const stateFile = text(root, "stateFile", "config", issues);
  const spoolDirectory = text(root, "spoolDirectory", "config", issues);
  const timezoneOffsetMinutes = timezoneOffset(root, issues);
  const authCookieEnv = text(
    provider,
    "authCookieEnv",
    "config.provider",
    issues,
  );
  const sellerKeyEnv = text(
    provider,
    "sellerKeyEnv",
    "config.provider",
    issues,
  );
  const pageSize = integer(
    provider,
    "pageSize",
    "config.provider",
    1,
    500,
    issues,
  );
  const maximumPages = integer(
    provider,
    "maximumPages",
    "config.provider",
    1,
    1000,
    issues,
  );
  const discordNotificationConfig: DiscordNotificationSettings =
    discordNotifications === undefined
      ? DEFAULT_DISCORD_NOTIFICATIONS
      : {
          enabled: booleanValue(
            discordNotifications,
            "enabled",
            "config.notifications.discord",
            issues,
          ),
          webhookUrlEnv: text(
            discordNotifications,
            "webhookUrlEnv",
            "config.notifications.discord",
            issues,
          ),
          events:
            discordEvents === undefined
              ? DEFAULT_DISCORD_NOTIFICATIONS.events
              : {
                  authenticationRequired: booleanValue(
                    discordEvents,
                    "authenticationRequired",
                    "config.notifications.discord.events",
                    issues,
                  ),
                  inboundMessage: booleanValue(
                    discordEvents,
                    "inboundMessage",
                    "config.notifications.discord.events",
                    issues,
                  ),
                  orderCanceled: booleanValue(
                    discordEvents,
                    "orderCanceled",
                    "config.notifications.discord.events",
                    issues,
                  ),
                  shipmentMarkAttempt: booleanValue(
                    discordEvents,
                    "shipmentMarkAttempt",
                    "config.notifications.discord.events",
                    issues,
                  ),
                },
        };
  const priceUpdateQueueConfig: PriceUpdateQueueConfig = {
    enabled: booleanValue(
      priceUpdateQueue,
      "enabled",
      "config.priceUpdateQueue",
      issues,
    ),
    stateFile: text(
      priceUpdateQueue,
      "stateFile",
      "config.priceUpdateQueue",
      issues,
    ),
    delaySeconds: integer(
      priceUpdateQueue,
      "delaySeconds",
      "config.priceUpdateQueue",
      0,
      3600,
      issues,
    ),
    rateLimitDelaySeconds: integer(
      priceUpdateQueue,
      "rateLimitDelaySeconds",
      "config.priceUpdateQueue",
      30,
      86_400,
      issues,
    ),
    historyLimit: integer(
      priceUpdateQueue,
      "historyLimit",
      "config.priceUpdateQueue",
      10,
      10_000,
      issues,
    ),
  };
  const inventoryAdditionQueueConfig: InventoryAdditionQueueConfig =
    inventoryAdditionQueue === undefined
      ? {
          enabled: true,
          stateFile: ".data/inventory-additions.json",
          delaySeconds: 0,
          rateLimitDelaySeconds: 300,
          historyLimit: 500,
        }
      : {
          enabled: booleanValue(
            inventoryAdditionQueue,
            "enabled",
            "config.inventoryAdditionQueue",
            issues,
          ),
          stateFile: text(
            inventoryAdditionQueue,
            "stateFile",
            "config.inventoryAdditionQueue",
            issues,
          ),
          delaySeconds: integer(
            inventoryAdditionQueue,
            "delaySeconds",
            "config.inventoryAdditionQueue",
            0,
            3600,
            issues,
          ),
          rateLimitDelaySeconds: integer(
            inventoryAdditionQueue,
            "rateLimitDelaySeconds",
            "config.inventoryAdditionQueue",
            30,
            86_400,
            issues,
          ),
          historyLimit: integer(
            inventoryAdditionQueue,
            "historyLimit",
            "config.inventoryAdditionQueue",
            10,
            10_000,
            issues,
          ),
        };

  const effectiveActions = disableLegacySideEffects
    ? Object.fromEntries<ActionConfig>(
        Object.entries(actions).map(([actionId, action]) => [
          actionId,
          { ...action, enabled: false },
        ]),
      )
    : actions;
  const effectivePriceUpdateQueueConfig = disableLegacySideEffects
    ? { ...priceUpdateQueueConfig, enabled: false }
    : priceUpdateQueueConfig;
  const effectiveInventoryAdditionQueueConfig = disableLegacySideEffects
    ? { ...inventoryAdditionQueueConfig, enabled: false }
    : inventoryAdditionQueueConfig;
  const effectiveShipmentScannerConfig = disableLegacySideEffects
    ? {
        ...shipmentScannerConfig,
        enabled: false,
        automaticallyMarkShipped: false,
      }
    : shipmentScannerConfig;

  const activePrinterIds = new Set(
    Object.values(effectiveActions)
      .filter((action) => action.enabled !== false)
      .map((action) => action.printer),
  );
  if (
    Object.entries(printers).some(
      ([printerId, printer]) =>
        activePrinterIds.has(printerId) &&
        (printer.adapter === "command"
          ? printer.executable.startsWith("CHANGE_ME") ||
            printer.printerName.startsWith("CHANGE_ME")
          : printer.printerName.startsWith("CHANGE_ME")),
    )
  ) {
    issues.push(
      "Live printing requires configured printer names and command executable paths.",
    );
  }

  if (issues.length > 0) throw new ConfigurationError(issues);
  return {
    version: CURRENT_CONFIG_VERSION,
    pricingProfileDefaultsVersion: 1,
    pollIntervalMinutes,
    confirmBeforeMarkingShipped,
    masterPullList: masterPullListConfig,
    shipmentScanner: effectiveShipmentScannerConfig,
    actionMaximumAttempts,
    stateFile,
    spoolDirectory,
    timezoneOffsetMinutes,
    priceUpdateQueue: effectivePriceUpdateQueueConfig,
    inventoryAdditionQueue: effectiveInventoryAdditionQueueConfig,
    merchandiseProfiles,
    defaultMerchandiseProfileId,
    repricingProfiles,
    defaultRepricingProfileId,
    notifications: { discord: discordNotificationConfig },
    provider: {
      type: "tcgplayer",
      authCookieEnv,
      sellerKeyEnv,
      pageSize,
      maximumPages,
    },
    printers,
    actions: effectiveActions,
    rules,
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  } catch {
    throw new ConfigurationError([
      `Unable to read valid JSON configuration at ${absolutePath}.`,
    ]);
  }
  return parseConfig(parsed);
}
