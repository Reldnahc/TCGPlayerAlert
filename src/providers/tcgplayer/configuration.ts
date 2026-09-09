import { ConfigurationError } from "../../errors.js";
import type { MarketplaceProvidersConfiguration } from "../../marketplaces/configuration.js";
import {
  parseTcgplayerAdapterSettings,
  type TcgplayerAdapterSettings,
} from "./factory.js";

export interface TcgplayerConnectionSelection {
  readonly connectionId: string;
  readonly label: string;
  readonly settings: TcgplayerAdapterSettings;
}

/** Selects the TCGplayer connection used by TCGplayer-only account tools. */
export function primaryTcgplayerConnection(
  providers: MarketplaceProvidersConfiguration,
): TcgplayerConnectionSelection {
  const candidate = Object.entries(providers.connections)
    .filter(
      ([, connection]) =>
        connection.enabled && connection.providerId === "tcgplayer",
    )
    .sort(([left], [right]) => left.localeCompare(right))[0];
  if (candidate === undefined) {
    throw new ConfigurationError([
      "An enabled TCGplayer connection is required for this workspace.",
    ]);
  }
  const [connectionId, connection] = candidate;
  return {
    connectionId,
    label: connection.label,
    settings: parseTcgplayerAdapterSettings(connection.settings),
  };
}
