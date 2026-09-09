import { ConfigurationError } from "../errors.js";
import type { ConfigurationRouteHandler } from "./context.js";
import {
  containsControlCharacter,
  objectValue,
  readJsonBody,
  sendJson,
  withRequestAbort,
} from "./http.js";

export const handleAddressLabelRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const { request, response, url, executeAddressLabel } = context;
  if (
    request.method !== "POST" ||
    url.pathname !== "/api/address-labels/print"
  ) {
    return false;
  }
  if (executeAddressLabel === undefined) {
    sendJson(response, 503, {
      message: "Address-label printing is unavailable.",
    });
    return true;
  }
  const lines = parsePastedAddress(await readJsonBody(request));
  await withRequestAbort(request, response, (signal) =>
    executeAddressLabel(lines, signal),
  );
  if (!response.destroyed) sendJson(response, 200, { printed: true });
  return true;
};

function parsePastedAddress(value: unknown): readonly string[] {
  const address = objectValue(value)?.address;
  if (typeof address !== "string" || address.length > 1024) {
    throw new ConfigurationError([
      "The pasted address must be 1,024 characters or fewer.",
    ]);
  }
  const lines = address
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.length === 0 ||
    lines.length > 8 ||
    lines.some((line) => line.length > 128 || containsControlCharacter(line))
  ) {
    throw new ConfigurationError([
      "The pasted address must contain one to eight valid lines of at most 128 characters each.",
    ]);
  }
  return lines;
}
