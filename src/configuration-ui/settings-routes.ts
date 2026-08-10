import { ConfigurationError } from "../errors.js";
import type { ConfigurationRouteHandler } from "./context.js";
import { readJsonBody, safeText, sendJson } from "./http.js";

export const handleSettingsRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const { request, response, url, service, executePrintTest } = context;
  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, await service.read());
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/settings") {
    sendJson(response, 200, await service.save(await readJsonBody(request)));
    return true;
  }
  if (
    request.method !== "POST" ||
    !/^\/api\/print-tests\/[^/]{1,3072}$/u.test(url.pathname)
  ) {
    return false;
  }
  if (executePrintTest === undefined) {
    sendJson(response, 503, { message: "Printer testing is unavailable." });
    return true;
  }
  const actionId = decodeURIComponent(
    url.pathname.slice(url.pathname.lastIndexOf("/") + 1),
  );
  if (!safeText(actionId)) {
    throw new ConfigurationError(["The selected print action id is invalid."]);
  }
  const candidate = await service.preview(await readJsonBody(request));
  if (candidate.actions[actionId] === undefined) {
    throw new ConfigurationError([
      "The selected print action is not configured.",
    ]);
  }
  await executePrintTest(candidate, actionId);
  sendJson(response, 200, { printed: true, actionId, synthetic: true });
  return true;
};
