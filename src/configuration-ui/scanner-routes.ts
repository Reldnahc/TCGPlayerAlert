import { unavailableBackgroundCameraStatus } from "../background-shipment-scanner.js";
import { ConfigurationError } from "../errors.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import {
  objectValue,
  readJsonBody,
  safeText,
  sendBytes,
  sendJson,
  withRequestAbort,
} from "./http.js";

export const handleShipmentScannerRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const { request, response, url } = context;
  if (
    request.method === "GET" &&
    url.pathname === "/api/shipment-scanner/camera-frame"
  ) {
    if (context.backgroundShipmentScanner === undefined) {
      sendJson(response, 503, {
        message:
          "Background camera preview is available while the service is running.",
      });
      return true;
    }
    const preview = await context.backgroundShipmentScanner.cameraPreview();
    if (preview === undefined) {
      sendJson(response, 404, {
        message: "No background camera frame is available.",
      });
      return true;
    }
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Camera-Frame-At", preview.capturedAt);
    sendBytes(response, 200, preview.mediaType, preview.bytes);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/shipment-scanner") {
    if (!requireScanner(context)) return true;
    sendJson(
      response,
      200,
      context.backgroundShipmentScanner === undefined
        ? {
            ...(await context.shipmentScannerService.status()),
            backgroundCamera: unavailableBackgroundCameraStatus(),
          }
        : await context.backgroundShipmentScanner.status(),
    );
    return true;
  }
  if (
    request.method !== "POST" ||
    (url.pathname !== "/api/shipment-scanner/scan" &&
      url.pathname !== "/api/shipment-scanner/mark-shipped")
  ) {
    return false;
  }
  if (!requireScanner(context)) return true;
  const body = objectValue(await readJsonBody(request));
  const tagId = parseTagId(body?.tagId);
  if (url.pathname === "/api/shipment-scanner/scan") {
    const result = await withRequestAbort(request, response, (signal) =>
      context.shipmentScannerService.scan(tagId, signal),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  const orderNumber = body?.orderNumber;
  if (!safeText(orderNumber) || orderNumber.length > 128) {
    throw new ConfigurationError(["A valid order number is required."]);
  }
  const result = await withRequestAbort(request, response, (signal) =>
    context.backgroundShipmentScanner === undefined
      ? context.shipmentScannerService.markShipped(tagId, orderNumber, signal)
      : context.backgroundShipmentScanner.markShipped(
          tagId,
          orderNumber,
          signal,
        ),
  );
  if (!response.destroyed) sendJson(response, 200, result);
  return true;
};

function requireScanner(
  context: ConfigurationRouteContext,
): context is ConfigurationRouteContext & {
  readonly shipmentScannerService: NonNullable<
    ConfigurationRouteContext["shipmentScannerService"]
  >;
} {
  if (context.shipmentScannerService !== undefined) return true;
  sendJson(context.response, 503, {
    message: "Shipment scanning is available while the service is running.",
  });
  return false;
}

function parseTagId(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 586) {
    throw new ConfigurationError(["A valid shipment tag id is required."]);
  }
  return Number(value);
}
