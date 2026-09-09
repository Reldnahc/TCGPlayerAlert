import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import {
  createTcgplayerSellerClient,
  type TcgplayerSellerClient,
} from "./providers/tcgplayer/sdk.js";
import {
  createActions,
  executeAddressLabelLines,
  executeSyntheticPrintTest,
} from "./actions.js";
import { ConfigurationError } from "./errors.js";
import type { Logger } from "./logger.js";
import { createPrinter, type Printer } from "./printing.js";
import { FulfillmentWorkflow } from "./orchestrator.js";
import { JsonStateStore } from "./state.js";
import { pullListProgressPath } from "./pull-list-progress.js";
import { JsonQualifiedPullListProgressStore } from "./fulfillment/pull-list-progress.js";
import { MasterPullListService } from "./fulfillment/pull-list.js";
import { FileSyncLease } from "./sync-lease.js";
import {
  createTcgplayerPriceUpdateExecutor,
  PriceUpdateQueueStore,
} from "./price-update-queue.js";
import { RepricingService } from "./repricing.js";
import {
  createTcgplayerInventoryAdditionExecutor,
  InventoryAdditionQueueStore,
  InventoryAdditionService,
} from "./inventory-additions.js";
import { PaymentManagementService } from "./payment-management.js";
import { FeedbackManagementService } from "./feedback-management.js";
import { MessageManagementService } from "./message-management.js";
import { createTcgplayerAdapterFactory } from "./providers/tcgplayer/factory.js";
import { primaryTcgplayerConnection } from "./providers/tcgplayer/configuration.js";
import { ConnectionHealthService } from "./marketplaces/health.js";
import { MarketplaceOrderActionService } from "./marketplaces/order-actions.js";
import type { MarketplaceOrderRuntime } from "./marketplaces/order-runtime.js";
import { MarketplaceReadyOrderSource } from "./marketplaces/ready-orders.js";
import { MarketplaceInventoryService } from "./marketplaces/inventory.js";
import {
  OrderQueryService,
  parseOrderPagingSettings,
} from "./marketplaces/order-query.js";
import {
  environmentSecretAccess,
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  type ProviderSecretAccess,
} from "./marketplaces/registry.js";
import { MarketplaceCredentialManager } from "./marketplaces/credentials.js";
import { createManaPoolAdapterFactory } from "./providers/manapool/factory.js";
import {
  OrderDocumentService,
  OrderPrintService,
  projectDocumentActions,
} from "./fulfillment/documents.js";
import {
  createPlatformCredentialStore,
  createPlatformTextSecretStore,
} from "./credential-store.js";
import {
  JsonLocalInventoryStore,
  LocalInventoryService,
  localInventoryStatePath,
} from "./local-inventory.js";
import {
  environmentSellerCredentialAccess,
  type SellerCredentialAccess,
} from "./seller-credentials.js";
import { SellerSessionManager } from "./seller-session.js";
import {
  JsonShipmentScanStore,
  ShipmentScannerService,
} from "./shipment-scanner.js";
import {
  JsonShipmentTagRegistry,
  shipmentTagAssignmentsPath,
} from "./shipment-tags.js";
import { WasmShipmentTagDetector } from "./background-april-tag-detector.js";
import { BackgroundShipmentScanner } from "./background-shipment-scanner.js";
import { NodeAvCameraCapture } from "./camera-capture.js";
import {
  createSellerApiRuntime,
  SellerRequestGovernor,
  type SellerApiRuntime,
} from "./seller-api.js";
import {
  internalJobStatePath,
  InternalJobStore,
} from "./internal-jobs/index.js";
import {
  DiscordWebhookManager,
  JsonNotificationStateStore,
  NotificationMonitor,
  NotificationService,
  type NotificationPublisher,
} from "./notifications/index.js";

export function createWorkflow(
  config: AppConfig,
  logger: Logger,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
  notifications?: NotificationPublisher,
  providerSecrets?: ProviderSecretAccess,
): FulfillmentWorkflow {
  return createMarketplaceOrderRuntime(
    config,
    environment,
    credentials,
    sellerApi,
    {
      logger,
      ...(notifications === undefined ? {} : { notifications }),
      ...(providerSecrets === undefined ? {} : { providerSecrets }),
      localInventory: createLocalInventoryService(config),
    },
  ).workflow;
}

export function createPrinters(
  config: AppConfig,
): Readonly<Record<string, Printer>> {
  return Object.fromEntries(
    Object.entries(config.printers).map(([id, printerConfig]) => [
      id,
      createPrinter(printerConfig, config.spoolDirectory),
    ]),
  );
}

/**
 * Provider-neutral order runtime composition. Existing HTTP callers continue
 * through compatibility services until their qualified routes land in Package
 * 4, but the TCGplayer connection itself is now created only by its adapter.
 */
export function createMarketplaceConnectionRegistry(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
  providerSecrets?: ProviderSecretAccess,
): MarketplaceConnectionRegistry {
  const timezoneOffsetMinutes =
    config.timezoneOffsetMinutes === "local"
      ? new Date().getTimezoneOffset()
      : config.timezoneOffsetMinutes;
  const injected =
    credentials === undefined && sellerApi === undefined
      ? undefined
      : sellerResources(config, environment, credentials, sellerApi);
  const tcgplayer = createTcgplayerAdapterFactory({
    timezoneOffsetMinutes,
    ...(injected === undefined
      ? {}
      : { client: injected.client, credentials: injected.access }),
  });
  return new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([
      tcgplayer,
      createManaPoolAdapterFactory(),
    ]),
    connections: config.providers.connections,
    secrets: providerSecrets ?? environmentSecretAccess(environment),
  });
}

export function createMarketplaceOrderQueryService(
  config: AppConfig,
  registry: MarketplaceConnectionRegistry,
): OrderQueryService {
  return new OrderQueryService({
    registry,
    health: new ConnectionHealthService(registry),
    paging(connectionId) {
      const configured = config.providers.connections[connectionId];
      if (configured === undefined) {
        throw new ConfigurationError([
          "The marketplace connection paging settings are unavailable.",
        ]);
      }
      return parseOrderPagingSettings(configured.settings);
    },
  });
}

export function createMarketplaceOrderRuntime(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
  options: {
    readonly configuration?: () => Promise<AppConfig>;
    readonly logger?: Logger;
    readonly notifications?: NotificationPublisher;
    readonly providerSecrets?: ProviderSecretAccess;
    readonly localInventory?: LocalInventoryService;
  } = {},
): MarketplaceOrderRuntime {
  const registry = createMarketplaceConnectionRegistry(
    config,
    environment,
    credentials,
    sellerApi,
    options.providerSecrets,
  );
  const legacyConnectionId = legacyStateConnectionId(config);
  const health = new ConnectionHealthService(registry);
  const orders = new OrderQueryService({
    registry,
    health,
    paging(connectionId) {
      const configured = config.providers.connections[connectionId];
      if (configured === undefined) {
        throw new ConfigurationError([
          "The marketplace connection paging settings are unavailable.",
        ]);
      }
      return parseOrderPagingSettings(configured.settings);
    },
    projectOrder: (order) => {
      const connection = registry.get(order.ref.connectionId);
      if (connection === undefined) return order;
      const labelAction = Object.values(config.actions).find(
        (action) => action.type === "print-address-label",
      );
      return projectDocumentActions(order, connection.facets, {
        addressLabelConfigured:
          labelAction !== undefined &&
          config.printers[labelAction.printer] !== undefined,
      });
    },
  });
  const documents = new OrderDocumentService(registry);
  const configuration =
    options.configuration ?? (() => Promise.resolve(config));
  const readyOrders = new MarketplaceReadyOrderSource({
    registry,
    orders,
    concurrency: async () =>
      (await configuration()).providers.synchronizationConcurrency,
  });
  const inventory = new MarketplaceInventoryService({
    registry,
    health,
    paging(connectionId) {
      const configured = config.providers.connections[connectionId];
      if (configured === undefined) {
        throw new ConfigurationError([
          "The marketplace inventory paging settings are unavailable.",
        ]);
      }
      return parseOrderPagingSettings(configured.settings);
    },
    concurrency: async () =>
      (await configuration()).providers.synchronizationConcurrency,
  });
  const shipmentTags = new JsonShipmentTagRegistry(
    shipmentTagAssignmentsPath(config.shipmentScanner.stateFile),
    { legacyConnectionId },
  );
  const pullList = new MasterPullListService({
    registry,
    orders,
    progress: new JsonQualifiedPullListProgressStore(
      pullListProgressPath(config.stateFile),
      { legacyConnectionId },
    ),
    grouping: async () => (await configuration()).masterPullList,
  });
  const actions = new MarketplaceOrderActionService({
    registry,
    health,
    queries: orders,
    onOrderRemoved: async (ref) => {
      readyOrders.remove(ref);
      try {
        await pullList.removeOrder(ref);
      } catch {
        // A local progress failure cannot make a completed remote shipment
        // look uncertain or eligible for an unsafe retry.
        pullList.invalidate();
      }
    },
    ...(options.notifications === undefined
      ? {}
      : {
          onShipmentAttempt: (attempt) => {
            const descriptor = registry.get(
              attempt.ref.connectionId,
            )?.descriptor;
            return options.notifications?.publish({
              type: "shipment-mark-attempt",
              idempotencyKey: `shipment-mark-attempt:${randomUUID()}`,
              occurredAt: new Date().toISOString(),
              ref: attempt.ref,
              displayOrderNumber: attempt.ref.remoteId,
              connectionId: attempt.ref.connectionId,
              connectionLabel:
                descriptor?.connectionLabel ?? attempt.ref.connectionId,
              outcome:
                attempt.outcome === "review-required"
                  ? "failed"
                  : attempt.outcome,
              ...(attempt.outcome === "review-required"
                ? { errorCode: "REVIEW_REQUIRED" }
                : attempt.errorCode === undefined
                  ? {}
                  : { errorCode: attempt.errorCode }),
            });
          },
        }),
  });
  const workflow = new FulfillmentWorkflow({
    config: configuration,
    registry,
    readyOrders,
    stateStore: new JsonStateStore(config.stateFile, { legacyConnectionId }),
    actions: (current) =>
      createActions(current, createPrinters(current), { shipmentTags }),
    documents,
    ...(options.localInventory === undefined
      ? {}
      : { localInventory: options.localInventory }),
    logger:
      options.logger ??
      ({ info: () => undefined, error: () => undefined } satisfies Logger),
    syncLease: new FileSyncLease(`${config.stateFile}.sync-lock`),
  });
  return {
    registry,
    health,
    orders,
    actions,
    documents,
    printing: new OrderPrintService({
      documents,
      configuration,
    }),
    pullList,
    readyOrders,
    workflow,
    inventory,
  };
}

export async function executeConfiguredSyntheticPrintTest(
  config: AppConfig,
  actionId: string,
  printers: Readonly<Record<string, Printer>> = createPrinters(config),
): Promise<void> {
  const actionConfig = config.actions[actionId];
  if (actionConfig === undefined) {
    throw new ConfigurationError([
      "The selected print action is not configured.",
    ]);
  }
  const testActionConfig = { ...actionConfig, enabled: true };
  const testConfig: AppConfig = {
    ...config,
    actions: { [actionId]: testActionConfig },
  };
  const action = createActions(testConfig, printers, {
    includeShipmentTags: false,
  })[actionId];
  if (action === undefined) {
    throw new ConfigurationError(["The selected print action is unavailable."]);
  }
  await executeSyntheticPrintTest(action, testActionConfig);
}

export async function executeConfiguredAddressLabel(
  config: AppConfig,
  lines: readonly string[],
  options: {
    readonly printers?: Readonly<Record<string, Printer>>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  const selected = Object.values(config.actions).find(
    (action) => action.type === "print-address-label",
  );
  if (selected === undefined) {
    throw new ConfigurationError(["No address-label action is configured."]);
  }
  const printer = (options.printers ?? createPrinters(config))[
    selected.printer
  ];
  if (printer === undefined) {
    throw new ConfigurationError([
      "The configured address-label printer is unavailable.",
    ]);
  }
  await executeAddressLabelLines(
    selected,
    printer,
    lines,
    `manual-address-label:${randomUUID()}`,
    options.signal,
  );
}

export function createPriceUpdateQueue(
  config: AppConfig,
): PriceUpdateQueueStore {
  return new PriceUpdateQueueStore({
    stateFile: config.priceUpdateQueue.stateFile,
    historyLimit: config.priceUpdateQueue.historyLimit,
  });
}

export function createPriceUpdateExecutor(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
) {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return createTcgplayerPriceUpdateExecutor(
    config,
    environment,
    access,
    client,
  );
}

export function createRepricingService(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): RepricingService {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return new RepricingService({
    client,
    sellerKey: access.sellerKey,
  });
}

export function createInventoryAdditionQueue(
  config: AppConfig,
): InventoryAdditionQueueStore {
  return new InventoryAdditionQueueStore({
    stateFile: config.inventoryAdditionQueue.stateFile,
    historyLimit: config.inventoryAdditionQueue.historyLimit,
  });
}

export function createInventoryAdditionExecutor(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
) {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return createTcgplayerInventoryAdditionExecutor(
    config,
    environment,
    access,
    client,
  );
}

export function createInventoryAdditionService(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): InventoryAdditionService {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return new InventoryAdditionService({
    client,
    sellerKey: access.sellerKey,
  });
}

export function createInternalJobStore(config: AppConfig): InternalJobStore {
  return new InternalJobStore({
    stateFile: internalJobStatePath(config.stateFile),
    historyLimit: 200,
  });
}

export function createLocalInventoryService(
  config: AppConfig,
): LocalInventoryService {
  return new LocalInventoryService(
    new JsonLocalInventoryStore(localInventoryStatePath(config.stateFile)),
  );
}

export function createShipmentScannerService(
  config: AppConfig,
  configPath: string,
  marketplaces: MarketplaceOrderRuntime,
): ShipmentScannerService {
  const legacyConnectionId = legacyStateConnectionId(config);
  return new ShipmentScannerService({
    settings: async () => (await loadConfig(configPath)).shipmentScanner,
    readyOrders: marketplaces.readyOrders,
    orders: marketplaces.actions,
    store: new JsonShipmentScanStore(config.shipmentScanner.stateFile, {
      legacyConnectionId,
    }),
    tags: new JsonShipmentTagRegistry(
      shipmentTagAssignmentsPath(config.shipmentScanner.stateFile),
      { legacyConnectionId },
    ),
  });
}

export function createBackgroundShipmentScanner(
  configPath: string,
  scanner: ShipmentScannerService,
  logger: Logger,
): BackgroundShipmentScanner {
  return new BackgroundShipmentScanner({
    settings: async () => (await loadConfig(configPath)).shipmentScanner,
    camera: new NodeAvCameraCapture(),
    detector: new WasmShipmentTagDetector(),
    scanner,
    logger,
  });
}

export function createPaymentManagementService(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): PaymentManagementService {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return new PaymentManagementService({
    client,
    sellerKey: access.sellerKey,
  });
}

export function createFeedbackManagementService(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): FeedbackManagementService {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return new FeedbackManagementService({
    client,
    sellerKey: access.sellerKey,
  });
}

export function createMessageManagementService(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): MessageManagementService {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return new MessageManagementService({
    client,
    sellerKey: access.sellerKey,
  });
}

export async function createSellerSessionManager(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  requests?: SellerRequestGovernor,
  notifications?: NotificationPublisher,
): Promise<SellerSessionManager> {
  const tcgplayer = primaryTcgplayerConnection(config.providers);
  const stateDirectory = dirname(resolve(config.stateFile));
  const manager = new SellerSessionManager({
    store: createPlatformCredentialStore(
      resolve(stateDirectory, "tcgplayer-session.dpapi"),
    ),
    environment,
    authCookieEnvironmentName: tcgplayer.settings.authCookieEnv,
    sellerKeyEnvironmentName: tcgplayer.settings.sellerKeyEnv,
    ...(notifications === undefined
      ? {}
      : {
          onExpired: (updatedAt: string) =>
            notifications.publish({
              type: "authentication-required",
              idempotencyKey: `authentication-required:${updatedAt}`,
              occurredAt: updatedAt,
              connectionId: tcgplayer.connectionId,
              connectionLabel: tcgplayer.label,
            }),
        }),
    ...(requests === undefined
      ? {}
      : {
          validateSession: async (authCookie: string) => {
            const client = createTcgplayerSellerClient({
              session: { authCookie },
              fetch: requests.fetch,
              requestDelayMs: 0,
            });
            return (await client.getAuthenticatedSeller()).sellerKey;
          },
        }),
  });
  await manager.initialize();
  return manager;
}

export async function createSellerRuntime(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  notifications?: NotificationPublisher,
): Promise<{
  readonly sessionManager: SellerSessionManager;
  readonly sellerApi: SellerApiRuntime;
}> {
  const requests = new SellerRequestGovernor();
  const sessionManager = await createSellerSessionManager(
    config,
    environment,
    requests,
    notifications,
  );
  return {
    sessionManager,
    sellerApi: createSellerApiRuntime({
      credentials: sessionManager,
      requests,
    }),
  };
}

export interface NotificationRuntime {
  readonly discordWebhook: DiscordWebhookManager;
  readonly publisher: NotificationService;
  readonly state: JsonNotificationStateStore;
}

export async function createNotificationRuntime(
  config: AppConfig,
  configPath: string,
  logger: Logger,
  environment: NodeJS.ProcessEnv = process.env,
  fetch?: typeof globalThis.fetch,
): Promise<NotificationRuntime> {
  const stateDirectory = dirname(resolve(config.stateFile));
  const discordWebhook = new DiscordWebhookManager({
    store: createPlatformTextSecretStore(
      resolve(stateDirectory, "discord-webhook.dpapi"),
    ),
    environment,
    webhookUrlEnvironmentName: config.notifications.discord.webhookUrlEnv,
    ...(fetch === undefined ? {} : { fetch }),
  });
  await discordWebhook.initialize();
  const state = new JsonNotificationStateStore(
    resolve(`${config.stateFile}.notifications.json`),
    { legacyConnectionId: legacyStateConnectionId(config) },
  );
  const publisher = new NotificationService({
    settings: async () => (await loadConfig(configPath)).notifications.discord,
    sink: discordWebhook,
    state,
    logger,
  });
  return { discordWebhook, publisher, state };
}

export async function createMarketplaceCredentialManager(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MarketplaceCredentialManager> {
  const stateDirectory = dirname(resolve(config.stateFile));
  const manager = new MarketplaceCredentialManager(
    createPlatformTextSecretStore(
      resolve(stateDirectory, "marketplace-credentials.dpapi"),
    ),
    environment,
  );
  await manager.initialize();
  return manager;
}

export function createNotificationMonitor(
  configPath: string,
  runtime: NotificationRuntime,
  marketplaces: MarketplaceOrderRuntime,
  messages: MessageManagementService,
  logger: Logger,
): NotificationMonitor {
  const messageConnection = marketplaces.registry
    .list()
    .find(
      (connection) =>
        connection.descriptor.providerId === "tcgplayer" &&
        connection.facets.messages !== undefined,
    );
  if (messageConnection === undefined) {
    throw new ConfigurationError([
      "An enabled TCGplayer messages connection is required for notifications.",
    ]);
  }
  return new NotificationMonitor({
    settings: async () => (await loadConfig(configPath)).notifications.discord,
    publisher: runtime.publisher,
    state: runtime.state,
    registry: marketplaces.registry,
    readyOrders: marketplaces.readyOrders,
    messages,
    messageConnectionId: messageConnection.descriptor.connectionId,
    logger,
  });
}

function sellerResources(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
  credentials: SellerCredentialAccess | undefined,
  sellerApi: SellerApiRuntime | undefined,
): {
  readonly access: SellerCredentialAccess;
  readonly client: TcgplayerSellerClient;
} {
  if (sellerApi !== undefined) {
    return { access: sellerApi.credentials, client: sellerApi.client };
  }
  const access = credentialAccess(config, environment, credentials);
  return {
    access,
    client: createTcgplayerSellerClient({
      session: access.session,
      onAuthenticationRequired: access.onAuthenticationRequired,
    }),
  };
}

function credentialAccess(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
  credentials: SellerCredentialAccess | undefined,
): SellerCredentialAccess {
  const { settings } = primaryTcgplayerConnection(config.providers);
  return (
    credentials ??
    environmentSellerCredentialAccess(
      settings.authCookieEnv,
      settings.sellerKeyEnv,
      environment,
    )
  );
}

export function legacyStateConnectionId(config: AppConfig): string {
  const enabled = Object.entries(config.providers.connections)
    .filter(([, connection]) => connection.enabled)
    .sort(([left], [right]) => left.localeCompare(right));
  const selected =
    enabled.find(([, connection]) => connection.providerId === "tcgplayer") ??
    enabled[0];
  if (selected === undefined) {
    throw new ConfigurationError([
      "An enabled marketplace connection is required to migrate legacy state.",
    ]);
  }
  return selected[0];
}
