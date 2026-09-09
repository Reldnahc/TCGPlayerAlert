import type { ConnectionHealthService } from "./health.js";
import type { MarketplaceOrderActionService } from "./order-actions.js";
import type { OrderQueryService } from "./order-query.js";
import type { MarketplaceConnectionRegistry } from "./registry.js";
import type {
  OrderDocumentService,
  OrderPrintService,
} from "../fulfillment/documents.js";
import type { MasterPullListService } from "../fulfillment/pull-list.js";
import type { FulfillmentWorkflow } from "../orchestrator.js";
import type { MarketplaceReadyOrderSource } from "./ready-orders.js";
import type { MarketplaceInventoryService } from "./inventory.js";

/** The provider-neutral services exposed to HTTP and other application edges. */
export interface MarketplaceOrderRuntime {
  readonly registry: MarketplaceConnectionRegistry;
  readonly health: ConnectionHealthService;
  readonly orders: OrderQueryService;
  readonly actions: MarketplaceOrderActionService;
  readonly documents: OrderDocumentService;
  readonly printing: OrderPrintService;
  readonly pullList: MasterPullListService;
  readonly readyOrders: MarketplaceReadyOrderSource;
  readonly workflow: FulfillmentWorkflow;
  readonly inventory: MarketplaceInventoryService;
}
