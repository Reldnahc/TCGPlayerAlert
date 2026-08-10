import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { isTcgplayerApiError } from "tcgplayer-private-api";
import type {
  ActionConfig,
  AppConfig,
  MerchandiseProfileConfig,
  PrinterConfig,
  RepricingProfileConfig,
  WindowsPdfPrinterConfig,
} from "./config.js";
import { parseConfig } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { parseGamePricingModules } from "./game-pricing.js";
import type { PriceUpdateQueueStore } from "./price-update-queue.js";
import type {
  InventoryAdditionQueueStore,
  InventoryAdditionService,
} from "./inventory-additions.js";
import {
  discoverInstalledPrinters,
  type PrinterDiscoveryResult,
} from "./printer-discovery.js";
import type { RepricingService } from "./repricing.js";
import type { OrderManagementService } from "./order-management.js";
import type { OrderSyncCoordinator } from "./order-sync.js";
import type { PaymentManagementService } from "./payment-management.js";
import type { FeedbackManagementService } from "./feedback-management.js";
import type { MessageManagementService } from "./message-management.js";
import type { SellerSessionService } from "./seller-session.js";
import type { ShipmentScannerService } from "./shipment-scanner.js";
import type { BackgroundShipmentScanner } from "./background-shipment-scanner.js";
import {
  discoverSystemCameras,
  type CameraDiscoveryResult,
} from "./camera-capture.js";
import type { ConfigurationRouteContext } from "./configuration-ui/context.js";
import {
  containsControlCharacter,
  HttpRouteError,
  objectValue,
  safeText,
  sendBytes,
  sendJson,
} from "./configuration-ui/http.js";
import { dispatchConfigurationRoute } from "./configuration-ui/router.js";
import type { SellerRequestMetrics } from "./seller-api.js";

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
  readonly confirmBeforeMarkingShipped: boolean;
  readonly shipmentScanner: {
    readonly enabled: boolean;
    readonly automaticallyMarkShipped: boolean;
    readonly soundEnabled: boolean;
    readonly camera: {
      readonly enabled: boolean;
      readonly deviceId: string;
    };
  };
  readonly priceUpdateQueue: {
    readonly enabled: boolean;
    readonly delaySeconds: number;
  };
  readonly inventoryAdditionQueue: {
    readonly enabled: boolean;
    readonly delaySeconds: number;
  };
  readonly merchandiseProfiles: readonly MerchandiseProfileConfig[];
  readonly defaultMerchandiseProfileId: string;
  readonly repricingProfiles: readonly RepricingProfileConfig[];
  readonly defaultRepricingProfileId: string;
  readonly outputs: readonly OutputSettings[];
  readonly installedPrinters: PrinterDiscoveryResult["printers"];
  readonly installedCameras: CameraDiscoveryResult["cameras"];
  readonly discoveryIssue?: string;
  readonly cameraDiscoveryIssue?: string;
}

export interface ConfigurationUiUpdate {
  readonly revision: string;
  readonly pollIntervalMinutes: number;
  readonly confirmBeforeMarkingShipped: boolean;
  readonly shipmentScanner: {
    readonly enabled: boolean;
    readonly automaticallyMarkShipped: boolean;
    readonly soundEnabled: boolean;
    readonly camera: {
      readonly enabled: boolean;
      readonly deviceId: string;
    };
  };
  readonly priceUpdateQueue: {
    readonly enabled: boolean;
    readonly delaySeconds: number;
  };
  readonly inventoryAdditionQueue: {
    readonly enabled: boolean;
    readonly delaySeconds: number;
  };
  readonly merchandiseProfiles: readonly MerchandiseProfileConfig[];
  readonly defaultMerchandiseProfileId: string;
  readonly repricingProfiles: readonly RepricingProfileConfig[];
  readonly defaultRepricingProfileId: string;
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
  readonly discoverCameras?: () => Promise<CameraDiscoveryResult>;
}

export class ConfigurationService {
  private readonly configPath: string;
  private readonly discoverPrinters: () => Promise<PrinterDiscoveryResult>;
  private readonly discoverCameras: () => Promise<CameraDiscoveryResult>;

  constructor(options: ConfigurationServiceOptions) {
    this.configPath = resolve(options.configPath);
    this.discoverPrinters =
      options.discoverPrinters ?? (() => discoverInstalledPrinters());
    this.discoverCameras =
      options.discoverCameras ?? (() => discoverSystemCameras());
  }

  async read(): Promise<ConfigurationUiSettings> {
    const { config, revision } = await this.readVersionedConfig();
    const [printers, cameras] = await Promise.all([
      this.discoverPrinters(),
      this.discoverCameras(),
    ]);
    return this.toUiSettings(config, revision, printers, cameras);
  }

  async save(value: unknown): Promise<ConfigurationUiSettings> {
    const validated = await this.validatedCandidate(value);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    await writeAtomic(this.configPath, serialized);
    const [printers, cameras] = await Promise.all([
      this.discoverPrinters(),
      this.discoverCameras(),
    ]);
    return this.toUiSettings(
      validated,
      revisionOf(serialized),
      printers,
      cameras,
    );
  }

  async preview(value: unknown): Promise<AppConfig> {
    return this.validatedCandidate(value);
  }

  private async validatedCandidate(value: unknown): Promise<AppConfig> {
    const current = await this.readVersionedConfig();
    const update = parseUiUpdate(value, current.config);
    if (update.revision !== current.revision) {
      throw new ConfigurationConflictError();
    }
    return parseConfig(applyUpdate(current.config, update));
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
    cameraDiscovery: CameraDiscoveryResult,
  ): ConfigurationUiSettings {
    return {
      revision,
      pollIntervalMinutes: config.pollIntervalMinutes,
      confirmBeforeMarkingShipped: config.confirmBeforeMarkingShipped,
      shipmentScanner: {
        enabled: config.shipmentScanner.enabled,
        automaticallyMarkShipped:
          config.shipmentScanner.automaticallyMarkShipped,
        soundEnabled: config.shipmentScanner.soundEnabled,
        camera: config.shipmentScanner.camera,
      },
      priceUpdateQueue: {
        enabled: config.priceUpdateQueue.enabled,
        delaySeconds: config.priceUpdateQueue.delaySeconds,
      },
      inventoryAdditionQueue: {
        enabled: config.inventoryAdditionQueue.enabled,
        delaySeconds: config.inventoryAdditionQueue.delaySeconds,
      },
      merchandiseProfiles: config.merchandiseProfiles,
      defaultMerchandiseProfileId: config.defaultMerchandiseProfileId,
      repricingProfiles: config.repricingProfiles,
      defaultRepricingProfileId: config.defaultRepricingProfileId,
      outputs: Object.entries(config.actions).map(([actionId, action]) =>
        outputSettings(actionId, action, config.printers[action.printer]),
      ),
      installedPrinters: discovery.printers,
      installedCameras: cameraDiscovery.cameras,
      ...(discovery.issue === undefined
        ? {}
        : { discoveryIssue: discovery.issue }),
      ...(cameraDiscovery.issue === undefined
        ? {}
        : { cameraDiscoveryIssue: cameraDiscovery.issue }),
    };
  }
}

export interface ConfigurationUiServer {
  readonly url: string;
  close(): Promise<void>;
}

export type ConfigurationPrintTest = (
  config: AppConfig,
  actionId: string,
) => Promise<void>;

export type ConfigurationAddressLabelPrint = (
  lines: readonly string[],
  signal?: AbortSignal,
) => Promise<void>;

export interface StartConfigurationUiOptions {
  readonly configPath: string;
  readonly port?: number;
  readonly host?: string;
  readonly service?: ConfigurationService;
  readonly priceQueue?: PriceUpdateQueueStore;
  readonly priceWorkerRunning?: boolean;
  readonly repricingService?: RepricingService;
  readonly inventoryQueue?: InventoryAdditionQueueStore;
  readonly inventoryWorkerRunning?: boolean;
  readonly inventoryService?: InventoryAdditionService;
  readonly orderService?: OrderManagementService;
  readonly orderSync?: OrderSyncCoordinator;
  readonly paymentService?: PaymentManagementService;
  readonly feedbackService?: FeedbackManagementService;
  readonly messageService?: MessageManagementService;
  readonly shipmentScannerService?: ShipmentScannerService;
  readonly backgroundShipmentScanner?: BackgroundShipmentScanner;
  readonly sessionManager?: SellerSessionService;
  readonly executeAddressLabel?: ConfigurationAddressLabelPrint;
  readonly executePrintTest?: ConfigurationPrintTest;
  readonly sellerRequestMetrics?: () => SellerRequestMetrics;
  /** Built Vite application directory. Defaults to dist/web from the process working directory. */
  readonly webDirectory?: string;
}

interface ConfigurationUiAssets {
  readonly index: Uint8Array;
  readonly files: ReadonlyMap<
    string,
    { readonly bytes: Uint8Array; readonly contentType: string }
  >;
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
  const webAssets = await loadConfigurationUiAssets(
    options.webDirectory ?? resolve("dist/web"),
  );
  const runtime: ConfigurationUiRuntime = {
    service,
    priceQueue: options.priceQueue,
    priceWorkerRunning: options.priceWorkerRunning === true,
    repricingService: options.repricingService,
    inventoryQueue: options.inventoryQueue,
    inventoryWorkerRunning: options.inventoryWorkerRunning === true,
    inventoryService: options.inventoryService,
    orderService: options.orderService,
    orderSync: options.orderSync,
    paymentService: options.paymentService,
    feedbackService: options.feedbackService,
    messageService: options.messageService,
    shipmentScannerService: options.shipmentScannerService,
    backgroundShipmentScanner: options.backgroundShipmentScanner,
    sessionManager: options.sessionManager,
    executeAddressLabel: options.executeAddressLabel,
    executePrintTest: options.executePrintTest,
    sellerRequestMetrics: options.sellerRequestMetrics,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime, webAssets);
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
  const confirmBeforeMarkingShipped = source?.confirmBeforeMarkingShipped;
  if (typeof confirmBeforeMarkingShipped !== "boolean") {
    issues.push("Mark-shipped confirmation must be true or false.");
  }
  const shipmentScanner = objectValue(source?.shipmentScanner);
  const shipmentScannerEnabled = shipmentScanner?.enabled;
  const automaticallyMarkShipped = shipmentScanner?.automaticallyMarkShipped;
  const shipmentScannerSoundEnabled = shipmentScanner?.soundEnabled;
  const shipmentScannerCamera = objectValue(shipmentScanner?.camera);
  const shipmentScannerCameraEnabled = shipmentScannerCamera?.enabled;
  const shipmentScannerCameraDeviceId = shipmentScannerCamera?.deviceId;
  if (typeof shipmentScannerEnabled !== "boolean") {
    issues.push("Shipment scanning must be enabled or disabled.");
  }
  if (typeof automaticallyMarkShipped !== "boolean") {
    issues.push("Automatic scan shipment changes must be enabled or disabled.");
  }
  if (typeof shipmentScannerSoundEnabled !== "boolean") {
    issues.push("Shipment scan sounds must be enabled or disabled.");
  }
  if (typeof shipmentScannerCameraEnabled !== "boolean") {
    issues.push("The background camera must be enabled or disabled.");
  }
  if (
    typeof shipmentScannerCameraDeviceId !== "string" ||
    shipmentScannerCameraDeviceId.length > 256 ||
    containsControlCharacter(shipmentScannerCameraDeviceId)
  ) {
    issues.push("The background camera device id is invalid.");
  }
  if (automaticallyMarkShipped === true && shipmentScannerEnabled !== true) {
    issues.push(
      "Shipment scanning must be enabled before automatic shipment changes can be enabled.",
    );
  }
  if (
    shipmentScannerCameraEnabled === true &&
    shipmentScannerEnabled !== true
  ) {
    issues.push(
      "Shipment scanning must be enabled before the background camera can be enabled.",
    );
  }
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
  const inventoryAdditionQueueSource = objectValue(
    source?.inventoryAdditionQueue,
  );
  if (inventoryAdditionQueueSource === undefined) {
    issues.push("Inventory-addition queue settings are required.");
  }
  const inventoryAdditionQueueEnabled = inventoryAdditionQueueSource?.enabled;
  if (typeof inventoryAdditionQueueEnabled !== "boolean") {
    issues.push("Inventory-addition queue enabled must be true or false.");
  }
  const inventoryAdditionDelaySeconds =
    inventoryAdditionQueueSource?.delaySeconds;
  if (
    !Number.isInteger(inventoryAdditionDelaySeconds) ||
    Number(inventoryAdditionDelaySeconds) < 0 ||
    Number(inventoryAdditionDelaySeconds) > 3600
  ) {
    issues.push("Inventory-addition delay must be between 0 and 3600 seconds.");
  }
  let merchandiseProfiles = config.merchandiseProfiles;
  let defaultMerchandiseProfileId = config.defaultMerchandiseProfileId;
  const profileValues = source?.merchandiseProfiles;
  const defaultProfileValue = source?.defaultMerchandiseProfileId;
  if (profileValues !== undefined || defaultProfileValue !== undefined) {
    if (
      !Array.isArray(profileValues) ||
      profileValues.length < 1 ||
      profileValues.length > 20
    ) {
      issues.push(
        "Merchandise profiles must contain between 1 and 20 profiles.",
      );
    }
    merchandiseProfiles = (
      Array.isArray(profileValues) ? profileValues : []
    ).map((profile, index) =>
      parseMerchandiseProfileUpdate(profile, index, issues),
    );
    if (
      new Set(merchandiseProfiles.map((profile) => profile.id)).size !==
      merchandiseProfiles.length
    ) {
      issues.push("Merchandise profile ids must be unique.");
    }
    if (
      typeof defaultProfileValue !== "string" ||
      !merchandiseProfiles.some((profile) => profile.id === defaultProfileValue)
    ) {
      issues.push("The default merchandise profile must reference a profile.");
    } else {
      defaultMerchandiseProfileId = defaultProfileValue;
    }
  }
  let repricingProfiles = config.repricingProfiles;
  let defaultRepricingProfileId = config.defaultRepricingProfileId;
  const repricingProfileValues = source?.repricingProfiles;
  const defaultRepricingProfileValue = source?.defaultRepricingProfileId;
  if (
    repricingProfileValues !== undefined ||
    defaultRepricingProfileValue !== undefined
  ) {
    if (
      !Array.isArray(repricingProfileValues) ||
      repricingProfileValues.length < 1 ||
      repricingProfileValues.length > 20
    ) {
      issues.push("Pricing profiles must contain between 1 and 20 profiles.");
    }
    repricingProfiles = (
      Array.isArray(repricingProfileValues) ? repricingProfileValues : []
    ).map((profile, index) =>
      parseRepricingProfileUpdate(profile, index, issues),
    );
    if (
      new Set(repricingProfiles.map((profile) => profile.id)).size !==
      repricingProfiles.length
    ) {
      issues.push("Pricing profile ids must be unique.");
    }
    if (
      typeof defaultRepricingProfileValue !== "string" ||
      !repricingProfiles.some(
        (profile) => profile.id === defaultRepricingProfileValue,
      )
    ) {
      issues.push("The default pricing profile must reference a profile.");
    } else {
      defaultRepricingProfileId = defaultRepricingProfileValue;
    }
  }
  for (const [index, profile] of merchandiseProfiles.entries()) {
    if (
      !repricingProfiles.some(
        (pricingProfile) => pricingProfile.id === profile.pricingProfileId,
      )
    ) {
      issues.push(
        `Merchandise profile ${String(index + 1)} must reference an existing pricing profile.`,
      );
    }
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
    confirmBeforeMarkingShipped: confirmBeforeMarkingShipped as boolean,
    shipmentScanner: {
      enabled: shipmentScannerEnabled as boolean,
      automaticallyMarkShipped: automaticallyMarkShipped as boolean,
      soundEnabled: shipmentScannerSoundEnabled as boolean,
      camera: {
        enabled: shipmentScannerCameraEnabled as boolean,
        deviceId:
          typeof shipmentScannerCameraDeviceId === "string"
            ? shipmentScannerCameraDeviceId.trim()
            : "",
      },
    },
    priceUpdateQueue: {
      enabled: priceUpdateQueueEnabled as boolean,
      delaySeconds: Number(priceUpdateDelaySeconds),
    },
    inventoryAdditionQueue: {
      enabled: inventoryAdditionQueueEnabled as boolean,
      delaySeconds: Number(inventoryAdditionDelaySeconds),
    },
    merchandiseProfiles,
    defaultMerchandiseProfileId,
    repricingProfiles,
    defaultRepricingProfileId,
    outputs,
  };
}

function parseMerchandiseProfileUpdate(
  value: unknown,
  index: number,
  issues: string[],
): MerchandiseProfileConfig {
  const source = objectValue(value);
  const path = `Merchandise profile ${String(index + 1)}`;
  const id = source?.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) {
    issues.push(`${path} has an invalid id.`);
  }
  const name = source?.name;
  if (!safeText(name)) issues.push(`${path} requires a valid name.`);
  const language = source?.language;
  if (!safeText(language)) issues.push(`${path} requires a valid language.`);
  const defaultCondition = source?.defaultCondition;
  if (
    defaultCondition !== "Near Mint" &&
    defaultCondition !== "Lightly Played" &&
    defaultCondition !== "Moderately Played" &&
    defaultCondition !== "Heavily Played" &&
    defaultCondition !== "Damaged" &&
    defaultCondition !== "Unopened"
  ) {
    issues.push(`${path} has an invalid default condition.`);
  }
  const defaultPrinting = source?.defaultPrinting;
  if (defaultPrinting !== "Normal" && defaultPrinting !== "Foil") {
    issues.push(`${path} has an invalid default printing.`);
  }
  const pricingProfileId = source?.pricingProfileId;
  if (
    typeof pricingProfileId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(pricingProfileId)
  ) {
    issues.push(`${path} has an invalid pricing profile reference.`);
  }
  return {
    id: typeof id === "string" ? id : "invalid",
    name: typeof name === "string" ? name.trim() : "",
    language: typeof language === "string" ? language.trim() : "",
    estimatedShippingPrice: boundedNumber(
      source?.estimatedShippingPrice,
      0,
      1_000_000,
      `${path} shipping rate`,
      issues,
    ),
    defaultCondition:
      defaultCondition as MerchandiseProfileConfig["defaultCondition"],
    defaultPrinting:
      defaultPrinting as MerchandiseProfileConfig["defaultPrinting"],
    pricingProfileId:
      typeof pricingProfileId === "string" ? pricingProfileId : "invalid",
  };
}

function parseRepricingProfileUpdate(
  value: unknown,
  index: number,
  issues: string[],
): RepricingProfileConfig {
  const source = objectValue(value);
  const path = `Pricing profile ${String(index + 1)}`;
  const id = source?.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) {
    issues.push(`${path} has an invalid id.`);
  }
  const name = source?.name;
  if (!safeText(name)) issues.push(`${path} requires a valid name.`);
  const conditionPolicy = source?.conditionPolicy;
  if (conditionPolicy !== "same" && conditionPolicy !== "same-or-better") {
    issues.push(`${path} has an invalid condition comparison.`);
  }
  const priceBasis = source?.priceBasis;
  if (priceBasis !== "item" && priceBasis !== "delivered") {
    issues.push(`${path} has an invalid price basis.`);
  }
  if (typeof source?.allowPriceIncreases !== "boolean") {
    issues.push(`${path} requires a price-increase setting.`);
  }
  const sparseMarketFallback = source?.sparseMarketFallback;
  if (
    sparseMarketFallback !== "skip" &&
    sparseMarketFallback !== "higher-of-market-and-lowest" &&
    sparseMarketFallback !== "market-then-lowest" &&
    sparseMarketFallback !== "lowest-then-market"
  ) {
    issues.push(`${path} has an invalid sparse-market fallback.`);
  }
  const rangeValues = source?.ranges;
  if (
    !Array.isArray(rangeValues) ||
    rangeValues.length < 1 ||
    rangeValues.length > 20
  ) {
    issues.push(`${path} must contain between 1 and 20 ranges.`);
  }
  const ranges = (Array.isArray(rangeValues) ? rangeValues : []).map(
    (range, rangeIndex) => {
      const rangeSource = objectValue(range);
      const rangePath = `${path} range ${String(rangeIndex + 1)}`;
      const priceSource = rangeSource?.priceSource;
      if (priceSource !== "lowest" && priceSource !== "market") {
        issues.push(`${rangePath} has an invalid price source.`);
      }
      const gapAction = rangeSource?.gapAction;
      const supportMode = rangeSource?.supportMode ?? "adjacent";
      if (
        gapAction !== "follow-lowest" &&
        gapAction !== "use-next" &&
        gapAction !== "skip"
      ) {
        issues.push(`${rangePath} has an invalid gap action.`);
      }
      if (supportMode !== "adjacent" && supportMode !== "cluster") {
        issues.push(`${rangePath} has an invalid support mode.`);
      }
      const maximumPrice =
        rangeIndex < (Array.isArray(rangeValues) ? rangeValues.length - 1 : 0)
          ? boundedNumber(
              rangeSource?.maximumPrice,
              0.01,
              1_000_000,
              `${rangePath} maximum price`,
              issues,
            )
          : undefined;
      if (
        rangeIndex ===
          (Array.isArray(rangeValues) ? rangeValues.length - 1 : -1) &&
        rangeSource?.maximumPrice !== undefined
      ) {
        issues.push(`${rangePath} must be open ended.`);
      }
      return {
        ...(maximumPrice === undefined ? {} : { maximumPrice }),
        minimumListings: boundedNumber(
          rangeSource?.minimumListings ?? 0,
          0,
          100,
          `${rangePath} minimum listings`,
          issues,
        ),
        priceSource:
          priceSource as RepricingProfileConfig["ranges"][number]["priceSource"],
        percentage: boundedNumber(
          rangeSource?.percentage,
          1,
          500,
          `${rangePath} percentage`,
          issues,
        ),
        gapThresholdPercent: boundedNumber(
          rangeSource?.gapThresholdPercent,
          0,
          10_000,
          `${rangePath} gap threshold`,
          issues,
        ),
        gapAction:
          gapAction as RepricingProfileConfig["ranges"][number]["gapAction"],
        supportMode: supportMode as NonNullable<
          RepricingProfileConfig["ranges"][number]["supportMode"]
        >,
        minimumSellerSupport: boundedNumber(
          rangeSource?.minimumSellerSupport ?? 2,
          1,
          100,
          `${rangePath} minimum seller support`,
          issues,
        ),
        supportWindowPercent: boundedNumber(
          rangeSource?.supportWindowPercent ?? 5,
          0,
          100,
          `${rangePath} support window`,
          issues,
        ),
      };
    },
  );
  for (let rangeIndex = 1; rangeIndex < ranges.length; rangeIndex += 1) {
    const previous = ranges[rangeIndex - 1]?.maximumPrice;
    const current = ranges[rangeIndex]?.maximumPrice;
    if (
      previous === undefined ||
      (current !== undefined && current <= previous)
    ) {
      issues.push(`${path} range maximum prices must increase.`);
      break;
    }
  }
  return {
    id: typeof id === "string" ? id : "invalid",
    name: typeof name === "string" ? name.trim() : "",
    minimumPrice: boundedNumber(
      source?.minimumPrice,
      0.01,
      1_000_000,
      `${path} minimum price`,
      issues,
    ),
    conditionPolicy:
      conditionPolicy as RepricingProfileConfig["conditionPolicy"],
    priceBasis: priceBasis as RepricingProfileConfig["priceBasis"],
    adjustmentCents: boundedInteger(
      source?.adjustmentCents,
      0,
      100_000,
      `${path} adjustment`,
      issues,
    ),
    allowPriceIncreases: source?.allowPriceIncreases as boolean,
    sparseMarketFallback:
      sparseMarketFallback as RepricingProfileConfig["sparseMarketFallback"],
    gamePricingModules: parseGamePricingModules(
      source?.gamePricingModules,
      `${path} game pricing modules`,
      issues,
    ),
    ranges,
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
    confirmBeforeMarkingShipped: update.confirmBeforeMarkingShipped,
    shipmentScanner: {
      ...config.shipmentScanner,
      enabled: update.shipmentScanner.enabled,
      automaticallyMarkShipped: update.shipmentScanner.automaticallyMarkShipped,
      soundEnabled: update.shipmentScanner.soundEnabled,
      camera: update.shipmentScanner.camera,
    },
    priceUpdateQueue: {
      ...config.priceUpdateQueue,
      enabled: update.priceUpdateQueue.enabled,
      delaySeconds: update.priceUpdateQueue.delaySeconds,
    },
    inventoryAdditionQueue: {
      ...config.inventoryAdditionQueue,
      enabled: update.inventoryAdditionQueue.enabled,
      delaySeconds: update.inventoryAdditionQueue.delaySeconds,
    },
    merchandiseProfiles: update.merchandiseProfiles,
    defaultMerchandiseProfileId: update.defaultMerchandiseProfileId,
    repricingProfiles: update.repricingProfiles,
    defaultRepricingProfileId: update.defaultRepricingProfileId,
    printers,
    actions,
  };
}

async function loadConfigurationUiAssets(
  directory: string,
): Promise<ConfigurationUiAssets> {
  const absoluteDirectory = resolve(directory);
  const index = await readFile(resolve(absoluteDirectory, "index.html"));
  const files = new Map<
    string,
    { readonly bytes: Uint8Array; readonly contentType: string }
  >();
  const pending = [absoluteDirectory];
  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    if (currentDirectory === undefined) break;
    for (const entry of await readdir(currentDirectory, {
      withFileTypes: true,
    })) {
      if (!/^[a-zA-Z0-9._-]+$/u.test(entry.name)) continue;
      const path = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(absoluteDirectory, path)
        .split(sep)
        .join("/");
      if (relativePath === "index.html") continue;
      const extension = entry.name
        .slice(entry.name.lastIndexOf("."))
        .toLowerCase();
      const contentType =
        extension === ".css"
          ? "text/css; charset=utf-8"
          : extension === ".js"
            ? "text/javascript; charset=utf-8"
            : extension === ".svg"
              ? "image/svg+xml"
              : extension === ".png"
                ? "image/png"
                : extension === ".woff2"
                  ? "font/woff2"
                  : extension === ".wasm"
                    ? "application/wasm"
                    : "application/octet-stream";
      files.set(`/${relativePath}`, {
        bytes: await readFile(path),
        contentType,
      });
    }
  }
  return { index, files };
}

type ConfigurationUiRuntime = Omit<
  ConfigurationRouteContext,
  "request" | "response" | "url" | "extensionOrigin"
>;

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: ConfigurationUiRuntime,
  webAssets: ConfigurationUiAssets,
): Promise<void> {
  setSecurityHeaders(response);
  if (!isLoopbackHost(request.headers.host)) {
    sendJson(response, 403, {
      message: "This UI is available on localhost only.",
    });
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  const extensionOrigin = browserExtensionOrigin(request.headers.origin);
  if (extensionOrigin !== undefined && url.pathname === "/api/auth/session") {
    setExtensionCorsHeaders(request, response, extensionOrigin);
  }
  const browserSessionMutation =
    request.method === "POST" &&
    url.pathname === "/api/auth/session" &&
    extensionOrigin !== undefined;
  if (
    isMutationMethod(request.method) &&
    !browserSessionMutation &&
    !isAllowedMutationRequest(request, response)
  ) {
    return;
  }
  try {
    if (request.method === "GET" && url.pathname === "/") {
      sendBytes(response, 200, "text/html; charset=utf-8", webAssets.index);
    } else if (request.method === "GET" && webAssets.files.has(url.pathname)) {
      const asset = webAssets.files.get(url.pathname);
      if (asset === undefined) {
        throw new Error("The requested UI asset is unavailable.");
      }
      sendBytes(response, 200, asset.contentType, asset.bytes);
    } else {
      const handled = await dispatchConfigurationRoute({
        ...runtime,
        request,
        response,
        url,
        extensionOrigin,
      });
      if (!handled) sendJson(response, 404, { message: "Not found." });
    }
  } catch (error) {
    if ((request.destroyed && !request.complete) || response.destroyed) return;
    if (error instanceof HttpRouteError) {
      sendJson(response, error.status, { message: error.message });
    } else if (error instanceof ConfigurationConflictError) {
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
    } else if (isTcgplayerApiError(error)) {
      const status =
        error.code === "AUTHENTICATION_REQUIRED"
          ? 401
          : error.code === "FORBIDDEN"
            ? 403
            : error.code === "NOT_FOUND"
              ? 404
              : error.code === "INVALID_ARGUMENT"
                ? 400
                : 502;
      sendJson(response, status, {
        message: error.message,
        code: error.code,
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

function isMutationMethod(method: string | undefined): boolean {
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

function browserExtensionOrigin(
  origin: string | undefined,
): string | undefined {
  if (origin === undefined) return undefined;
  return /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36})$/iu.test(
    origin,
  )
    ? origin
    : undefined;
}

function setExtensionCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Vary", "Origin");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' https://product-images.tcgplayer.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "clipboard-write=(self)");
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
