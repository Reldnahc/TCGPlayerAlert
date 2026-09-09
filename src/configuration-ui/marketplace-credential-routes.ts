import { ConfigurationError } from "../errors.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
} from "../marketplaces/identity.js";
import type { MarketplaceConnectionSetup } from "../marketplaces/registry.js";
import type { ConfigurationRouteHandler } from "./context.js";
import { objectValue, readJsonBody, sendJson } from "./http.js";

export const handleMarketplaceCredentialRoute: ConfigurationRouteHandler =
  async (context) => {
    const match =
      /^\/api\/marketplace-connections\/([^/]+)\/credentials$/u.exec(
        context.url.pathname,
      );
    if (match === null) return false;
    const { marketplaceCredentials, marketplaces, request, response } = context;
    if (marketplaceCredentials === undefined || marketplaces === undefined) {
      sendJson(response, 503, {
        message: "Marketplace credential management is unavailable.",
      });
      return true;
    }
    let connectionId: string;
    try {
      connectionId = parseConnectionId(decodeURIComponent(match[1] ?? ""));
    } catch {
      sendJson(response, 400, { message: "The connection id is invalid." });
      return true;
    }
    const status = marketplaces.registry
      .statusDescriptors()
      .find((candidate) => candidate.descriptor.connectionId === connectionId);
    if (status === undefined) {
      sendJson(response, 404, {
        message: "The marketplace connection is unknown.",
      });
      return true;
    }
    let setup: MarketplaceConnectionSetup;
    try {
      setup = managedSetup(status.setup);
    } catch (error) {
      if (!(error instanceof MarketplaceValidationError)) throw error;
      sendJson(response, 409, { message: error.message });
      return true;
    }
    if (request.method === "GET") {
      sendJson(
        response,
        200,
        marketplaceCredentials.status(connectionId, setup),
      );
      return true;
    }
    if (request.method === "PUT") {
      const body = objectValue(await readJsonBody(request));
      const rawValues = objectValue(body?.values);
      if (
        rawValues === undefined ||
        Object.values(rawValues).some((value) => typeof value !== "string")
      ) {
        throw new ConfigurationError([
          "A value is required for every marketplace credential field.",
        ]);
      }
      const values = Object.fromEntries(
        Object.entries(rawValues).map(([key, value]) => [key, String(value)]),
      );
      const result = await marketplaceCredentials.connect(
        connectionId,
        setup,
        values,
      );
      marketplaces.health.invalidate(connectionId);
      sendJson(response, 200, result);
      return true;
    }
    if (request.method === "DELETE") {
      const result = await marketplaceCredentials.disconnect(
        connectionId,
        setup,
      );
      marketplaces.health.invalidate(connectionId);
      sendJson(response, 200, result);
      return true;
    }
    return false;
  };

function managedSetup(
  setup: MarketplaceConnectionSetup | undefined,
): MarketplaceConnectionSetup {
  if (setup?.kind !== "managed-credentials") {
    throw new MarketplaceValidationError(
      "This marketplace connection does not use managed credentials.",
    );
  }
  return setup;
}
