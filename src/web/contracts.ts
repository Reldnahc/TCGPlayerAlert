import type {
  ConfigurationUiSettings,
  ConfigurationUiUpdate,
} from "../config-ui.js";
import type {
  CatalogSearchResult,
  InventoryAdditionJob,
  InventoryAdditionPreview,
  InventoryAdditionQueueSnapshot,
  CatalogProductDetails,
} from "../inventory-additions.js";
import type { MasterPullList as ProviderNeutralMasterPullList } from "../fulfillment/pull-list.js";
import type {
  MutationResult,
  OrderActionId,
  OrderDetail as NormalizedOrderDetail,
  OrderSummary,
  ProviderIssue,
} from "../marketplaces/contracts.js";
import type { MarketplaceConnectionStatus } from "../marketplaces/health.js";
import { orderRefKey } from "../marketplaces/identity.js";
import type {
  ManagedPaymentsPage,
  ManagedSellerPayoutDetail,
} from "../payment-management.js";
import type { ManagedSellerFeedbackPage } from "../feedback-management.js";
import type {
  MarkAllSellerMessagesReadResult,
  ManagedSellerMessagesPage,
  ManagedSellerMessageThread,
} from "../message-management.js";
import type {
  PriceUpdateJob,
  PriceUpdateQueueSnapshot,
} from "../price-update-queue.js";
import type {
  RepricingPreview,
  RepricingProgress,
  RepricingRules,
} from "../repricing.js";
import type { ShipmentScanResult as ServerShipmentScanResult } from "../shipment-scanner.js";
import type { ManagedShipmentScannerStatus } from "../background-shipment-scanner.js";
import type { InventoryMutationResult as MarketplaceInventoryMutationResult } from "../marketplaces/inventory.js";
import type { LocalInventoryItem } from "../local-inventory-contracts.js";
import type {
  MarketplacePublicationJob as ServerMarketplacePublicationJob,
  MarketplacePublicationPreview as ServerMarketplacePublicationPreview,
  MarketplaceListingQuote as ServerMarketplaceListingQuote,
} from "../marketplace-publications.js";
import type {
  LocalInventoryImportPreview as ServerLocalInventoryImportPreview,
  LocalInventoryWorkspace,
} from "../local-inventory-workspace.js";
import type {
  InternalJobSnapshot,
  InternalRun,
  InternalSchedule,
  InternalScheduleInput,
  ScheduledListingInput,
} from "../internal-jobs/index.js";
import type { MarketplaceCredentialStatus as ProviderCredentialStatus } from "../marketplaces/credentials.js";

export type Settings = ConfigurationUiSettings;
export type SettingsUpdate = ConfigurationUiUpdate;
export interface OrderList {
  readonly orders: readonly Order[];
  readonly issues: readonly ProviderIssue[];
  readonly fetchedAt: string;
}
export interface ReadyOrderSnapshot {
  readonly snapshot: OrderList | null;
}
export type Order = OrderSummary;
export type OrderDetail = NormalizedOrderDetail;

export interface MarketplaceConnections {
  readonly connections: readonly MarketplaceConnectionStatus[];
  readonly completedAt: string;
}
export type MarketplaceCredentialStatus = ProviderCredentialStatus;

export function orderKey(order: Pick<Order, "ref">): string {
  return orderRefKey(order.ref);
}

export function orderActionAvailable(
  order: Pick<Order, "actions">,
  actionId: OrderActionId,
): boolean {
  return order.actions[actionId].state === "available";
}
export type MasterPullList = ProviderNeutralMasterPullList;
export type TrackingResult = MutationResult;
export type ShipmentResult = MutationResult;
export interface PirateShipResult {
  readonly url: string;
  readonly pasteAddress: string;
}
export type ShipmentScannerStatus = ManagedShipmentScannerStatus;
export type ShipmentScanResult = ServerShipmentScanResult;
export type PaymentsPage = ManagedPaymentsPage;
export type PaymentDetail = ManagedSellerPayoutDetail;
export type FeedbackPage = ManagedSellerFeedbackPage;
export type MessagesPage = ManagedSellerMessagesPage;
export type MessageThread = ManagedSellerMessageThread;
export interface MessageMutationResult {
  readonly threadId: number;
}
export type MarkAllMessagesReadResult = MarkAllSellerMessagesReadResult;
export interface UnreadMessages {
  readonly unreadCount: number;
}
export type CatalogSearch = CatalogSearchResult;
export type CatalogProduct = CatalogProductDetails;
export type AdditionPreview = InventoryAdditionPreview;
export type InventoryJob = InventoryAdditionJob;
export type InventoryList = LocalInventoryWorkspace;
export type InventoryMutationResult = MarketplaceInventoryMutationResult;
export type LocalInventoryImportPreview = ServerLocalInventoryImportPreview;
export interface LocalInventoryItemResponse {
  readonly item: LocalInventoryItem;
}
export interface LocalInventoryImportResult {
  readonly createdCount: number;
  readonly createdItems: readonly LocalInventoryItem[];
  readonly preview: LocalInventoryImportPreview;
}
export type MarketplacePublicationPreview = ServerMarketplacePublicationPreview;
export type MarketplaceListingQuote = ServerMarketplaceListingQuote;
export type MarketplacePublicationJob = ServerMarketplacePublicationJob;
export interface MarketplacePublicationPreviewResponse {
  readonly preview: MarketplacePublicationPreview;
}
export interface MarketplaceListingQuoteResponse {
  readonly quote?: MarketplaceListingQuote;
}
export interface MarketplacePublicationJobResponse {
  readonly job: MarketplacePublicationJob;
}
export type PriceJob = PriceUpdateJob;
export type JobSchedule = InternalSchedule;
export type JobScheduleInput = InternalScheduleInput;
export type JobRun = InternalRun;
export type ScheduledListing = ScheduledListingInput;
export type PricingPreview = RepricingPreview;
export type PricingProgress = RepricingProgress;
export type PricingRules = RepricingRules;

export interface InventoryQueueResponse extends InventoryAdditionQueueSnapshot {
  readonly workerRunning: boolean;
}

export interface PriceQueueResponse extends PriceUpdateQueueSnapshot {
  readonly workerRunning: boolean;
}

export interface InternalJobsResponse extends InternalJobSnapshot {
  readonly runnerRunning: boolean;
}

export interface JobScheduleResponse {
  readonly schedule: JobSchedule;
}

export interface JobRunResponse {
  readonly run: JobRun;
}

export interface DeletedResponse {
  readonly deleted: boolean;
}

export interface QueuedJobs<T> {
  readonly jobs: readonly T[];
}

export interface QueuedJob<T> {
  readonly job: T;
}

export interface SellerConnectionStatus {
  readonly state: "connected" | "expired" | "disconnected";
  readonly source?: "browser" | "environment";
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly automaticRenewal: boolean;
  readonly protectedStorage: boolean;
}

export interface SellerPairingChallenge {
  readonly pairingCode: string;
  readonly expiresAt: string;
  readonly port: number;
}

export interface DiscordWebhookStatus {
  readonly configured: boolean;
  readonly source?: "protected" | "environment";
  readonly protectedStorage: boolean;
}

export interface DiscordWebhookTestResult {
  readonly delivered: boolean;
}
