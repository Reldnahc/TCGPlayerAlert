import type { CatalogProductDetails } from "tcgplayer-private-api";
import type { SellerPayoutDetail } from "tcgplayer-private-api";
import type {
  ConfigurationUiSettings,
  ConfigurationUiUpdate,
} from "../config-ui.js";
import type {
  CatalogSearchResult,
  InventoryAdditionJob,
  InventoryAdditionPreview,
  InventoryAdditionQueueSnapshot,
} from "../inventory-additions.js";
import type {
  AddTrackingResult,
  ManagedOrderDetail,
  ManagedOrderList,
  ManagedOrderSummary,
  PirateShipPreparation,
} from "../order-management.js";
import type { ManagedPaymentsPage } from "../payment-management.js";
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

export type Settings = ConfigurationUiSettings;
export type SettingsUpdate = ConfigurationUiUpdate;
export type OrderList = ManagedOrderList;
export type Order = ManagedOrderSummary;
export type OrderDetail = ManagedOrderDetail;
export type TrackingResult = AddTrackingResult;
export interface ShipmentResult {
  readonly orderNumber: string;
  readonly outcome: "applied" | "already-applied";
}
export type PirateShipResult = PirateShipPreparation;
export type ShipmentScannerStatus = ManagedShipmentScannerStatus;
export type ShipmentScanResult = ServerShipmentScanResult;
export type PaymentsPage = ManagedPaymentsPage;
export type PaymentDetail = SellerPayoutDetail;
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
export type PriceJob = PriceUpdateJob;
export type PricingPreview = RepricingPreview;
export type PricingProgress = RepricingProgress;
export type PricingRules = RepricingRules;

export interface InventoryQueueResponse extends InventoryAdditionQueueSnapshot {
  readonly workerRunning: boolean;
}

export interface PriceQueueResponse extends PriceUpdateQueueSnapshot {
  readonly workerRunning: boolean;
}

export interface QueuedJobs<T> {
  readonly jobs: readonly T[];
}

export interface QueuedJob<T> {
  readonly job: T;
}

export interface ApiErrorBody {
  readonly message?: string;
  readonly issues?: readonly string[];
  readonly code?: string;
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
