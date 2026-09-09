import {
  createTcgplayerSellerClient,
  type TcgplayerAuthenticationRequiredHandler,
  type TcgplayerSellerClient,
  type TcgplayerSessionProvider,
} from "tcgplayer-private-api";
import type { OrderPagingSettings } from "../../marketplaces/order-query.js";
import type {
  ConnectionHealthProbe,
  ProviderAdapterFactory,
  ProviderFactoryContext,
} from "../../marketplaces/registry.js";
import { MarketplaceValidationError } from "../../marketplaces/identity.js";
import type { SellerCredentialAccess } from "../../seller-credentials.js";
import { TcgplayerNativeOrderDocumentSource } from "./documents.js";
import { TcgplayerFulfillmentMutator } from "./fulfillment.js";
import {
  TcgplayerOrderDetailReader,
  TcgplayerOrderPageReader,
} from "./normalized-orders.js";
import { TcgplayerPullLineReader } from "./pull-lines.js";
import { TcgplayerCatalogMetadataReader } from "./catalog-metadata.js";
import {
  TcgplayerInventoryFacet,
  type TcgplayerInventoryClient,
} from "./inventory.js";

export type TcgplayerAdapterClient = Pick<
  TcgplayerSellerClient,
  | "searchOrders"
  | "getOrder"
  | "detectCarrier"
  | "addOrderTracking"
  | "shipOrderWithoutTracking"
  | "getPackingSlip"
  | "exportPullSheet"
  | "searchMarketplaceProducts"
> &
  Partial<TcgplayerInventoryClient> &
  Partial<
    Pick<
      TcgplayerSellerClient,
      | "searchCatalogProducts"
      | "getCatalogProduct"
      | "getSkuMarketPrices"
      | "searchMarketplaceProductListings"
      | "getSellerPaymentExperience"
      | "listLegacySellerPayments"
      | "listLegacyUpcomingSellerPayments"
      | "listSellerPayouts"
      | "getSellerPayout"
      | "getSellerUnpaidBalance"
      | "listSellerMessageThreads"
      | "getSellerMessageThread"
      | "getSellerUnreadMessageCount"
      | "markSellerMessageThreadRead"
      | "replyToSellerMessageThread"
      | "listSellerFeedback"
      | "getSellerFeedbackAggregation"
    >
  >;

export interface TcgplayerAdapterSettings extends OrderPagingSettings {
  readonly authCookieEnv: string;
  readonly sellerKeyEnv: string;
}

export interface TcgplayerAdapterFactoryOptions {
  readonly client?: TcgplayerAdapterClient;
  readonly credentials?: SellerCredentialAccess;
  readonly timezoneOffsetMinutes: number;
}

export function createTcgplayerAdapterFactory(
  options: TcgplayerAdapterFactoryOptions,
): ProviderAdapterFactory {
  validateTimezoneOffset(options.timezoneOffsetMinutes);
  if ((options.client === undefined) !== (options.credentials === undefined)) {
    throw new MarketplaceValidationError(
      "Injected TCGplayer client and credentials must be supplied together.",
    );
  }
  const inventorySupported =
    options.client === undefined || hasInventoryClient(options.client);
  const catalogSearchSupported =
    options.client === undefined || hasCatalogSearchClient(options.client);
  const repricingSupported =
    options.client === undefined || hasRepricingClient(options.client);
  const paymentsSupported =
    options.client === undefined || hasPaymentsClient(options.client);
  const messagesSupported =
    options.client === undefined || hasMessagesClient(options.client);
  const feedbackSupported =
    options.client === undefined || hasFeedbackClient(options.client);
  return {
    providerId: "tcgplayer",
    providerLabel: "TCGplayer",
    supportedFacets: [
      "order-pages",
      "order-details",
      "fulfillment",
      "native-documents",
      "pull-lines",
      "catalog-metadata",
      ...(inventorySupported
        ? (["inventory-reader", "inventory-mutator"] as const)
        : []),
      ...(catalogSearchSupported ? (["catalog-search"] as const) : []),
      ...(catalogSearchSupported && inventorySupported
        ? (["inventory-additions"] as const)
        : []),
      ...(repricingSupported ? (["repricing"] as const) : []),
      ...(paymentsSupported ? (["payments"] as const) : []),
      ...(messagesSupported ? (["messages"] as const) : []),
      ...(feedbackSupported ? (["feedback"] as const) : []),
    ],
    create(context) {
      const settings = parseTcgplayerAdapterSettings(context.settings);
      const credentials =
        options.credentials ?? environmentCredentials(context, settings);
      const client =
        options.client ??
        createTcgplayerSellerClient({
          session: credentials.session,
          onAuthenticationRequired: credentials.onAuthenticationRequired,
        });
      const inventory = hasInventoryClient(client)
        ? new TcgplayerInventoryFacet(
            client,
            credentials.sellerKey,
            context.connectionId,
            settings.maximumPages,
          )
        : undefined;
      return {
        descriptor: {
          connectionId: context.connectionId,
          providerId: "tcgplayer",
          providerLabel: "TCGplayer",
          connectionLabel: context.connectionLabel,
        },
        setup: {
          kind: "browser-session",
          secretEnvironmentNames: [
            settings.authCookieEnv,
            settings.sellerKeyEnv,
          ],
          restartRequired: true,
        },
        health: connectionHealth(
          credentials,
          context.now,
          options.credentials === undefined
            ? "not-configured"
            : "authentication-required",
        ),
        facets: {
          orderPages: new TcgplayerOrderPageReader(
            client,
            context.connectionId,
            credentials.sellerKey,
          ),
          orderDetails: new TcgplayerOrderDetailReader(
            client,
            context.connectionId,
          ),
          fulfillment: new TcgplayerFulfillmentMutator(
            client,
            context.connectionId,
            credentials.sellerKey,
          ),
          nativeDocuments: new TcgplayerNativeOrderDocumentSource(
            client,
            context.connectionId,
            options.timezoneOffsetMinutes,
          ),
          pullLines: new TcgplayerPullLineReader(
            client,
            context.connectionId,
            options.timezoneOffsetMinutes,
          ),
          catalogMetadata: new TcgplayerCatalogMetadataReader(client),
          ...(inventory === undefined
            ? {}
            : {
                inventoryReader: inventory,
                inventoryMutator: inventory,
              }),
          ...(catalogSearchSupported
            ? { catalogSearch: { kind: "catalog-search" as const } }
            : {}),
          ...(catalogSearchSupported && inventorySupported
            ? {
                inventoryAdditions: {
                  kind: "inventory-additions" as const,
                },
              }
            : {}),
          ...(repricingSupported
            ? { repricing: { kind: "repricing" as const } }
            : {}),
          ...(paymentsSupported
            ? { payments: { kind: "payments" as const } }
            : {}),
          ...(messagesSupported
            ? { messages: { kind: "messages" as const } }
            : {}),
          ...(feedbackSupported
            ? { feedback: { kind: "feedback" as const } }
            : {}),
        },
      };
    },
  };
}

function hasInventoryClient(
  client: TcgplayerAdapterClient,
): client is TcgplayerAdapterClient & TcgplayerInventoryClient {
  return (
    typeof client.listSellerInventory === "function" &&
    typeof client.updateSellerPrices === "function" &&
    typeof client.addSellerInventory === "function" &&
    typeof client.removeSellerInventory === "function"
  );
}

function hasCatalogSearchClient(client: TcgplayerAdapterClient): boolean {
  return (
    typeof client.searchCatalogProducts === "function" &&
    typeof client.getCatalogProduct === "function"
  );
}

function hasRepricingClient(client: TcgplayerAdapterClient): boolean {
  return (
    hasInventoryClient(client) &&
    typeof client.getSkuMarketPrices === "function" &&
    typeof client.searchMarketplaceProductListings === "function"
  );
}

function hasPaymentsClient(client: TcgplayerAdapterClient): boolean {
  return (
    typeof client.getSellerPaymentExperience === "function" &&
    typeof client.listLegacySellerPayments === "function" &&
    typeof client.listLegacyUpcomingSellerPayments === "function" &&
    typeof client.listSellerPayouts === "function" &&
    typeof client.getSellerPayout === "function" &&
    typeof client.getSellerUnpaidBalance === "function"
  );
}

function hasMessagesClient(client: TcgplayerAdapterClient): boolean {
  return (
    typeof client.listSellerMessageThreads === "function" &&
    typeof client.getSellerMessageThread === "function" &&
    typeof client.getSellerUnreadMessageCount === "function" &&
    typeof client.markSellerMessageThreadRead === "function" &&
    typeof client.replyToSellerMessageThread === "function"
  );
}

function hasFeedbackClient(client: TcgplayerAdapterClient): boolean {
  return (
    typeof client.listSellerFeedback === "function" &&
    typeof client.getSellerFeedbackAggregation === "function"
  );
}

export function parseTcgplayerAdapterSettings(
  value: unknown,
): TcgplayerAdapterSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplaceValidationError(
      "The TCGplayer connection settings are invalid.",
    );
  }
  const settings = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "authCookieEnv",
    "sellerKeyEnv",
    "pageSize",
    "maximumPages",
  ]);
  if (Object.keys(settings).some((key) => !expectedKeys.has(key))) {
    throw new MarketplaceValidationError(
      "The TCGplayer connection settings contain unknown fields.",
    );
  }
  return {
    authCookieEnv: environmentName(settings.authCookieEnv),
    sellerKeyEnv: environmentName(settings.sellerKeyEnv),
    pageSize: boundedInteger(settings.pageSize, 1, 500),
    maximumPages: boundedInteger(settings.maximumPages, 1, 1_000),
  };
}

function environmentCredentials(
  context: ProviderFactoryContext,
  settings: TcgplayerAdapterSettings,
): SellerCredentialAccess {
  const authCookie = (): string =>
    requiredSecret(context.secrets.get(settings.authCookieEnv));
  const sellerKey = (): string =>
    requiredSecret(context.secrets.get(settings.sellerKeyEnv));
  const session: TcgplayerSessionProvider = () => ({
    authCookie: authCookie(),
  });
  const onAuthenticationRequired: TcgplayerAuthenticationRequiredHandler = () =>
    undefined;
  return {
    session,
    sellerKey,
    onAuthenticationRequired,
    isConnected: () =>
      presentSecret(context.secrets.get(settings.authCookieEnv)) &&
      presentSecret(context.secrets.get(settings.sellerKeyEnv)),
  };
}

function connectionHealth(
  credentials: SellerCredentialAccess,
  now: () => Date,
  disconnectedState: "not-configured" | "authentication-required",
): ConnectionHealthProbe {
  return {
    checkHealth(signal?: AbortSignal) {
      signal?.throwIfAborted();
      const connected = credentials.isConnected();
      return Promise.resolve({
        state: connected ? "connected" : disconnectedState,
        checkedAt: now().toISOString(),
        ...(connected
          ? {}
          : {
              issueCode:
                disconnectedState === "not-configured"
                  ? "NOT_CONFIGURED"
                  : "AUTHENTICATION_REQUIRED",
              retryable: false,
            }),
      });
    },
  };
}

function environmentName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new MarketplaceValidationError(
      "The TCGplayer credential environment name is invalid.",
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new MarketplaceValidationError(
      "The TCGplayer paging settings are invalid.",
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
      "The TCGplayer credentials are unavailable.",
    );
  }
  return value.trim();
}

function validateTimezoneOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < -14 * 60 || value > 14 * 60) {
    throw new MarketplaceValidationError(
      "The TCGplayer timezone offset is invalid.",
    );
  }
}
