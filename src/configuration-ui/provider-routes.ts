import type { ConfigurationRouteHandler } from "./context.js";
import { sendJson } from "./http.js";

export const handleProviderRoute: ConfigurationRouteHandler = (context) => {
  if (
    context.request.method !== "GET" ||
    context.url.pathname !== "/api/provider/requests"
  ) {
    return Promise.resolve(false);
  }
  if (context.sellerRequestMetrics === undefined) {
    sendJson(context.response, 503, {
      message: "Seller request metrics are unavailable.",
    });
    return Promise.resolve(true);
  }
  sendJson(context.response, 200, context.sellerRequestMetrics());
  return Promise.resolve(true);
};
