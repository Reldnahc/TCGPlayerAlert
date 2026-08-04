import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ActionConfig,
  AppConfig,
  PrinterConfig,
  WindowsPdfPrinterConfig,
} from "./config.js";
import { parseConfig } from "./config.js";
import {
  CONFIG_UI_CSS,
  CONFIG_UI_HTML,
  CONFIG_UI_JS,
} from "./config-ui-assets.js";
import { ConfigurationError } from "./errors.js";
import type { PriceUpdateQueueStore } from "./price-update-queue.js";
import {
  discoverInstalledPrinters,
  type PrinterDiscoveryResult,
} from "./printer-discovery.js";

interface OutputSettingsBase {
  readonly actionId: string;
  readonly enabled: boolean;
  readonly printerId: string;
  readonly printerName: string;
  readonly adapter: PrinterConfig["adapter"];
  readonly adapterLabel: string;
}

export interface AddressLabelOutputSettings extends OutputSettingsBase {
  readonly type: "print-address-label";
  readonly widthMm: number;
  readonly heightMm: number;
  readonly marginMm: number;
  readonly fontSize: number;
}

export interface PackingSlipOutputSettings extends OutputSettingsBase {
  readonly type: "print-packing-slip";
  readonly dpi?: number;
  readonly scale?: WindowsPdfPrinterConfig["scale"];
}

export type OutputSettings =
  AddressLabelOutputSettings | PackingSlipOutputSettings;

export interface ConfigurationUiSettings {
  readonly revision: string;
  readonly pollIntervalMinutes: number;
  readonly dryRun: boolean;
  readonly priceUpdateQueue: {
    readonly enabled: boolean;
    readonly delaySeconds: number;
  };
  readonly outputs: readonly OutputSettings[];
  readonly installedPrinters: PrinterDiscoveryResult["printers"];
  readonly discoveryIssue?: string;
}

export interface ConfigurationUiUpdate {
  readonly revision: string;
  readonly pollIntervalMinutes: number;
  readonly dryRun: boolean;
  readonly priceUpdateQueue: {
    readonly enabled: boolean;
    readonly delaySeconds: number;
  };
  readonly outputs: readonly OutputSettingsUpdate[];
}

export interface OutputSettingsUpdate {
  readonly actionId: string;
  readonly enabled: boolean;
  readonly printerName: string;
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly marginMm?: number;
  readonly fontSize?: number;
  readonly dpi?: number;
  readonly scale?: WindowsPdfPrinterConfig["scale"];
}

export interface ConfigurationServiceOptions {
  readonly configPath: string;
  readonly discoverPrinters?: () => Promise<PrinterDiscoveryResult>;
}

export class ConfigurationService {
  private readonly configPath: string;
  private readonly discoverPrinters: () => Promise<PrinterDiscoveryResult>;

  constructor(options: ConfigurationServiceOptions) {
    this.configPath = resolve(options.configPath);
    this.discoverPrinters =
      options.discoverPrinters ?? (() => discoverInstalledPrinters());
  }

  async read(): Promise<ConfigurationUiSettings> {
    const { config, revision } = await this.readVersionedConfig();
    return this.toUiSettings(config, revision, await this.discoverPrinters());
  }

  async save(value: unknown): Promise<ConfigurationUiSettings> {
    const current = await this.readVersionedConfig();
    const update = parseUiUpdate(value, current.config);
    if (update.revision !== current.revision) {
      throw new ConfigurationConflictError();
    }
    const candidate = applyUpdate(current.config, update);
    const validated = parseConfig(candidate);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    await writeAtomic(this.configPath, serialized);
    return this.toUiSettings(
      validated,
      revisionOf(serialized),
      await this.discoverPrinters(),
    );
  }

  private async readVersionedConfig(): Promise<{
    readonly config: AppConfig;
    readonly revision: string;
  }> {
    try {
      const serialized = await readFile(this.configPath, "utf8");
      return {
        config: parseConfig(JSON.parse(serialized) as unknown),
        revision: revisionOf(serialized),
      };
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError([
        `Unable to read valid JSON configuration at ${this.configPath}.`,
      ]);
    }
  }

  private toUiSettings(
    config: AppConfig,
    revision: string,
    discovery: PrinterDiscoveryResult,
  ): ConfigurationUiSettings {
    return {
      revision,
      pollIntervalMinutes: config.pollIntervalMinutes,
      dryRun: config.dryRun,
      priceUpdateQueue: {
        enabled: config.priceUpdateQueue.enabled,
        delaySeconds: config.priceUpdateQueue.delaySeconds,
      },
      outputs: Object.entries(config.actions).map(([actionId, action]) =>
        outputSettings(actionId, action, config.printers[action.printer]),
      ),
      installedPrinters: discovery.printers,
      ...(discovery.issue === undefined
        ? {}
        : { discoveryIssue: discovery.issue }),
    };
  }
}

export interface ConfigurationUiServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartConfigurationUiOptions {
  readonly configPath: string;
  readonly port?: number;
  readonly host?: string;
  readonly service?: ConfigurationService;
  readonly priceQueue?: PriceUpdateQueueStore;
  readonly priceWorkerRunning?: boolean;
}

export async function startConfigurationUi(
  options: StartConfigurationUiOptions,
): Promise<ConfigurationUiServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new ConfigurationError([
      "The configuration UI must bind to a loopback address.",
    ]);
  }
  const service =
    options.service ??
    new ConfigurationService({ configPath: options.configPath });
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      service,
      options.priceQueue,
      options.priceWorkerRunning === true,
    );
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port ?? 47831, host, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The configuration UI did not receive a TCP address.");
  }
  const displayHost = address.address === "::1" ? "[::1]" : address.address;
  return {
    url: `http://${displayHost}:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error === undefined) resolvePromise();
          else rejectPromise(error);
        });
      }),
  };
}

class ConfigurationConflictError extends Error {
  constructor() {
    super("Settings changed on disk.");
  }
}

function outputSettings(
  actionId: string,
  action: ActionConfig,
  printer: PrinterConfig | undefined,
): OutputSettings {
  if (printer === undefined) {
    throw new ConfigurationError([
      `Action ${actionId} references an unavailable printer.`,
    ]);
  }
  const base = {
    actionId,
    enabled: action.enabled !== false,
    printerId: action.printer,
    printerName: printer.printerName,
    adapter: printer.adapter,
    adapterLabel: adapterLabel(printer.adapter),
  };
  if (action.type === "print-address-label") {
    return {
      ...base,
      type: action.type,
      widthMm: action.page.widthMm,
      heightMm: action.page.heightMm,
      marginMm: action.page.marginMm,
      fontSize: action.page.fontSize,
    };
  }
  return {
    ...base,
    type: action.type,
    ...(printer.adapter === "windows-pdf"
      ? { dpi: printer.dpi, scale: printer.scale }
      : {}),
  };
}

function adapterLabel(adapter: PrinterConfig["adapter"]): string {
  if (adapter === "windows-native-label") return "Windows native label";
  if (adapter === "windows-pdf") return "Windows native PDF";
  return "Custom print command";
}

function parseUiUpdate(
  value: unknown,
  config: AppConfig,
): ConfigurationUiUpdate {
  const issues: string[] = [];
  const source = objectValue(value);
  if (source === undefined)
    issues.push("The settings update must be an object.");
  const revision = source?.revision;
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision)) {
    issues.push("The settings revision is invalid.");
  }
  const pollIntervalMinutes = source?.pollIntervalMinutes;
  if (
    !Number.isInteger(pollIntervalMinutes) ||
    Number(pollIntervalMinutes) < 1 ||
    Number(pollIntervalMinutes) > 1440
  ) {
    issues.push("The polling interval must be between 1 and 1440 minutes.");
  }
  const dryRun = source?.dryRun;
  if (typeof dryRun !== "boolean")
    issues.push("Dry run must be true or false.");
  const priceUpdateQueueSource = objectValue(source?.priceUpdateQueue);
  if (priceUpdateQueueSource === undefined) {
    issues.push("Price-update queue settings are required.");
  }
  const priceUpdateQueueEnabled = priceUpdateQueueSource?.enabled;
  if (typeof priceUpdateQueueEnabled !== "boolean") {
    issues.push("Price-update queue enabled must be true or false.");
  }
  const priceUpdateDelaySeconds = priceUpdateQueueSource?.delaySeconds;
  if (
    !Number.isInteger(priceUpdateDelaySeconds) ||
    Number(priceUpdateDelaySeconds) < 0 ||
    Number(priceUpdateDelaySeconds) > 3600
  ) {
    issues.push("Price-update delay must be between 0 and 3600 seconds.");
  }
  const outputValues = source?.outputs;
  if (!Array.isArray(outputValues))
    issues.push("Print actions must be an array.");
  const expectedActionIds = Object.keys(config.actions);
  const outputs = (Array.isArray(outputValues) ? outputValues : []).map(
    (output, index) => parseOutputUpdate(output, index, config, issues),
  );
  const receivedActionIds = outputs.map((output) => output.actionId);
  if (
    receivedActionIds.length !== expectedActionIds.length ||
    new Set(receivedActionIds).size !== receivedActionIds.length ||
    expectedActionIds.some((actionId) => !receivedActionIds.includes(actionId))
  ) {
    issues.push("The update must include every configured print action once.");
  }
  if (issues.length > 0) throw new ConfigurationError(issues);
  return {
    revision: revision as string,
    pollIntervalMinutes: Number(pollIntervalMinutes),
    dryRun: dryRun as boolean,
    priceUpdateQueue: {
      enabled: priceUpdateQueueEnabled as boolean,
      delaySeconds: Number(priceUpdateDelaySeconds),
    },
    outputs,
  };
}

function parseOutputUpdate(
  value: unknown,
  index: number,
  config: AppConfig,
  issues: string[],
): OutputSettingsUpdate {
  const path = `Print action ${String(index + 1)}`;
  const source = objectValue(value);
  const actionId = source?.actionId;
  const action =
    typeof actionId === "string" ? config.actions[actionId] : undefined;
  if (action === undefined) issues.push(`${path} has an unknown action id.`);
  if (typeof source?.enabled !== "boolean") {
    issues.push(`${path} enabled state must be true or false.`);
  }
  const printerName = source?.printerName;
  if (!safeText(printerName))
    issues.push(`${path} requires a valid printer name.`);
  const result: OutputSettingsUpdate = {
    actionId: typeof actionId === "string" ? actionId : "invalid",
    enabled: source?.enabled === true,
    printerName: typeof printerName === "string" ? printerName.trim() : "",
  };
  if (action?.type === "print-address-label") {
    return {
      ...result,
      widthMm: boundedNumber(source?.widthMm, 20, 300, `${path} width`, issues),
      heightMm: boundedNumber(
        source?.heightMm,
        20,
        300,
        `${path} height`,
        issues,
      ),
      marginMm: boundedNumber(
        source?.marginMm,
        0,
        50,
        `${path} margin`,
        issues,
      ),
      fontSize: boundedNumber(
        source?.fontSize,
        6,
        72,
        `${path} font size`,
        issues,
      ),
    };
  }
  const printer =
    action === undefined ? undefined : config.printers[action.printer];
  if (printer?.adapter === "windows-pdf") {
    const scale = source?.scale;
    if (scale !== "actual-size" && scale !== "fit" && scale !== "shrink") {
      issues.push(`${path} has an invalid page scaling mode.`);
    }
    return {
      ...result,
      dpi: boundedInteger(source?.dpi, 72, 600, `${path} DPI`, issues),
      scale: scale as WindowsPdfPrinterConfig["scale"],
    };
  }
  return result;
}

function applyUpdate(
  config: AppConfig,
  update: ConfigurationUiUpdate,
): AppConfig {
  const updates = new Map(
    update.outputs.map((output) => [output.actionId, output]),
  );
  const requestedPrinterNames = new Map<string, string>();
  for (const [actionId, action] of Object.entries(config.actions)) {
    const output = updates.get(actionId);
    if (output === undefined) continue;
    const existing = requestedPrinterNames.get(action.printer);
    if (existing !== undefined && existing !== output.printerName) {
      throw new ConfigurationError([
        `Actions sharing printer ${action.printer} must select the same Windows printer.`,
      ]);
    }
    requestedPrinterNames.set(action.printer, output.printerName);
  }
  const printers = Object.fromEntries<PrinterConfig>(
    Object.entries(config.printers).map(([printerId, printer]) => {
      const printerName =
        requestedPrinterNames.get(printerId) ?? printer.printerName;
      const associatedUpdate = Object.entries(config.actions)
        .filter(([, action]) => action.printer === printerId)
        .map(([actionId]) => updates.get(actionId))
        .find((value) => value !== undefined);
      if (printer.adapter === "windows-pdf" && associatedUpdate !== undefined) {
        return [
          printerId,
          {
            ...printer,
            printerName,
            ...(associatedUpdate.dpi === undefined
              ? {}
              : { dpi: associatedUpdate.dpi }),
            ...(associatedUpdate.scale === undefined
              ? {}
              : { scale: associatedUpdate.scale }),
          },
        ];
      }
      return [printerId, { ...printer, printerName }];
    }),
  );
  const actions = Object.fromEntries<ActionConfig>(
    Object.entries(config.actions).map(([actionId, action]) => {
      const output = updates.get(actionId);
      if (output === undefined) return [actionId, action];
      if (action.type === "print-address-label") {
        return [
          actionId,
          {
            ...action,
            enabled: output.enabled,
            page: {
              widthMm: output.widthMm ?? action.page.widthMm,
              heightMm: output.heightMm ?? action.page.heightMm,
              marginMm: output.marginMm ?? action.page.marginMm,
              fontSize: output.fontSize ?? action.page.fontSize,
            },
          },
        ];
      }
      return [actionId, { ...action, enabled: output.enabled }];
    }),
  );
  return {
    ...config,
    pollIntervalMinutes: update.pollIntervalMinutes,
    dryRun: update.dryRun,
    priceUpdateQueue: {
      ...config.priceUpdateQueue,
      enabled: update.priceUpdateQueue.enabled,
      delaySeconds: update.priceUpdateQueue.delaySeconds,
    },
    printers,
    actions,
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ConfigurationService,
  priceQueue: PriceUpdateQueueStore | undefined,
  priceWorkerRunning: boolean,
): Promise<void> {
  setSecurityHeaders(response);
  if (!isLoopbackHost(request.headers.host)) {
    sendJson(response, 403, {
      message: "This UI is available on localhost only.",
    });
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/") {
      send(response, 200, "text/html; charset=utf-8", CONFIG_UI_HTML);
    } else if (request.method === "GET" && url.pathname === "/styles.css") {
      send(response, 200, "text/css; charset=utf-8", CONFIG_UI_CSS);
    } else if (request.method === "GET" && url.pathname === "/app.js") {
      send(response, 200, "text/javascript; charset=utf-8", CONFIG_UI_JS);
    } else if (request.method === "GET" && url.pathname === "/api/settings") {
      sendJson(response, 200, await service.read());
    } else if (request.method === "PUT" && url.pathname === "/api/settings") {
      if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
        sendJson(response, 403, {
          message: "The request origin is not allowed.",
        });
        return;
      }
      if (request.headers["content-type"] !== "application/json") {
        sendJson(response, 415, {
          message: "Content-Type must be application/json.",
        });
        return;
      }
      sendJson(response, 200, await service.save(await readJsonBody(request)));
    } else if (
      request.method === "GET" &&
      url.pathname === "/api/price-updates"
    ) {
      if (priceQueue === undefined) {
        sendJson(response, 503, {
          message: "The price-update queue is unavailable.",
        });
        return;
      }
      sendJson(response, 200, {
        ...(await priceQueue.snapshot()),
        workerRunning: priceWorkerRunning,
      });
    } else if (
      request.method === "POST" &&
      url.pathname === "/api/price-updates"
    ) {
      if (!isAllowedMutationRequest(request, response)) return;
      if (priceQueue === undefined) {
        sendJson(response, 503, {
          message: "The price-update queue is unavailable.",
        });
        return;
      }
      sendJson(response, 202, {
        jobs: await priceQueue.enqueue(await readJsonBody(request)),
      });
    } else if (
      request.method === "DELETE" &&
      /^\/api\/price-updates\/[0-9a-f-]{36}$/iu.test(url.pathname)
    ) {
      if (!isAllowedMutationRequest(request, response)) return;
      if (priceQueue === undefined) {
        sendJson(response, 503, {
          message: "The price-update queue is unavailable.",
        });
        return;
      }
      const jobId = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      sendJson(response, 200, { job: await priceQueue.cancel(jobId) });
    } else {
      sendJson(response, 404, { message: "Not found." });
    }
  } catch (error) {
    if (error instanceof ConfigurationConflictError) {
      sendJson(response, 409, {
        message: "Settings changed on disk. Refresh and try again.",
      });
    } else if (error instanceof ConfigurationError) {
      sendJson(response, 400, {
        message: "Settings are invalid.",
        issues: error.issues,
      });
    } else if (error instanceof SyntaxError) {
      sendJson(response, 400, {
        message: "The request body must contain valid JSON.",
      });
    } else if (error instanceof Error && "code" in error) {
      sendJson(response, 409, {
        message: error.message,
        code: String(error.code),
      });
    } else {
      sendJson(response, 500, {
        message: "The configuration operation failed.",
      });
    }
  }
}

function isAllowedMutationRequest(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
    sendJson(response, 403, { message: "The request origin is not allowed." });
    return false;
  }
  if (request.headers["content-type"] !== "application/json") {
    sendJson(response, 415, {
      message: "Content-Type must be application/json.",
    });
    return false;
  }
  return true;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      parsed.host === host &&
      isLoopbackHost(parsed.host)
    );
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 262_144) {
      throw new ConfigurationError(["The settings update is too large."]);
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  send(
    response,
    status,
    "application/json; charset=utf-8",
    JSON.stringify(value),
  );
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= 1024 &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  issues: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    issues.push(
      `${label} must be between ${String(minimum)} and ${String(maximum)}.`,
    );
    return minimum;
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  issues: string[],
): number {
  const parsed = boundedNumber(value, minimum, maximum, label, issues);
  if (!Number.isInteger(value)) {
    issues.push(`${label} must be a whole number.`);
  }
  return parsed;
}

function revisionOf(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
