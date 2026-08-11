import { ConfigurationError } from "../errors.js";
import type { ConfigurationRouteHandler } from "./context.js";
import { objectValue, readJsonBody, sendJson } from "./http.js";

export const handleNotificationRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const { request, response, url, discordWebhook } = context;
  if (!url.pathname.startsWith("/api/notifications/discord")) return false;
  if (discordWebhook === undefined) {
    sendJson(response, 503, {
      message: "Discord webhook management is unavailable.",
    });
    return true;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/notifications/discord"
  ) {
    sendJson(response, 200, discordWebhook.status());
    return true;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/notifications/discord/connect"
  ) {
    const body = objectValue(await readJsonBody(request));
    if (typeof body?.webhookUrl !== "string") {
      throw new ConfigurationError(["A Discord webhook URL is required."]);
    }
    sendJson(response, 200, await discordWebhook.connect(body.webhookUrl));
    return true;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/notifications/discord/disconnect"
  ) {
    sendJson(response, 200, await discordWebhook.disconnect());
    return true;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/notifications/discord/test"
  ) {
    await discordWebhook.sendTest();
    sendJson(response, 200, { delivered: true });
    return true;
  }
  return false;
};
