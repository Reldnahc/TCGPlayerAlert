import type { CatalogProductDetails } from "tcgplayer-private-api";
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
  ManagedOrderList,
  ManagedOrderSummary,
  PirateShipPreparation,
} from "../order-management.js";
import type {
  PriceUpdateJob,
  PriceUpdateQueueSnapshot,
} from "../price-update-queue.js";
import type { RepricingPreview, RepricingRules } from "../repricing.js";

export type Settings = ConfigurationUiSettings;
export type SettingsUpdate = ConfigurationUiUpdate;
export type OrderList = ManagedOrderList;
export type Order = ManagedOrderSummary;
export type TrackingResult = AddTrackingResult;
export interface ShipmentResult {
  readonly orderNumber: string;
  readonly outcome: "applied" | "already-applied";
}
export type PirateShipResult = PirateShipPreparation;
export type CatalogSearch = CatalogSearchResult;
export type CatalogProduct = CatalogProductDetails;
export type AdditionPreview = InventoryAdditionPreview;
export type InventoryJob = InventoryAdditionJob;
export type PriceJob = PriceUpdateJob;
export type PricingPreview = RepricingPreview;
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
