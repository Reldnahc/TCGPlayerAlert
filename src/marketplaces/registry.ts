import {
  parseConnectionDescriptor,
  type CatalogMetadataReader,
  type ConnectionHealth,
  type FulfillmentMutator,
  type InventoryMutator,
  type InventoryPublisher,
  type ListingQuoteReader,
  type InventoryReader,
  type MarketplaceConnectionDescriptor,
  type NativeOrderDocumentSource,
  type OrderDetailReader,
  type OrderPageReader,
  type PullLineReader,
  type RefundProvider,
} from "./contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
  parseProviderId,
} from "./identity.js";

export type MarketplaceFacetId =
  | "order-pages"
  | "order-details"
  | "fulfillment"
  | "refunds"
  | "native-documents"
  | "pull-lines"
  | "inventory-reader"
  | "inventory-mutator"
  | "inventory-publisher"
  | "listing-quotes"
  | "inventory-additions"
  | "catalog-metadata"
  | "catalog-search"
  | "repricing"
  | "payments"
  | "messages"
  | "feedback";

const MARKETPLACE_FACET_IDS = new Set<MarketplaceFacetId>([
  "order-pages",
  "order-details",
  "fulfillment",
  "refunds",
  "native-documents",
  "pull-lines",
  "inventory-reader",
  "inventory-mutator",
  "inventory-publisher",
  "listing-quotes",
  "inventory-additions",
  "catalog-metadata",
  "catalog-search",
  "repricing",
  "payments",
  "messages",
  "feedback",
]);

export interface ProviderWorkspaceFacet {
  readonly kind:
    | "catalog-search"
    | "inventory-additions"
    | "repricing"
    | "payments"
    | "messages"
    | "feedback";
}

export interface ConnectionHealthProbe {
  checkHealth(signal?: AbortSignal): Promise<ConnectionHealth>;
}

export interface MarketplaceCredentialField {
  readonly id: string;
  readonly label: string;
  readonly inputType: "email" | "password";
  readonly secretReference: string;
}

export type MarketplaceConnectionSetup =
  | {
      readonly kind: "browser-session";
      readonly secretEnvironmentNames: readonly string[];
      readonly restartRequired: boolean;
    }
  | {
      readonly kind: "managed-credentials";
      readonly credentialFields: readonly MarketplaceCredentialField[];
      readonly secretEnvironmentNames: readonly string[];
      readonly restartRequired: false;
    }
  | {
      readonly kind: "environment";
      readonly secretEnvironmentNames: readonly string[];
      readonly restartRequired: boolean;
    };

export interface MarketplaceFacets {
  readonly orderPages?: OrderPageReader;
  readonly orderDetails?: OrderDetailReader;
  readonly fulfillment?: FulfillmentMutator;
  readonly refunds?: RefundProvider;
  readonly nativeDocuments?: NativeOrderDocumentSource;
  readonly pullLines?: PullLineReader;
  readonly inventoryReader?: InventoryReader;
  readonly inventoryMutator?: InventoryMutator;
  readonly inventoryPublisher?: InventoryPublisher;
  readonly listingQuotes?: ListingQuoteReader;
  readonly inventoryAdditions?: ProviderWorkspaceFacet;
  readonly catalogMetadata?: CatalogMetadataReader;
  readonly catalogSearch?: ProviderWorkspaceFacet;
  readonly repricing?: ProviderWorkspaceFacet;
  readonly payments?: ProviderWorkspaceFacet;
  readonly messages?: ProviderWorkspaceFacet;
  readonly feedback?: ProviderWorkspaceFacet;
}

export interface MarketplaceConnection {
  readonly descriptor: MarketplaceConnectionDescriptor;
  readonly setup?: MarketplaceConnectionSetup;
  readonly health: ConnectionHealthProbe;
  readonly facets: MarketplaceFacets;
}

export interface ProviderSecretAccess {
  get(reference: string): string | undefined;
  forConnection?(connectionId: string): ProviderSecretAccess;
}

export interface ProviderFactoryContext {
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly settings: unknown;
  readonly secrets: ProviderSecretAccess;
  readonly now: () => Date;
}

export interface ProviderAdapterFactory {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly supportedFacets: readonly MarketplaceFacetId[];
  create(context: ProviderFactoryContext): MarketplaceConnection;
}

export interface ConfiguredMarketplaceConnection {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly settings: unknown;
}

export interface ConfiguredConnectionStatus {
  readonly descriptor: MarketplaceConnectionDescriptor;
  readonly enabled: boolean;
  readonly supportedFacets: readonly MarketplaceFacetId[];
  readonly setup?: MarketplaceConnectionSetup;
}

export class ProviderAdapterRegistry {
  private readonly factories: ReadonlyMap<string, ProviderAdapterFactory>;

  constructor(factories: readonly ProviderAdapterFactory[]) {
    const byId = new Map<string, ProviderAdapterFactory>();
    for (const factory of factories) {
      const providerId = parseProviderId(factory.providerId);
      if (byId.has(providerId)) {
        throw new MarketplaceValidationError(
          "A provider adapter ID is duplicated.",
        );
      }
      if (
        factory.providerLabel.trim().length === 0 ||
        factory.providerLabel.length > 128 ||
        /\p{Cc}/u.test(factory.providerLabel)
      ) {
        throw new MarketplaceValidationError(
          "A provider adapter label is invalid.",
        );
      }
      if (
        new Set(factory.supportedFacets).size !==
          factory.supportedFacets.length ||
        factory.supportedFacets.some(
          (facet) => !MARKETPLACE_FACET_IDS.has(facet),
        )
      ) {
        throw new MarketplaceValidationError("Provider facets must be unique.");
      }
      byId.set(providerId, Object.freeze(factory));
    }
    this.factories = byId;
  }

  get(providerId: string): ProviderAdapterFactory | undefined {
    return this.factories.get(parseProviderId(providerId));
  }

  require(providerId: string): ProviderAdapterFactory {
    const factory = this.get(providerId);
    if (factory === undefined) {
      throw new MarketplaceValidationError(
        "The configured provider adapter is not installed.",
      );
    }
    return factory;
  }

  list(): readonly ProviderAdapterFactory[] {
    return [...this.factories.values()];
  }
}

export class MarketplaceConnectionRegistry {
  private readonly active = new Map<string, MarketplaceConnection>();
  private readonly statuses: readonly ConfiguredConnectionStatus[];

  constructor(options: {
    readonly adapters: ProviderAdapterRegistry;
    readonly connections: Readonly<
      Record<string, ConfiguredMarketplaceConnection>
    >;
    readonly secrets: ProviderSecretAccess;
    readonly now?: () => Date;
  }) {
    const now = options.now ?? (() => new Date());
    const statuses: ConfiguredConnectionStatus[] = [];
    for (const [rawConnectionId, configured] of Object.entries(
      options.connections,
    )) {
      const connectionId = parseConnectionId(rawConnectionId);
      const providerId = parseProviderId(configured.providerId);
      const factory = configured.enabled
        ? options.adapters.require(providerId)
        : options.adapters.get(providerId);
      const providerLabel = factory?.providerLabel ?? providerId;
      const descriptor = Object.freeze(
        parseConnectionDescriptor({
          connectionId,
          providerId,
          providerLabel,
          connectionLabel: configured.label,
        }),
      );
      if (!configured.enabled) {
        statuses.push(
          Object.freeze({
            descriptor,
            enabled: false,
            supportedFacets: Object.freeze([
              ...(factory?.supportedFacets ?? []),
            ]),
          }),
        );
        continue;
      }
      if (this.active.has(connectionId)) {
        throw new MarketplaceValidationError(
          "A marketplace connection ID is duplicated.",
        );
      }
      const connection = factory?.create({
        connectionId,
        connectionLabel: configured.label,
        settings: configured.settings,
        secrets:
          options.secrets.forConnection?.(connectionId) ?? options.secrets,
        now,
      });
      if (connection === undefined) {
        throw new MarketplaceValidationError(
          "The marketplace connection could not be created.",
        );
      }
      const actual = parseConnectionDescriptor(connection.descriptor);
      if (
        actual.connectionId !== descriptor.connectionId ||
        actual.providerId !== descriptor.providerId ||
        actual.providerLabel !== descriptor.providerLabel ||
        actual.connectionLabel !== descriptor.connectionLabel
      ) {
        throw new MarketplaceValidationError(
          "A provider factory returned the wrong descriptor.",
        );
      }
      const setup =
        connection.setup === undefined
          ? undefined
          : Object.freeze(parseMarketplaceConnectionSetup(connection.setup));
      statuses.push(
        Object.freeze({
          descriptor,
          enabled: true,
          supportedFacets: Object.freeze([...(factory?.supportedFacets ?? [])]),
          ...(setup === undefined ? {} : { setup }),
        }),
      );
      this.active.set(
        connectionId,
        Object.freeze({
          descriptor: Object.freeze(actual),
          ...(setup === undefined ? {} : { setup }),
          health: connection.health,
          facets: Object.freeze({ ...connection.facets }),
        }),
      );
    }
    this.statuses = Object.freeze(
      statuses.sort((left, right) =>
        left.descriptor.connectionId.localeCompare(
          right.descriptor.connectionId,
        ),
      ),
    );
  }

  list(): readonly MarketplaceConnection[] {
    return [...this.active.values()];
  }

  statusDescriptors(): readonly ConfiguredConnectionStatus[] {
    return this.statuses;
  }

  get(connectionId: string): MarketplaceConnection | undefined {
    return this.active.get(parseConnectionId(connectionId));
  }

  require(connectionId: string): MarketplaceConnection {
    const connection = this.get(connectionId);
    if (connection === undefined) {
      throw new MarketplaceValidationError(
        "The marketplace connection is unknown or disabled.",
      );
    }
    return connection;
  }

  facet<K extends keyof MarketplaceFacets>(
    connectionId: string,
    facet: K,
  ): NonNullable<MarketplaceFacets[K]> {
    const value = this.require(connectionId).facets[facet];
    if (value === undefined) {
      throw new MarketplaceValidationError(
        "The marketplace facet is unsupported.",
      );
    }
    return value;
  }
}

export function parseMarketplaceConnectionSetup(
  value: unknown,
): MarketplaceConnectionSetup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplaceValidationError(
      "The marketplace connection setup metadata is invalid.",
    );
  }
  const source = value as Record<string, unknown>;
  if (
    source.kind !== "browser-session" &&
    source.kind !== "managed-credentials" &&
    source.kind !== "environment"
  ) {
    throw new MarketplaceValidationError(
      "The marketplace connection setup kind is invalid.",
    );
  }
  const rawSecretEnvironmentNames = source.secretEnvironmentNames;
  const secretEnvironmentNames = Array.isArray(rawSecretEnvironmentNames)
    ? rawSecretEnvironmentNames.filter(
        (name): name is string => typeof name === "string",
      )
    : [];
  if (
    !Array.isArray(rawSecretEnvironmentNames) ||
    rawSecretEnvironmentNames.length > 16 ||
    secretEnvironmentNames.length !== rawSecretEnvironmentNames.length ||
    secretEnvironmentNames.some(
      (name) => !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name),
    ) ||
    new Set(secretEnvironmentNames).size !== secretEnvironmentNames.length
  ) {
    throw new MarketplaceValidationError(
      "The marketplace connection secret references are invalid.",
    );
  }
  if (typeof source.restartRequired !== "boolean") {
    throw new MarketplaceValidationError(
      "The marketplace connection restart requirement is invalid.",
    );
  }
  if (source.kind === "managed-credentials") {
    const fields = parseCredentialFields(source.credentialFields);
    if (source.restartRequired) {
      throw new MarketplaceValidationError(
        "Managed marketplace credentials must apply without a restart.",
      );
    }
    return {
      kind: "managed-credentials",
      credentialFields: fields,
      secretEnvironmentNames,
      restartRequired: false,
    };
  }
  return {
    kind: source.kind,
    secretEnvironmentNames,
    restartRequired: source.restartRequired,
  };
}

function parseCredentialFields(
  value: unknown,
): readonly MarketplaceCredentialField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new MarketplaceValidationError(
      "The marketplace credential fields are invalid.",
    );
  }
  const fields = value.map((candidate): MarketplaceCredentialField => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new MarketplaceValidationError(
        "A marketplace credential field is invalid.",
      );
    }
    const field = candidate as Record<string, unknown>;
    if (
      typeof field.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(field.id) ||
      typeof field.label !== "string" ||
      field.label.trim() === "" ||
      field.label.length > 128 ||
      /\p{Cc}/u.test(field.label) ||
      (field.inputType !== "email" && field.inputType !== "password") ||
      typeof field.secretReference !== "string" ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(field.secretReference)
    ) {
      throw new MarketplaceValidationError(
        "A marketplace credential field is invalid.",
      );
    }
    return {
      id: field.id,
      label: field.label,
      inputType: field.inputType,
      secretReference: field.secretReference,
    };
  });
  if (
    new Set(fields.map((field) => field.id)).size !== fields.length ||
    new Set(fields.map((field) => field.secretReference)).size !== fields.length
  ) {
    throw new MarketplaceValidationError(
      "Marketplace credential fields must be unique.",
    );
  }
  return Object.freeze(fields);
}

export const environmentSecretAccess = (
  environment: Readonly<Record<string, string | undefined>>,
): ProviderSecretAccess => ({
  get(reference: string): string | undefined {
    return environment[reference];
  },
});
