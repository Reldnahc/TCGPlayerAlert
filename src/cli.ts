#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadConfig, type AppConfig } from "./config.js";
import {
  startConfigurationUi,
  type ConfigurationAddressLabelPrint,
} from "./config-ui.js";
import { ConfigurationError, safeErrorCode } from "./errors.js";
import { jsonLogger } from "./logger.js";
import {
  createInventoryAdditionExecutor,
  createInventoryAdditionQueue,
  createInventoryAdditionService,
  createInternalJobStore,
  createLocalInventoryService,
  legacyStateConnectionId,
  createMarketplaceOrderRuntime,
  createNotificationMonitor,
  createNotificationRuntime,
  createFeedbackManagementService,
  createMessageManagementService,
  createPaymentManagementService,
  createPriceUpdateExecutor,
  createPriceUpdateQueue,
  executeConfiguredAddressLabel,
  executeConfiguredSyntheticPrintTest,
  createRepricingService,
  createSellerRuntime,
  createBackgroundShipmentScanner,
  createShipmentScannerService,
  createWorkflow,
  createMarketplaceCredentialManager,
} from "./runtime.js";
import { JsonStateStore } from "./state.js";
import { PriceUpdateWorker } from "./price-update-queue.js";
import { InventoryAdditionWorker } from "./inventory-additions.js";
import { FileSyncLease } from "./sync-lease.js";
import {
  InternalJobExecutor,
  InternalJobRunner,
} from "./internal-jobs/index.js";
import {
  marketplaceAccountServiceMap,
  type MarketplaceAccountServices,
} from "./marketplaces/account-workspaces.js";
import { primaryTcgplayerConnection } from "./providers/tcgplayer/configuration.js";

const argumentsList = process.argv.slice(2);
const command = argumentsList[0];
const configPath = option("--config") ?? "config/local.json";
const uiPort = portOption(option("--port"));
const executeAddressLabel: ConfigurationAddressLabelPrint = async (
  lines,
  signal,
) =>
  executeConfiguredAddressLabel(await loadConfig(configPath), lines, {
    ...(signal === undefined ? {} : { signal }),
  });
try {
  if (command === "config" && argumentsList[1] === "validate") {
    const config = await loadConfig(configPath);
    process.stdout.write(
      `${JSON.stringify({ valid: true, rules: config.rules.length, actions: Object.keys(config.actions).length, printers: Object.keys(config.printers).length })}\n`,
    );
  } else if (command === "status") {
    const config = await loadConfig(configPath);
    const state = await new JsonStateStore(config.stateFile, {
      legacyConnectionId: legacyStateConnectionId(config),
    }).load();
    const counts = Object.values(state.orders).reduce<Record<string, number>>(
      (result, order) => {
        result[order.workflowStatus] = (result[order.workflowStatus] ?? 0) + 1;
        return result;
      },
      {},
    );
    process.stdout.write(
      `${JSON.stringify({ baselines: state.baselines, lastSync: state.lastSync, orderCounts: counts }, null, 2)}\n`,
    );
  } else if (command === "sync") {
    const config = await loadConfig(configPath);
    const marketplaceCredentials =
      await createMarketplaceCredentialManager(config);
    const notifications = await createNotificationRuntime(
      config,
      configPath,
      jsonLogger,
    );
    const { sessionManager, sellerApi } = await createSellerRuntime(
      config,
      process.env,
      notifications.publisher,
    );
    const workflow = createWorkflow(
      config,
      jsonLogger,
      process.env,
      sessionManager,
      sellerApi,
      notifications.publisher,
      marketplaceCredentials,
    );
    const result = await workflow.run("manual", {
      processBacklog: argumentsList.includes("--process-backlog"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "print" && argumentsList[1] === "test") {
    const config = await loadConfig(configPath);
    const actionId = option("--action");
    const action =
      actionId === undefined ? undefined : config.actions[actionId];
    if (actionId === undefined || action === undefined) {
      throw new ConfigurationError([
        "print test requires --action with a configured action id.",
      ]);
    }
    await executeConfiguredSyntheticPrintTest(config, actionId);
    process.stdout.write(
      `${JSON.stringify({ printed: true, actionId, synthetic: true })}\n`,
    );
  } else if (command === "configure") {
    const config = await loadConfig(configPath);
    const marketplaceCredentials =
      await createMarketplaceCredentialManager(config);
    const notifications = await createNotificationRuntime(
      config,
      configPath,
      jsonLogger,
    );
    const { sessionManager, sellerApi } = await createSellerRuntime(
      config,
      process.env,
      notifications.publisher,
    );
    const priceQueue = createPriceUpdateQueue(config);
    const inventoryQueue = createInventoryAdditionQueue(config);
    const repricingService = createRepricingService(
      config,
      process.env,
      sessionManager,
      sellerApi,
    );
    const inventoryService = createInventoryAdditionService(
      config,
      process.env,
      sessionManager,
      sellerApi,
    );
    const internalJobs = createInternalJobStore(config);
    const localInventory = createLocalInventoryService(config);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const marketplaces = createMarketplaceOrderRuntime(
      config,
      process.env,
      sessionManager,
      sellerApi,
      {
        configuration: () => loadConfig(configPath),
        logger: jsonLogger,
        notifications: notifications.publisher,
        providerSecrets: marketplaceCredentials,
        localInventory,
      },
    );
    const messageService = createMessageManagementService(
      config,
      process.env,
      sessionManager,
      sellerApi,
    );
    const ui = await startConfigurationUi({
      configPath,
      port: uiPort,
      priceQueue,
      repricingService,
      inventoryQueue,
      inventoryService,
      localInventory,
      internalJobs,
      marketplaces,
      marketplaceAccounts: tcgplayerAccountServices(config, {
        payments: createPaymentManagementService(
          config,
          process.env,
          sessionManager,
          sellerApi,
        ),
        feedback: createFeedbackManagementService(
          config,
          process.env,
          sessionManager,
          sellerApi,
        ),
        messages: messageService,
      }),
      sessionManager,
      discordWebhook: notifications.discordWebhook,
      marketplaceCredentials,
      sellerRequestMetrics: sellerApi.requests.snapshot,
      executeAddressLabel,
      executePrintTest: executeConfiguredSyntheticPrintTest,
    });
    process.stdout.write(`TCGPlayerAlert settings: ${ui.url}\n`);
    try {
      await waitUntilAborted(controller.signal);
    } finally {
      await ui.close();
    }
  } else if (command === "start") {
    const initialConfig = await loadConfig(configPath);
    const marketplaceCredentials =
      await createMarketplaceCredentialManager(initialConfig);
    const notifications = await createNotificationRuntime(
      initialConfig,
      configPath,
      jsonLogger,
    );
    const { sessionManager, sellerApi } = await createSellerRuntime(
      initialConfig,
      process.env,
      notifications.publisher,
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const priceQueue = createPriceUpdateQueue(initialConfig);
    const inventoryQueue = createInventoryAdditionQueue(initialConfig);
    const repricingService = createRepricingService(
      initialConfig,
      process.env,
      sessionManager,
      sellerApi,
    );
    const inventoryService = createInventoryAdditionService(
      initialConfig,
      process.env,
      sessionManager,
      sellerApi,
    );
    const internalJobs = createInternalJobStore(initialConfig);
    const localInventory = createLocalInventoryService(initialConfig);
    const marketplaces = createMarketplaceOrderRuntime(
      initialConfig,
      process.env,
      sessionManager,
      sellerApi,
      {
        configuration: () => loadConfig(configPath),
        logger: jsonLogger,
        notifications: notifications.publisher,
        providerSecrets: marketplaceCredentials,
        localInventory,
      },
    );
    const messageService = createMessageManagementService(
      initialConfig,
      process.env,
      sessionManager,
      sellerApi,
    );
    const notificationMonitor = createNotificationMonitor(
      configPath,
      notifications,
      marketplaces,
      messageService,
      jsonLogger,
    );
    const shipmentScannerService = createShipmentScannerService(
      initialConfig,
      configPath,
      marketplaces,
    );
    const backgroundShipmentScanner = createBackgroundShipmentScanner(
      configPath,
      shipmentScannerService,
      jsonLogger,
    );
    const priceWorker = new PriceUpdateWorker({
      queue: priceQueue,
      executor: createPriceUpdateExecutor(
        initialConfig,
        process.env,
        sessionManager,
        sellerApi,
      ),
      settings: async () => {
        const current = await loadConfig(configPath);
        return current.priceUpdateQueue;
      },
      logger: jsonLogger,
      workerLease: new FileSyncLease(
        `${initialConfig.priceUpdateQueue.stateFile}.worker-lock`,
      ),
      canProcess: sessionManager.isConnected,
    });
    const inventoryWorker = new InventoryAdditionWorker({
      queue: inventoryQueue,
      executor: createInventoryAdditionExecutor(
        initialConfig,
        process.env,
        sessionManager,
        sellerApi,
      ),
      settings: async () => {
        const current = await loadConfig(configPath);
        return current.inventoryAdditionQueue;
      },
      logger: jsonLogger,
      workerLease: new FileSyncLease(
        `${initialConfig.inventoryAdditionQueue.stateFile}.worker-lock`,
      ),
      canProcess: sessionManager.isConnected,
    });
    const internalJobRunner = new InternalJobRunner({
      store: internalJobs,
      executor: new InternalJobExecutor({
        repricingService,
        inventoryService,
        priceQueue,
        inventoryQueue,
        loadConfig: () => loadConfig(configPath),
      }),
      logger: jsonLogger,
      workerLease: new FileSyncLease(
        `${initialConfig.stateFile}.internal-jobs.worker-lock`,
      ),
      canProcess: () =>
        sessionManager.isConnected() &&
        !marketplaces.workflow.isSynchronizing(),
    });
    const ui = await startConfigurationUi({
      configPath,
      port: uiPort,
      priceQueue,
      priceWorkerRunning: true,
      repricingService,
      inventoryQueue,
      inventoryWorkerRunning: true,
      inventoryService,
      localInventory,
      internalJobs,
      internalJobRunnerRunning: true,
      marketplaces,
      shipmentScannerService,
      backgroundShipmentScanner,
      marketplaceAccounts: tcgplayerAccountServices(initialConfig, {
        payments: createPaymentManagementService(
          initialConfig,
          process.env,
          sessionManager,
          sellerApi,
        ),
        feedback: createFeedbackManagementService(
          initialConfig,
          process.env,
          sessionManager,
          sellerApi,
        ),
        messages: messageService,
      }),
      sessionManager,
      discordWebhook: notifications.discordWebhook,
      marketplaceCredentials,
      sellerRequestMetrics: sellerApi.requests.snapshot,
      executeAddressLabel,
      executePrintTest: executeConfiguredSyntheticPrintTest,
    });
    const priceWorkerPromise = priceWorker
      .run(controller.signal)
      .catch((error: unknown) => {
        jsonLogger.error("price-queue.worker-failed", {
          errorCode: safeErrorCode(error),
        });
      });
    const inventoryWorkerPromise = inventoryWorker
      .run(controller.signal)
      .catch((error: unknown) => {
        jsonLogger.error("inventory-queue.worker-failed", {
          errorCode: safeErrorCode(error),
        });
      });
    const internalJobRunnerPromise = internalJobRunner
      .run(controller.signal)
      .catch((error: unknown) => {
        jsonLogger.error("internal-jobs.worker-failed", {
          errorCode: safeErrorCode(error),
        });
      });
    const backgroundScannerPromise = backgroundShipmentScanner
      .run(controller.signal)
      .catch((error: unknown) => {
        jsonLogger.error("shipment-camera.worker-failed", {
          errorCode: safeErrorCode(error),
        });
      });
    jsonLogger.info("service.started", {
      settingsUrl: ui.url,
    });
    try {
      while (!controller.signal.aborted) {
        try {
          await marketplaces.workflow.run("scheduled", {
            signal: controller.signal,
          });
        } catch (error) {
          jsonLogger.error("service.sync-failed", {
            errorCode: safeErrorCode(error),
          });
        }
        await notificationMonitor
          .run(controller.signal)
          .catch((error: unknown) => {
            jsonLogger.error("notification.monitor-failed", {
              errorCode: safeErrorCode(error),
            });
          });
        const config = await loadConfig(configPath);
        await wait(config.pollIntervalMinutes * 60_000, controller.signal);
      }
    } finally {
      await ui.close();
      await backgroundScannerPromise;
      await priceWorkerPromise;
      await inventoryWorkerPromise;
      await internalJobRunnerPromise;
    }
    jsonLogger.info("service.stopped");
  } else if (command === "price" && argumentsList[1] === "queue") {
    const config = await loadConfig(configPath);
    const inputPath = option("--file");
    if (inputPath === undefined) {
      throw new ConfigurationError([
        "price queue requires --file with a JSON update or batch.",
      ]);
    }
    const value = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
    const jobs = await createPriceUpdateQueue(config).enqueue(value);
    process.stdout.write(
      `${JSON.stringify({ queued: jobs.length, jobs }, null, 2)}\n`,
    );
  } else if (command === "price" && argumentsList[1] === "status") {
    const config = await loadConfig(configPath);
    process.stdout.write(
      `${JSON.stringify(await createPriceUpdateQueue(config).snapshot(), null, 2)}\n`,
    );
  } else if (command === "price" && argumentsList[1] === "cancel") {
    const config = await loadConfig(configPath);
    const jobId = option("--job");
    if (jobId === undefined) {
      throw new ConfigurationError(["price cancel requires --job."]);
    }
    process.stdout.write(
      `${JSON.stringify(await createPriceUpdateQueue(config).cancel(jobId), null, 2)}\n`,
    );
  } else if (command === "inventory" && argumentsList[1] === "status") {
    const config = await loadConfig(configPath);
    process.stdout.write(
      `${JSON.stringify(await createInventoryAdditionQueue(config).snapshot(), null, 2)}\n`,
    );
  } else if (command === "inventory" && argumentsList[1] === "cancel") {
    const config = await loadConfig(configPath);
    const jobId = option("--job");
    if (jobId === undefined) {
      throw new ConfigurationError(["inventory cancel requires --job."]);
    }
    process.stdout.write(
      `${JSON.stringify(await createInventoryAdditionQueue(config).cancel(jobId), null, 2)}\n`,
    );
  } else {
    process.stderr.write(
      "Usage: tcgplayer-alert <start|configure|sync|status|config validate|print test|price queue|price status|price cancel|inventory status|inventory cancel> [--config path] [--port number] [--process-backlog] [--action id] [--file path] [--job id]\n",
    );
    process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(
      `${JSON.stringify({ error: error.code, issues: error.issues }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(
      `${JSON.stringify({ error: safeErrorCode(error), message: "The command failed; inspect structured service logs for safe diagnostic context." })}\n`,
    );
  }
  process.exitCode = 1;
}

function option(name: string): string | undefined {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}

function portOption(value: string | undefined): number {
  if (value === undefined) return 47831;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError([
      "--port must be an integer from 1 through 65535.",
    ]);
  }
  return port;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    signal.addEventListener("abort", () => resolvePromise(), { once: true });
  });
}

function tcgplayerAccountServices(
  config: AppConfig,
  services: MarketplaceAccountServices,
) {
  const { connectionId } = primaryTcgplayerConnection(config.providers);
  return marketplaceAccountServiceMap({ [connectionId]: services });
}
