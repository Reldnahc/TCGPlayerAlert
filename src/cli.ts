#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { startConfigurationUi } from "./config-ui.js";
import { createActions, executeSyntheticPrintTest } from "./actions.js";
import { ConfigurationError, safeErrorCode } from "./errors.js";
import { jsonLogger } from "./logger.js";
import {
  createPriceUpdateExecutor,
  createPriceUpdateQueue,
  createPrinters,
  createRepricingService,
  createWorkflow,
} from "./runtime.js";
import { JsonStateStore } from "./state.js";
import { PriceUpdateWorker } from "./price-update-queue.js";
import { FileSyncLease } from "./sync-lease.js";

const argumentsList = process.argv.slice(2);
const command = argumentsList[0];
const configPath = option("--config") ?? "config/local.json";
const uiPort = portOption(option("--port"));

try {
  if (command === "config" && argumentsList[1] === "validate") {
    const config = await loadConfig(configPath);
    process.stdout.write(
      `${JSON.stringify({ valid: true, rules: config.rules.length, actions: Object.keys(config.actions).length, printers: Object.keys(config.printers).length })}\n`,
    );
  } else if (command === "status") {
    const config = await loadConfig(configPath);
    const state = await new JsonStateStore(config.stateFile).load();
    const counts = Object.values(state.orders).reduce<Record<string, number>>(
      (result, order) => {
        result[order.workflowStatus] = (result[order.workflowStatus] ?? 0) + 1;
        return result;
      },
      {},
    );
    process.stdout.write(
      `${JSON.stringify({ baselineCompletedAt: state.baselineCompletedAt, lastSync: state.lastSync, orderCounts: counts }, null, 2)}\n`,
    );
  } else if (command === "sync") {
    const config = await loadConfig(configPath);
    const workflow = createWorkflow(config, jsonLogger);
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
    const workflowAction = createActions(config, createPrinters(config))[
      actionId
    ];
    if (workflowAction === undefined) {
      throw new ConfigurationError(["The selected action is unavailable."]);
    }
    await executeSyntheticPrintTest(workflowAction, action);
    process.stdout.write(
      `${JSON.stringify({ printed: true, actionId, synthetic: true })}\n`,
    );
  } else if (command === "configure") {
    const config = await loadConfig(configPath);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const ui = await startConfigurationUi({
      configPath,
      port: uiPort,
      priceQueue: createPriceUpdateQueue(config),
      repricingService: createRepricingService(config),
    });
    process.stdout.write(`TCGPlayerAlert settings: ${ui.url}\n`);
    try {
      await waitUntilAborted(controller.signal);
    } finally {
      await ui.close();
    }
  } else if (command === "start") {
    const initialConfig = await loadConfig(configPath);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const priceQueue = createPriceUpdateQueue(initialConfig);
    const priceWorker = new PriceUpdateWorker({
      queue: priceQueue,
      executor: createPriceUpdateExecutor(initialConfig),
      settings: async () => {
        const current = await loadConfig(configPath);
        return {
          ...current.priceUpdateQueue,
          enabled: current.priceUpdateQueue.enabled && !current.dryRun,
        };
      },
      logger: jsonLogger,
      workerLease: new FileSyncLease(
        `${initialConfig.priceUpdateQueue.stateFile}.worker-lock`,
      ),
    });
    const ui = await startConfigurationUi({
      configPath,
      port: uiPort,
      priceQueue,
      priceWorkerRunning: true,
      repricingService: createRepricingService(initialConfig),
    });
    const priceWorkerPromise = priceWorker
      .run(controller.signal)
      .catch((error: unknown) => {
        jsonLogger.error("price-queue.worker-failed", {
          errorCode: safeErrorCode(error),
        });
      });
    jsonLogger.info("service.started", {
      settingsUrl: ui.url,
    });
    try {
      while (!controller.signal.aborted) {
        const config = await loadConfig(configPath);
        const workflow = createWorkflow(config, jsonLogger);
        try {
          await workflow.run("scheduled", { signal: controller.signal });
        } catch (error) {
          jsonLogger.error("service.sync-failed", {
            errorCode: safeErrorCode(error),
          });
        }
        await wait(config.pollIntervalMinutes * 60_000, controller.signal);
      }
    } finally {
      await ui.close();
      await priceWorkerPromise;
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
  } else {
    process.stderr.write(
      "Usage: tcgplayer-alert <start|configure|sync|status|config validate|print test|price queue|price status|price cancel> [--config path] [--port number] [--process-backlog] [--action id] [--file path] [--job id]\n",
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
