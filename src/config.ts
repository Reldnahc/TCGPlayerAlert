import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigurationError } from "./errors.js";

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

export interface AppConfig {
  readonly version: 1;
  readonly pollIntervalMinutes: number;
  readonly actionMaximumAttempts: number;
  readonly dryRun: boolean;
  readonly stateFile: string;
  readonly spoolDirectory: string;
  readonly timezoneOffsetMinutes: number | "local";
  readonly priceUpdateQueue: PriceUpdateQueueConfig;
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

export function parseConfig(value: unknown): AppConfig {
  const issues: string[] = [];
  const root = record(value);
  if (root === undefined) issues.push("config must be an object.");
  if (root?.version !== 1) issues.push("config.version must be 1.");

  const provider = record(root?.provider);
  if (provider?.type !== "tcgplayer") {
    issues.push("config.provider.type must be tcgplayer.");
  }
  const priceUpdateQueue = record(root?.priceUpdateQueue);
  if (priceUpdateQueue === undefined) {
    issues.push("config.priceUpdateQueue must be an object.");
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
  const actionMaximumAttempts = integer(
    root,
    "actionMaximumAttempts",
    "config",
    1,
    10,
    issues,
  );
  const dryRun = booleanValue(root, "dryRun", "config", issues);
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
      1,
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

  const activePrinterIds = new Set(
    Object.values(actions)
      .filter((action) => action.enabled !== false)
      .map((action) => action.printer),
  );
  if (
    !dryRun &&
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
    version: 1,
    pollIntervalMinutes,
    actionMaximumAttempts,
    dryRun,
    stateFile,
    spoolDirectory,
    timezoneOffsetMinutes,
    priceUpdateQueue: priceUpdateQueueConfig,
    provider: {
      type: "tcgplayer",
      authCookieEnv,
      sellerKeyEnv,
      pageSize,
      maximumPages,
    },
    printers,
    actions,
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
