import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type {
  InventoryAdditionQueueStore,
  InventoryAdditionService,
} from "../inventory-additions.js";
import type { PriceUpdateQueueStore } from "../price-update-queue.js";
import type { RepricingService } from "../repricing.js";
import type { SellerSessionService } from "../seller-session.js";
import type { ShipmentScannerService } from "../shipment-scanner.js";
import type { BackgroundShipmentScanner } from "../background-shipment-scanner.js";
import type { SellerRequestMetrics } from "../seller-api.js";
import type { InternalJobStore } from "../internal-jobs/index.js";
import type { DiscordWebhookStatus } from "../notifications/index.js";
import type { MarketplaceOrderRuntime } from "../marketplaces/order-runtime.js";
import type { MarketplaceAccountServiceMap } from "../marketplaces/account-workspaces.js";
import type { MarketplaceCredentialManager } from "../marketplaces/credentials.js";
import type { LocalInventoryService } from "../local-inventory.js";
import type { MarketplacePublicationService } from "../marketplace-publications.js";

export interface ConfigurationRouteService {
  read(): Promise<unknown>;
  save(value: unknown): Promise<unknown>;
  preview(value: unknown): Promise<AppConfig>;
}

export type ConfigurationRoutePrintTest = (
  config: AppConfig,
  actionId: string,
) => Promise<void>;

export type ConfigurationRouteAddressLabelPrint = (
  lines: readonly string[],
  signal?: AbortSignal,
) => Promise<void>;

export interface DiscordWebhookRouteService {
  status(): DiscordWebhookStatus;
  connect(webhookUrl: string): Promise<DiscordWebhookStatus>;
  disconnect(): Promise<DiscordWebhookStatus>;
  sendTest(signal?: AbortSignal): Promise<void>;
}

export interface ConfigurationRouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly extensionOrigin: string | undefined;
  readonly service: ConfigurationRouteService;
  readonly priceQueue: PriceUpdateQueueStore | undefined;
  readonly priceWorkerRunning: boolean;
  readonly repricingService: RepricingService | undefined;
  readonly inventoryQueue: InventoryAdditionQueueStore | undefined;
  readonly inventoryWorkerRunning: boolean;
  readonly inventoryService: InventoryAdditionService | undefined;
  readonly localInventory: LocalInventoryService | undefined;
  readonly marketplacePublications?: MarketplacePublicationService;
  readonly marketplaces: MarketplaceOrderRuntime | undefined;
  readonly marketplaceAccounts: MarketplaceAccountServiceMap | undefined;
  readonly shipmentScannerService: ShipmentScannerService | undefined;
  readonly backgroundShipmentScanner: BackgroundShipmentScanner | undefined;
  readonly sessionManager: SellerSessionService | undefined;
  readonly executeAddressLabel: ConfigurationRouteAddressLabelPrint | undefined;
  readonly executePrintTest: ConfigurationRoutePrintTest | undefined;
  readonly sellerRequestMetrics: (() => SellerRequestMetrics) | undefined;
  readonly internalJobs: InternalJobStore | undefined;
  readonly internalJobRunnerRunning: boolean;
  readonly discordWebhook: DiscordWebhookRouteService | undefined;
  readonly marketplaceCredentials: MarketplaceCredentialManager | undefined;
  readonly catalogConnectionId: string | undefined;
}

export type ConfigurationRouteHandler = (
  context: ConfigurationRouteContext,
) => Promise<boolean>;
