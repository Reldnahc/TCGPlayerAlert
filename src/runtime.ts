import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import {
  createTcgplayerSellerClient,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
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
import {
  JsonPullListProgressStore,
  pullListProgressPath,
} from "./pull-list-progress.js";
import { TcgplayerOrderProvider } from "./tcgplayer-provider.js";
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
import {
  OrderManagementService,
  type ManualPrintActionType,
} from "./order-management.js";
import { PaymentManagementService } from "./payment-management.js";
import { FeedbackManagementService } from "./feedback-management.js";
import { MessageManagementService } from "./message-management.js";
import {
  TcgplayerReadyOrderSource,
  type ReadyOrderSource,
} from "./ready-orders.js";
import { createPlatformCredentialStore } from "./credential-store.js";
import {
  environmentSellerCredentialAccess,
  type SellerCredentialAccess,
} from "./seller-credentials.js";
import { SellerSessionManager } from "./seller-session.js";
import {
  JsonShipmentScanStore,
  ShipmentScannerService,
} from "./shipment-scanner.js";
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

export function createWorkflow(
  config: AppConfig,
  logger: Logger,
  environment: NodeJS.ProcessEnv = process.env,
  readyOrders?: ReadyOrderSource,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): FulfillmentWorkflow {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  const provider = new TcgplayerOrderProvider({
    client,
    sellerKey: access.sellerKey,
    pageSize: config.provider.pageSize,
    maximumPages: config.provider.maximumPages,
    timezoneOffsetMinutes:
      config.timezoneOffsetMinutes === "local"
        ? new Date().getTimezoneOffset()
        : config.timezoneOffsetMinutes,
    ...(readyOrders === undefined ? {} : { readyOrders }),
  });
  const printers = createPrinters(config);
  return new FulfillmentWorkflow({
    config,
    provider,
    stateStore: new JsonStateStore(config.stateFile),
    actions: createActions(config, printers),
    logger,
    syncLease: new FileSyncLease(`${config.stateFile}.sync-lock`),
  });
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

export async function executeConfiguredOrderPrint(
  config: AppConfig,
  orderNumber: string,
  actionType: ManualPrintActionType,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): Promise<void> {
  const selected = Object.entries(config.actions).find(
    ([, action]) => action.type === actionType,
  );
  if (selected === undefined) {
    throw new ConfigurationError([
      `No ${actionType === "print-address-label" ? "address-label" : "packing-slip"} action is configured.`,
    ]);
  }
  const [actionId, actionConfig] = selected;
  const manualConfig: AppConfig = {
    ...config,
    actions: { [actionId]: { ...actionConfig, enabled: true } },
  };
  const action = createActions(manualConfig, createPrinters(manualConfig))[
    actionId
  ];
  if (action === undefined) {
    throw new ConfigurationError([
      "The selected order print action is unavailable.",
    ]);
  }
  const provider = createOrderProvider(
    config,
    environment,
    credentials,
    sellerApi,
  );
  const order = await provider.confirmOrder(orderNumber, signal);
  const packingSlip = action.requiresPackingSlip
    ? await provider.getPackingSlip(orderNumber, signal)
    : undefined;
  await action.execute({
    order,
    idempotencyKey: `manual-order-print:${orderNumber}:${actionId}:${randomUUID()}`,
    ...(packingSlip === undefined ? {} : { packingSlip }),
    ...(signal === undefined ? {} : { signal }),
  });
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

export function createOrderManagementService(
  config: AppConfig,
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  readyOrders?: ReadyOrderSource,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): OrderManagementService {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  const timezoneOffsetMinutes =
    config.timezoneOffsetMinutes === "local"
      ? new Date().getTimezoneOffset()
      : config.timezoneOffsetMinutes;
  return new OrderManagementService({
    client,
    sellerKey: access.sellerKey,
    pullListProgressStore: new JsonPullListProgressStore(
      pullListProgressPath(config.stateFile),
    ),
    pageSize: config.provider.pageSize,
    maximumPages: config.provider.maximumPages,
    timezoneOffsetMinutes,
    ...(readyOrders === undefined
      ? {}
      : {
          onShipmentAccepted: (orderNumber: string) =>
            readyOrders.remove(orderNumber),
        }),
    executePrint: async (orderNumber, actionType, signal) => {
      await executeConfiguredOrderPrint(
        await loadConfig(configPath),
        orderNumber,
        actionType,
        environment,
        signal,
        access,
        sellerApi,
      );
    },
  });
}

export function createReadyOrderSource(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): TcgplayerReadyOrderSource {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return new TcgplayerReadyOrderSource({
    client,
    sellerKey: access.sellerKey,
    pageSize: config.provider.pageSize,
    maximumPages: config.provider.maximumPages,
  });
}

export function createShipmentScannerService(
  config: AppConfig,
  configPath: string,
  readyOrders: ReadyOrderSource,
  orders: OrderManagementService,
): ShipmentScannerService {
  return new ShipmentScannerService({
    settings: async () => (await loadConfig(configPath)).shipmentScanner,
    readyOrders,
    orders,
    store: new JsonShipmentScanStore(config.shipmentScanner.stateFile),
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

function createOrderProvider(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
  credentials?: SellerCredentialAccess,
  sellerApi?: SellerApiRuntime,
): TcgplayerOrderProvider {
  const { access, client } = sellerResources(
    config,
    environment,
    credentials,
    sellerApi,
  );
  return new TcgplayerOrderProvider({
    client,
    sellerKey: access.sellerKey,
    pageSize: config.provider.pageSize,
    maximumPages: config.provider.maximumPages,
    timezoneOffsetMinutes:
      config.timezoneOffsetMinutes === "local"
        ? new Date().getTimezoneOffset()
        : config.timezoneOffsetMinutes,
  });
}

export async function createSellerSessionManager(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  requests?: SellerRequestGovernor,
): Promise<SellerSessionManager> {
  const stateDirectory = dirname(resolve(config.stateFile));
  const manager = new SellerSessionManager({
    store: createPlatformCredentialStore(
      resolve(stateDirectory, "tcgplayer-session.dpapi"),
    ),
    environment,
    authCookieEnvironmentName: config.provider.authCookieEnv,
    sellerKeyEnvironmentName: config.provider.sellerKeyEnv,
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
): Promise<{
  readonly sessionManager: SellerSessionManager;
  readonly sellerApi: SellerApiRuntime;
}> {
  const requests = new SellerRequestGovernor();
  const sessionManager = await createSellerSessionManager(
    config,
    environment,
    requests,
  );
  return {
    sessionManager,
    sellerApi: createSellerApiRuntime({
      credentials: sessionManager,
      requests,
    }),
  };
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
  return (
    credentials ??
    environmentSellerCredentialAccess(
      config.provider.authCookieEnv,
      config.provider.sellerKeyEnv,
      environment,
    )
  );
}
