import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import type { MarketplaceConnections } from "../contracts.js";
import type { MarketplaceFacetId } from "../../marketplaces/registry.js";
import { useSettings } from "./SettingsContext.js";

interface MarketplaceConnectionsContextValue {
  readonly snapshot: MarketplaceConnections | null;
  readonly hasAvailableFacet: (facet: MarketplaceFacetId) => boolean;
  readonly refresh: () => Promise<void>;
}

const MarketplaceConnectionsContext =
  createContext<MarketplaceConnectionsContextValue | null>(null);

export function MarketplaceConnectionsProvider({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  const { settings } = useSettings();
  const [snapshot, setSnapshot] = useState<MarketplaceConnections | null>(null);

  async function refresh(): Promise<void> {
    setSnapshot(await uiApi.marketplaceConnections(true));
  }

  useEffect(() => {
    let active = true;
    void uiApi
      .marketplaceConnections()
      .then((connections) => {
        if (active) setSnapshot(connections);
      })
      .catch(() => {
        if (active) setSnapshot({ connections: [], completedAt: "" });
      });
    return () => {
      active = false;
    };
  }, [settings?.revision]);

  const value = useMemo<MarketplaceConnectionsContextValue>(
    () => ({
      snapshot,
      hasAvailableFacet: (facet) =>
        snapshot?.connections.some(
          (connection) =>
            connection.enabled &&
            connection.supportedFacets.includes(facet) &&
            (connection.health.state === "connected" ||
              connection.health.state === "degraded"),
        ) ?? false,
      refresh,
    }),
    [snapshot],
  );

  return (
    <MarketplaceConnectionsContext.Provider value={value}>
      {children}
    </MarketplaceConnectionsContext.Provider>
  );
}

export function useMarketplaceConnections(): MarketplaceConnectionsContextValue {
  const value = useContext(MarketplaceConnectionsContext);
  if (value === null) {
    throw new Error("MarketplaceConnectionsProvider is missing.");
  }
  return value;
}
