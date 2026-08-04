import type { AppConfig } from "./config.js";
import { createTcgplayerSellerClient } from "tcgplayer-private-api";
import { createActions } from "./actions.js";
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
