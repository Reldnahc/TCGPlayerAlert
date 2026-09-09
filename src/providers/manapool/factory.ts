import {
  createManaPoolSellerClient,
  isManaPoolApiError,
  type ManaPoolSellerClient,
} from "manapool-seller-api";
import type { OrderPagingSettings } from "../../marketplaces/order-query.js";
import type {
  ConnectionHealthProbe,
  ProviderAdapterFactory,
  ProviderFactoryContext,
} from "../../marketplaces/registry.js";
import { MarketplaceValidationError } from "../../marketplaces/identity.js";
import { ManaPoolFulfillmentMutator } from "./fulfillment.js";
import {
  ManaPoolOrderDetailReader,
  ManaPoolOrderPageReader,
} from "./orders.js";
import {
  ManaPoolInventoryFacet,
  type ManaPoolInventoryClient,
} from "./inventory.js";
import {
  ManaPoolListingQuoteReader,
  type ManaPoolListingQuoteClient,
} from "./listing-quotes.js";

export type ManaPoolAdapterClient = Pick<
  ManaPoolSellerClient,
  | "getAccount"
  | "listSellerOrders"
  | "getSellerOrder"
  | "updateSellerOrderFulfillment"
> &
  Partial<ManaPoolInventoryClient> &
  Partial<ManaPoolListingQuoteClient>;

export interface ManaPoolAdapterSettings extends OrderPagingSettings {
  readonly emailEnv: string;
  readonly accessTokenEnv: string;
  readonly detailConcurrency: number;
}

export interface ManaPoolAdapterFactoryOptions {
  readonly client?: ManaPoolAdapterClient;
  readonly credentialsPresent?: () => boolean;
}

export function createManaPoolAdapterFactory(
  options: ManaPoolAdapterFactoryOptions = {},
): ProviderAdapterFactory {
  if (
    options.client !== undefined &&
    options.credentialsPresent === undefined
  ) {
    throw new MarketplaceValidationError(
      "An injected ManaPool client requires credential-state access.",
    );
  }
  const inventorySupported =
    options.client === undefined || hasInventoryClient(options.client);
  const listingQuotesSupported =
    options.client === undefined || hasListingQuoteClient(options.client);
  return {
    providerId: "manapool",
    providerLabel: "ManaPool",
    supportedFacets: [
      "order-pages",
      "order-details",
      "fulfillment",
      ...(inventorySupported
        ? ([
            "inventory-reader",
            "inventory-mutator",
            "inventory-publisher",
          ] as const)
        : []),
      ...(listingQuotesSupported ? (["listing-quotes"] as const) : []),
    ],
    create(context) {
      const settings = parseManaPoolAdapterSettings(context.settings);
      const client = options.client ?? environmentClient(context, settings);
      const credentialsPresent =
        options.credentialsPresent ??
        (() =>
          presentSecret(context.secrets.get(settings.emailEnv)) &&
          presentSecret(context.secrets.get(settings.accessTokenEnv)));
      const inventory = hasInventoryClient(client)
        ? new ManaPoolInventoryFacet(client, context.connectionId)
        : undefined;
      return {
        descriptor: {
          connectionId: context.connectionId,
          providerId: "manapool",
          providerLabel: "ManaPool",
          connectionLabel: context.connectionLabel,
        },
        setup: {
          kind: "managed-credentials",
          credentialFields: [
            {
              id: "email",
              label: "Seller email",
              inputType: "email",
              secretReference: settings.emailEnv,
            },
            {
              id: "access-token",
              label: "Seller API code",
              inputType: "password",
              secretReference: settings.accessTokenEnv,
            },
          ],
          secretEnvironmentNames: [settings.emailEnv, settings.accessTokenEnv],
          restartRequired: false,
        },
        health: manaPoolHealth(client, credentialsPresent, context.now),
        facets: {
          orderPages: new ManaPoolOrderPageReader(
            client,
            context.connectionId,
            settings.detailConcurrency,
          ),
          orderDetails: new ManaPoolOrderDetailReader(
            client,
            context.connectionId,
          ),
          fulfillment: new ManaPoolFulfillmentMutator(
            client,
            context.connectionId,
          ),
          ...(inventory === undefined
            ? {}
            : {
                inventoryReader: inventory,
                inventoryMutator: inventory,
                inventoryPublisher: inventory,
              }),
          ...(hasListingQuoteClient(client)
            ? { listingQuotes: new ManaPoolListingQuoteReader(client) }
            : {}),
        },
      };
    },
  };
}

export function parseManaPoolAdapterSettings(
  value: unknown,
): ManaPoolAdapterSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplaceValidationError(
      "The ManaPool connection settings are invalid.",
    );
  }
  const settings = value as Record<string, unknown>;
  const expected = new Set([
    "emailEnv",
    "accessTokenEnv",
    "pageSize",
    "maximumPages",
    "detailConcurrency",
  ]);
  if (Object.keys(settings).some((key) => !expected.has(key))) {
    throw new MarketplaceValidationError(
      "The ManaPool connection settings contain unknown fields.",
    );
  }
  return {
    emailEnv: environmentName(settings.emailEnv),
    accessTokenEnv: environmentName(settings.accessTokenEnv),
    pageSize: boundedInteger(settings.pageSize, 1, 500, "paging"),
    maximumPages: boundedInteger(settings.maximumPages, 1, 1_000, "paging"),
    detailConcurrency:
      settings.detailConcurrency === undefined
        ? 5
        : boundedInteger(settings.detailConcurrency, 1, 20, "concurrency"),
  };
}

function environmentClient(
  context: ProviderFactoryContext,
  settings: ManaPoolAdapterSettings,
): ManaPoolAdapterClient {
  let cached:
    | {
        readonly email: string;
        readonly accessToken: string;
        readonly client: ManaPoolSellerClient;
      }
    | undefined;
  const resolve = (): ManaPoolSellerClient => {
    const email = requiredSecret(context.secrets.get(settings.emailEnv));
    const accessToken = requiredSecret(
      context.secrets.get(settings.accessTokenEnv),
    );
    if (cached?.email === email && cached.accessToken === accessToken) {
      return cached.client;
    }
    const client = createManaPoolSellerClient({ email, accessToken });
    cached = { email, accessToken, client };
    return client;
  };
  return {
    getAccount: (...input) => resolve().getAccount(...input),
    listSellerOrders: (...input) => resolve().listSellerOrders(...input),
    getSellerOrder: (...input) => resolve().getSellerOrder(...input),
    updateSellerOrderFulfillment: (...input) =>
      resolve().updateSellerOrderFulfillment(...input),
    listSellerInventory: (...input) => resolve().listSellerInventory(...input),
    getSellerInventoryByTcgplayerSku: (...input) =>
      resolve().getSellerInventoryByTcgplayerSku(...input),
    updateSellerInventoryByTcgplayerSku: (...input) =>
      resolve().updateSellerInventoryByTcgplayerSku(...input),
    setSellerInventoryByTcgplayerSkus: (...input) =>
      resolve().setSellerInventoryByTcgplayerSkus(...input),
    lookupSinglesByTcgplayerSkus: (...input) =>
      resolve().lookupSinglesByTcgplayerSkus(...input),
  };
}

function hasInventoryClient(
  client: ManaPoolAdapterClient,
): client is ManaPoolAdapterClient & ManaPoolInventoryClient {
  return (
    typeof client.listSellerInventory === "function" &&
    typeof client.getSellerInventoryByTcgplayerSku === "function" &&
    typeof client.updateSellerInventoryByTcgplayerSku === "function" &&
    typeof client.setSellerInventoryByTcgplayerSkus === "function"
  );
}

function hasListingQuoteClient(
  client: ManaPoolAdapterClient,
): client is ManaPoolAdapterClient & ManaPoolListingQuoteClient {
  return typeof client.lookupSinglesByTcgplayerSkus === "function";
}

function manaPoolHealth(
  client: ManaPoolAdapterClient,
  credentialsPresent: () => boolean,
  now: () => Date,
): ConnectionHealthProbe {
  return {
    async checkHealth(signal?: AbortSignal) {
      const checkedAt = now().toISOString();
      if (!credentialsPresent()) {
        return {
          state: "not-configured",
          checkedAt,
          issueCode: "NOT_CONFIGURED",
          retryable: false,
        };
      }
      try {
        await client.getAccount(signal === undefined ? undefined : { signal });
        return { state: "connected", checkedAt };
      } catch (error) {
        if (isManaPoolApiError(error)) {
          if (error.code === "AUTHENTICATION_REQUIRED") {
            return {
              state: "authentication-required",
              checkedAt,
              issueCode: "AUTHENTICATION_REQUIRED",
              retryable: false,
            };
          }
          return {
            state: "unavailable",
            checkedAt,
            issueCode: "HEALTH_CHECK_FAILED",
            retryable: error.retryable,
          };
        }
        return {
          state: "unavailable",
          checkedAt,
          issueCode: "HEALTH_CHECK_FAILED",
          retryable: true,
        };
      }
    },
  };
}

function environmentName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new MarketplaceValidationError(
      "The ManaPool credential environment name is invalid.",
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new MarketplaceValidationError(
      `The ManaPool ${label} settings are invalid.`,
    );
  }
  return Number(value);
}

function presentSecret(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function requiredSecret(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new MarketplaceValidationError(
      "The ManaPool credentials are unavailable.",
    );
  }
  return value.trim();
}
