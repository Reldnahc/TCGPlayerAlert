import { randomUUID } from "node:crypto";
import { loadConfig, type AppConfig } from "./config.js";
import { createTcgplayerSellerClient } from "tcgplayer-private-api";
import { createActions, executeSyntheticPrintTest } from "./actions.js";
import { ConfigurationError } from "./errors.js";
import type { Logger } from "./logger.js";
import { createPrinter, type Printer } from "./printing.js";
import { FulfillmentWorkflow } from "./orchestrator.js";
import { JsonStateStore } from "./state.js";
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

export function createWorkflow(
  config: AppConfig,
  logger: Logger,
  environment: NodeJS.ProcessEnv = process.env,
): FulfillmentWorkflow {
  const authCookie = secretFromEnvironment(
    config.provider.authCookieEnv,
    environment,
  );
  const sellerKey = secretFromEnvironment(
    config.provider.sellerKeyEnv,
    environment,
  );
  const provider = new TcgplayerOrderProvider({
    authCookie,
    sellerKey,
    pageSize: config.provider.pageSize,
    maximumPages: config.provider.maximumPages,
    timezoneOffsetMinutes:
      config.timezoneOffsetMinutes === "local"
        ? new Date().getTimezoneOffset()
        : config.timezoneOffsetMinutes,
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
  const action = createActions(testConfig, printers)[actionId];
  if (action === undefined) {
    throw new ConfigurationError(["The selected print action is unavailable."]);
  }
  await executeSyntheticPrintTest(action, testActionConfig);
}

export async function executeConfiguredOrderPrint(
  config: AppConfig,
  orderNumber: string,
  actionType: ManualPrintActionType,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
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
  const provider = createOrderProvider(config, environment);
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
) {
  return createTcgplayerPriceUpdateExecutor(config, environment);
}

export function createRepricingService(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): RepricingService {
  const authCookie = secretFromEnvironment(
    config.provider.authCookieEnv,
    environment,
  );
  const sellerKey = secretFromEnvironment(
    config.provider.sellerKeyEnv,
    environment,
  );
  return new RepricingService({
    client: createTcgplayerSellerClient({ session: { authCookie } }),
    sellerKey,
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
) {
  return createTcgplayerInventoryAdditionExecutor(config, environment);
}

export function createInventoryAdditionService(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): InventoryAdditionService {
  const authCookie = secretFromEnvironment(
    config.provider.authCookieEnv,
    environment,
  );
  const sellerKey = secretFromEnvironment(
    config.provider.sellerKeyEnv,
    environment,
  );
  return new InventoryAdditionService({
    client: createTcgplayerSellerClient({ session: { authCookie } }),
    sellerKey,
  });
}

export function createOrderManagementService(
  config: AppConfig,
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): OrderManagementService {
  const authCookie = secretFromEnvironment(
    config.provider.authCookieEnv,
    environment,
  );
  const sellerKey = secretFromEnvironment(
    config.provider.sellerKeyEnv,
    environment,
  );
  const timezoneOffsetMinutes =
    config.timezoneOffsetMinutes === "local"
      ? new Date().getTimezoneOffset()
      : config.timezoneOffsetMinutes;
  return new OrderManagementService({
    client: createTcgplayerSellerClient({ session: { authCookie } }),
    sellerKey,
    pageSize: config.provider.pageSize,
    maximumPages: config.provider.maximumPages,
    timezoneOffsetMinutes,
    executePrint: async (orderNumber, actionType, signal) => {
      await executeConfiguredOrderPrint(
        await loadConfig(configPath),
        orderNumber,
        actionType,
        environment,
        signal,
      );
    },
  });
}

function createOrderProvider(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
): TcgplayerOrderProvider {
  return new TcgplayerOrderProvider({
    authCookie: secretFromEnvironment(
      config.provider.authCookieEnv,
      environment,
    ),
    sellerKey: secretFromEnvironment(config.provider.sellerKeyEnv, environment),
    pageSize: config.provider.pageSize,
    maximumPages: config.provider.maximumPages,
    timezoneOffsetMinutes:
      config.timezoneOffsetMinutes === "local"
        ? new Date().getTimezoneOffset()
        : config.timezoneOffsetMinutes,
  });
}

function secretFromEnvironment(
  name: string,
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new ConfigurationError([`Environment variable ${name} is required.`]);
  }
  return value;
}
