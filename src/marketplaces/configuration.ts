import { ConfigurationError } from "../errors.js";
import { parseConnectionId, parseProviderId } from "./identity.js";
import type { ConfiguredMarketplaceConnection } from "./registry.js";

export const MARKETPLACE_CONFIG_VERSION = 6 as const;
export const DEFAULT_SYNCHRONIZATION_CONCURRENCY = 2;

export interface MarketplaceProvidersConfiguration {
  readonly synchronizationConcurrency: number;
  readonly connections: Readonly<
    Record<string, ConfiguredMarketplaceConnection>
  >;
}

export interface ParsedMarketplaceConfiguration {
  readonly version: typeof MARKETPLACE_CONFIG_VERSION;
  readonly providers: MarketplaceProvidersConfiguration;
  readonly migratedFromVersion?: 5;
}

export function parseMarketplaceConfiguration(
  value: unknown,
  options: {
    readonly providerLabel: (providerId: string) => string;
  },
): ParsedMarketplaceConfiguration {
  const root = requiredRecord(value, "config");
  if (root.version === 5) {
    const provider = requiredRecord(root.provider, "config.provider");
    const providerId = parseProviderId(provider.type);
    const connectionId = parseConnectionId(`${providerId}-main`);
    const settings = { ...provider };
    Reflect.deleteProperty(settings, "type");
    return {
      version: MARKETPLACE_CONFIG_VERSION,
      migratedFromVersion: 5,
      providers: {
        synchronizationConcurrency: DEFAULT_SYNCHRONIZATION_CONCURRENCY,
        connections: {
          [connectionId]: {
            providerId,
            enabled: true,
            label: safeText(
              options.providerLabel(providerId),
              "provider label",
              128,
            ),
            settings: Object.freeze(settings),
          },
        },
      },
    };
  }
  if (root.version !== MARKETPLACE_CONFIG_VERSION) {
    throw new ConfigurationError([
      `config.version must be 5 or ${String(MARKETPLACE_CONFIG_VERSION)} for marketplace migration.`,
    ]);
  }
  const providers = requiredRecord(root.providers, "config.providers");
  const synchronizationConcurrency = boundedInteger(
    providers.synchronizationConcurrency,
    "config.providers.synchronizationConcurrency",
    1,
    8,
  );
  const rawConnections = requiredRecord(
    providers.connections,
    "config.providers.connections",
  );
  if (Object.keys(rawConnections).length > 64) {
    throw new ConfigurationError([
      "config.providers.connections may contain at most 64 connections.",
    ]);
  }
  const connections: Record<string, ConfiguredMarketplaceConnection> = {};
  for (const [rawConnectionId, value] of Object.entries(rawConnections)) {
    const connectionId = parseConnectionId(rawConnectionId);
    const connection = requiredRecord(
      value,
      `config.providers.connections.${rawConnectionId}`,
    );
    const unknownKeys = Object.keys(connection).filter(
      (key) => !["providerId", "enabled", "label", "settings"].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new ConfigurationError([
        `config.providers.connections.${rawConnectionId} contains unknown fields.`,
      ]);
    }
    if (typeof connection.enabled !== "boolean") {
      throw new ConfigurationError([
        `config.providers.connections.${rawConnectionId}.enabled must be a boolean.`,
      ]);
    }
    connections[connectionId] = {
      providerId: parseProviderId(connection.providerId),
      enabled: connection.enabled,
      label: safeText(
        connection.label,
        `config.providers.connections.${rawConnectionId}.label`,
        128,
      ),
      settings: Object.freeze({
        ...requiredRecord(
          connection.settings,
          `config.providers.connections.${rawConnectionId}.settings`,
        ),
      }),
    };
  }
  return {
    version: MARKETPLACE_CONFIG_VERSION,
    providers: {
      synchronizationConcurrency,
      connections: Object.freeze(connections),
    },
  };
}

export function migrateMarketplaceConfigurationDocument(
  value: unknown,
  options: { readonly providerLabel: (providerId: string) => string },
): Readonly<Record<string, unknown>> {
  const root = requiredRecord(value, "config");
  const parsed = parseMarketplaceConfiguration(root, options);
  const migrated = { ...root };
  Reflect.deleteProperty(migrated, "provider");
  return {
    ...migrated,
    version: MARKETPLACE_CONFIG_VERSION,
    providers: parsed.providers,
  };
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError([`${path} must be an object.`]);
  }
  return value as Record<string, unknown>;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new ConfigurationError([
      `${path} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    ]);
  }
  return Number(value);
}

function safeText(value: unknown, path: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ConfigurationError([`${path} must be a non-empty safe string.`]);
  }
  return value.trim();
}
