#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { renderSyntheticPrintTest } from "./actions.js";
import { ConfigurationError, safeErrorCode } from "./errors.js";
import { jsonLogger } from "./logger.js";
import { createWorkflow } from "./runtime.js";
import { JsonStateStore } from "./state.js";
import { CommandPrinter } from "./printing.js";

const argumentsList = process.argv.slice(2);
const command = argumentsList[0];
const configPath = option("--config") ?? "config/local.json";

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
    const printerConfig = config.printers[action.printer];
    if (printerConfig === undefined) {
      throw new ConfigurationError([
        "The selected action references an unavailable printer.",
      ]);
    }
    const bytes = await renderSyntheticPrintTest(action);
    await new CommandPrinter(printerConfig, config.spoolDirectory).submit({
      idempotencyKey: `synthetic-print-test:${actionId}`,
      jobName: `synthetic-${actionId}`,
      mediaType: "application/pdf",
      bytes,
    });
    process.stdout.write(
      `${JSON.stringify({ printed: true, actionId, synthetic: true })}\n`,
    );
  } else if (command === "start") {
    const config = await loadConfig(configPath);
    const workflow = createWorkflow(config, jsonLogger);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    jsonLogger.info("service.started", {
      pollIntervalMinutes: config.pollIntervalMinutes,
      dryRun: config.dryRun,
    });
    while (!controller.signal.aborted) {
      try {
        await workflow.run("scheduled", { signal: controller.signal });
      } catch (error) {
        jsonLogger.error("service.sync-failed", {
          errorCode: safeErrorCode(error),
        });
      }
      await wait(config.pollIntervalMinutes * 60_000, controller.signal);
    }
    jsonLogger.info("service.stopped");
  } else {
    process.stderr.write(
      "Usage: tcgplayer-alert <start|sync|status|config validate|print test> [--config path] [--process-backlog] [--action id]\n",
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
