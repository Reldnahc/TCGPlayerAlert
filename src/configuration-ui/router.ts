import { handleSellerAccountRoute } from "./account-routes.js";
import { handleAuthenticationRoute } from "./auth-routes.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import { handleInventoryRoute } from "./inventory-routes.js";
import { handleAddressLabelRoute, handleOrderRoute } from "./order-routes.js";
import { handleShipmentScannerRoute } from "./scanner-routes.js";
import { handleSettingsRoute } from "./settings-routes.js";
import { handleProviderRoute } from "./provider-routes.js";
import { handleInternalJobRoute } from "./internal-job-routes.js";
import { handleNotificationRoute } from "./notification-routes.js";

const ROUTE_HANDLERS: readonly ConfigurationRouteHandler[] = [
  handleSettingsRoute,
  handleAuthenticationRoute,
  handleNotificationRoute,
  handleProviderRoute,
  handleShipmentScannerRoute,
  handleSellerAccountRoute,
  handleOrderRoute,
  handleAddressLabelRoute,
  handleInternalJobRoute,
  handleInventoryRoute,
];

export async function dispatchConfigurationRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  for (const handler of ROUTE_HANDLERS) {
    if (await handler(context)) return true;
  }
  return false;
}
