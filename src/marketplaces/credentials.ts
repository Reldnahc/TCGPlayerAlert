import { ApplicationError } from "../errors.js";
import type { TextSecretStore } from "../credential-store.js";
import { parseConnectionId } from "./identity.js";
import type {
  MarketplaceConnectionSetup,
  MarketplaceCredentialField,
  ProviderSecretAccess,
} from "./registry.js";

interface StoredMarketplaceCredentials {
  readonly version: 1;
  readonly connections: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

export interface MarketplaceCredentialFieldStatus {
  readonly id: string;
  readonly label: string;
  readonly inputType: MarketplaceCredentialField["inputType"];
  readonly configured: boolean;
  readonly source?: "settings" | "environment";
}

export interface MarketplaceCredentialStatus {
  readonly connectionId: string;
  readonly configured: boolean;
  readonly protectedStorage: boolean;
  readonly fields: readonly MarketplaceCredentialFieldStatus[];
}

export class MarketplaceCredentialManager implements ProviderSecretAccess {
  private initialized = false;
  private connections: Record<string, Record<string, string>> = {};
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: TextSecretStore,
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const serialized = await this.store.load();
    this.connections =
      serialized === undefined
        ? {}
        : mutableConnections(parseStoredCredentials(serialized).connections);
    this.initialized = true;
  }

  get(reference: string): string | undefined {
    this.assertInitialized();
    return normalizedSecret(this.environment[reference]);
  }

  forConnection(connectionId: string): ProviderSecretAccess {
    const normalizedConnectionId = parseConnectionId(connectionId);
    return {
      get: (reference) =>
        normalizedSecret(
          this.connections[normalizedConnectionId]?.[reference],
        ) ?? normalizedSecret(this.environment[reference]),
    };
  }

  status(
    connectionId: string,
    setup: MarketplaceConnectionSetup,
  ): MarketplaceCredentialStatus {
    this.assertInitialized();
    const normalizedConnectionId = parseConnectionId(connectionId);
    const fields = managedFields(setup).map((field) => {
      const stored = normalizedSecret(
        this.connections[normalizedConnectionId]?.[field.secretReference],
      );
      const environment = normalizedSecret(
        this.environment[field.secretReference],
      );
      return {
        id: field.id,
        label: field.label,
        inputType: field.inputType,
        configured: stored !== undefined || environment !== undefined,
        ...(stored !== undefined
          ? { source: "settings" as const }
          : environment !== undefined
            ? { source: "environment" as const }
            : {}),
      };
    });
    return {
      connectionId: normalizedConnectionId,
      configured:
        fields.length > 0 && fields.every((field) => field.configured),
      protectedStorage: this.store.available,
      fields,
    };
  }

  connect(
    connectionId: string,
    setup: MarketplaceConnectionSetup,
    values: Readonly<Record<string, string>>,
  ): Promise<MarketplaceCredentialStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      if (!this.store.available) {
        throw new ApplicationError(
          "CONFIGURATION_ERROR",
          "Protected marketplace credential storage is unavailable on this operating system.",
        );
      }
      const normalizedConnectionId = parseConnectionId(connectionId);
      const fields = managedFields(setup);
      const expectedIds = new Set(fields.map((field) => field.id));
      if (
        Object.keys(values).length !== fields.length ||
        Object.keys(values).some((id) => !expectedIds.has(id))
      ) {
        throw invalidCredentials();
      }
      const stored: Record<string, string> = {};
      for (const field of fields) {
        const value = normalizedSecret(values[field.id]);
        if (
          value === undefined ||
          value.length > 8_192 ||
          (field.inputType === "email" && !validEmail(value))
        ) {
          throw invalidCredentials();
        }
        stored[field.secretReference] = value;
      }
      const next = { ...this.connections, [normalizedConnectionId]: stored };
      await this.persist(next);
      this.connections = next;
      return this.status(normalizedConnectionId, setup);
    });
  }

  disconnect(
    connectionId: string,
    setup: MarketplaceConnectionSetup,
  ): Promise<MarketplaceCredentialStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const normalizedConnectionId = parseConnectionId(connectionId);
      const next = Object.fromEntries(
        Object.entries(this.connections).filter(
          ([candidate]) => candidate !== normalizedConnectionId,
        ),
      );
      if (this.store.available) await this.persist(next);
      this.connections = next;
      return this.status(normalizedConnectionId, setup);
    });
  }

  private persist(
    connections: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): Promise<void> {
    return this.store.save(
      JSON.stringify({
        version: 1,
        connections,
      } satisfies StoredMarketplaceCredentials),
    );
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "MarketplaceCredentialManager must be initialized first.",
      );
    }
  }
}

function managedFields(
  setup: MarketplaceConnectionSetup,
): readonly MarketplaceCredentialField[] {
  if (setup.kind !== "managed-credentials") {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "This marketplace connection does not use managed credentials.",
    );
  }
  return setup.credentialFields;
}

function parseStoredCredentials(
  serialized: string,
): StoredMarketplaceCredentials {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw invalidStoredCredentials(error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidStoredCredentials();
  }
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 ||
    typeof source.connections !== "object" ||
    source.connections === null ||
    Array.isArray(source.connections)
  ) {
    throw invalidStoredCredentials();
  }
  const connections: Record<string, Record<string, string>> = {};
  for (const [connectionId, rawCredentials] of Object.entries(
    source.connections,
  )) {
    try {
      parseConnectionId(connectionId);
    } catch (error) {
      throw invalidStoredCredentials(error);
    }
    if (
      typeof rawCredentials !== "object" ||
      rawCredentials === null ||
      Array.isArray(rawCredentials)
    ) {
      throw invalidStoredCredentials();
    }
    const credentials: Record<string, string> = {};
    const credentialEntries = Object.entries(
      rawCredentials as Record<string, unknown>,
    );
    for (const [reference, rawValue] of credentialEntries) {
      if (
        !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference) ||
        typeof rawValue !== "string" ||
        normalizedSecret(rawValue) === undefined ||
        rawValue.length > 8_192
      ) {
        throw invalidStoredCredentials();
      }
      credentials[reference] = rawValue.trim();
    }
    connections[connectionId] = credentials;
  }
  return { version: 1, connections };
}

function mutableConnections(
  connections: StoredMarketplaceCredentials["connections"],
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(connections).map(([connectionId, values]) => [
      connectionId,
      { ...values },
    ]),
  );
}

function normalizedSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function validEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function invalidCredentials(): ApplicationError {
  return new ApplicationError(
    "CONFIGURATION_ERROR",
    "Enter a valid value for every marketplace credential field.",
  );
}

function invalidStoredCredentials(cause?: unknown): ApplicationError {
  return new ApplicationError(
    "PERSISTENCE_ERROR",
    "Protected marketplace credentials could not be validated.",
    { ...(cause === undefined ? {} : { cause }) },
  );
}
