import type { JSX } from "preact";
import { lazy, Suspense } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { AppShell, routes, type RouteId } from "./components/AppShell.js";
import { Button, EmptyState, Notice, Spinner } from "./components/ui.js";
import { ToastViewport } from "./components/ToastViewport.js";
import { ShipmentOutcomeMonitor } from "./components/ShipmentOutcomeMonitor.js";
import { AddCardsPage } from "./pages/AddCardsPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { LocalInventoryPage } from "./pages/LocalInventoryPage.js";
import { RepricingInventoryPage } from "./pages/RepricingInventoryPage.js";
import { JobsPage } from "./pages/JobsPage.js";
import { BulkLabelsPage } from "./pages/BulkLabelsPage.js";
import { OrdersPage } from "./pages/OrdersPage.js";
import { OrderDetailPage } from "./pages/OrderDetailPage.js";
import { MasterPullListPage } from "./pages/MasterPullListPage.js";
import { PaymentsPage } from "./pages/PaymentsPage.js";
import { FeedbackPage } from "./pages/FeedbackPage.js";
import { MessagesPage } from "./pages/MessagesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { OrdersProvider } from "./state/OrdersContext.js";
import { SettingsProvider, useSettings } from "./state/SettingsContext.js";
import { ToastProvider, useToast } from "./state/ToastContext.js";
import { MessagesProvider, useMessages } from "./state/MessagesContext.js";
import { AuthenticationProvider } from "./state/AuthenticationContext.js";
import {
  MarketplaceConnectionsProvider,
  useMarketplaceConnections,
} from "./state/MarketplaceConnectionsContext.js";
import { errorMessage } from "./utils.js";
import type { MarketplaceFacetId } from "../marketplaces/registry.js";

const ALIASES: Readonly<Record<string, RouteId>> = {
  automation: "settings",
};

const ROUTE_CAPABILITIES: Readonly<
  Partial<Record<RouteId, MarketplaceFacetId>>
> = {
  orders: "order-pages",
  scanner: "order-pages",
  "add-cards": "catalog-search",
  repricing: "repricing",
  jobs: "repricing",
  payments: "payments",
  messages: "messages",
  feedback: "feedback",
};

const ShipmentScannerPage = lazy(async () => {
  const module = await import("./pages/ShipmentScannerPage.js");
  return { default: module.ShipmentScannerPage };
});

interface ApplicationRoute {
  readonly id: RouteId;
  readonly connectionId?: string;
  readonly remoteOrderId?: string;
  readonly orderView?: "detail" | "master-pull-list";
}

function routeFromHash(): ApplicationRoute {
  const candidate = window.location.hash.slice(1);
  if (candidate === "orders/pull-list") {
    return { id: "orders", orderView: "master-pull-list" };
  }
  if (candidate.startsWith("orders/")) {
    const orderPath = candidate.slice("orders/".length);
    const segments = orderPath.split("/");
    if (segments.length === 2) {
      try {
        const connectionId = decodeURIComponent(segments[0] ?? "").trim();
        const remoteOrderId = decodeURIComponent(segments[1] ?? "").trim();
        if (connectionId !== "" && remoteOrderId !== "") {
          return {
            id: "orders",
            connectionId,
            remoteOrderId,
            orderView: "detail",
          };
        }
      } catch {
        return { id: "orders" };
      }
    }
  }
  const aliased = ALIASES[candidate] ?? candidate;
  return {
    id: routes.some((route) => route.id === aliased)
      ? (aliased as RouteId)
      : "dashboard",
  };
}

function Console() {
  const [applicationRoute, setApplicationRoute] =
    useState<ApplicationRoute>(routeFromHash);
  const route = applicationRoute.id;
  const [visited, setVisited] = useState<ReadonlySet<RouteId>>(
    () => new Set<RouteId>([routeFromHash().id]),
  );
  const { snapshot: marketplaceConnections } = useMarketplaceConnections();
  const { settings, loading, saving, dirty, error, save, reload } =
    useSettings();
  const toast = useToast();
  const { unreadCount } = useMessages();
  useEffect(() => {
    const sync = () => {
      const next = routeFromHash();
      setApplicationRoute(next);
      setVisited((current) => new Set(current).add(next.id));
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function navigate(next: RouteId) {
    window.location.hash = next;
    setApplicationRoute({ id: next });
    setVisited((current) => new Set(current).add(next));
  }

  async function saveSettings() {
    try {
      await save();
      toast.show("Settings saved.", "success");
    } catch (cause) {
      toast.show(errorMessage(cause, "Settings could not be saved."), "danger");
    }
  }

  let content;
  if (loading && settings === null)
    content = (
      <main class="page">
        <div class="app-loading">
          <Spinner label="Loading seller tools" />
        </div>
      </main>
    );
  else if (settings === null)
    content = (
      <main class="page">
        <div class="app-loading">
          <Notice tone="danger">
            <strong>Settings could not be loaded.</strong>
            <br />
            {error}
          </Notice>
          <Button onClick={() => void reload()}>Try again</Button>
        </div>
      </main>
    );
  else {
    const pages: Readonly<Record<RouteId, () => JSX.Element | null>> = {
      dashboard: DashboardPage,
      labels: BulkLabelsPage,
      orders: OrdersPage,
      payments: PaymentsPage,
      feedback: FeedbackPage,
      messages: MessagesPage,
      scanner: ShipmentScannerPage,
      "add-cards": AddCardsPage,
      inventory: LocalInventoryPage,
      repricing: RepricingInventoryPage,
      settings: SettingsPage,
      jobs: JobsPage,
    };
    content = routes.map((candidate) => {
      if (!visited.has(candidate.id)) return null;
      const Page = pages[candidate.id];
      const capability = ROUTE_CAPABILITIES[candidate.id];
      const capableConnections =
        capability === undefined || marketplaceConnections === null
          ? []
          : marketplaceConnections.connections.filter(
              (connection) =>
                connection.enabled &&
                connection.supportedFacets.includes(capability),
            );
      const capabilityUnavailable =
        capability !== undefined &&
        marketplaceConnections !== null &&
        capableConnections.length === 0;
      const capabilityDisconnected =
        capability !== undefined &&
        marketplaceConnections !== null &&
        capableConnections.length > 0 &&
        !capableConnections.some(
          (connection) =>
            connection.health.state === "connected" ||
            connection.health.state === "degraded",
        );
      return (
        <div
          key={candidate.id}
          class="route-panel"
          hidden={route !== candidate.id}
        >
          {capabilityUnavailable || capabilityDisconnected ? (
            <main class="page">
              <div class="app-loading">
                <EmptyState
                  title={
                    capabilityUnavailable
                      ? `${candidate.label} is not available`
                      : "Marketplace connection required"
                  }
                  detail={
                    capabilityUnavailable
                      ? "No enabled marketplace connection exposes the required capability."
                      : "Connect or repair a capable marketplace connection in Settings."
                  }
                />
              </div>
            </main>
          ) : (
            <Suspense
              fallback={
                <main class="page">
                  <div class="app-loading">
                    <Spinner label="Loading workspace" />
                  </div>
                </main>
              }
            >
              {candidate.id === "orders" ? (
                applicationRoute.orderView === "master-pull-list" ? (
                  <MasterPullListPage />
                ) : applicationRoute.remoteOrderId === undefined ||
                  applicationRoute.connectionId === undefined ? (
                  <OrdersPage />
                ) : (
                  <OrderDetailPage
                    remoteId={applicationRoute.remoteOrderId}
                    connectionId={applicationRoute.connectionId}
                  />
                )
              ) : (
                <Page />
              )}
            </Suspense>
          )}
        </div>
      );
    });
  }

  const visibleRoutes =
    marketplaceConnections === null
      ? routes
      : routes.filter((candidate) => {
          const capability = ROUTE_CAPABILITIES[candidate.id];
          return (
            capability === undefined ||
            marketplaceConnections.connections.some(
              (connection) =>
                connection.enabled &&
                connection.supportedFacets.includes(capability),
            )
          );
        });

  return (
    <AppShell
      route={route}
      onNavigate={navigate}
      unreadMessageCount={unreadCount}
      visibleRoutes={visibleRoutes}
    >
      {content}
      <ShipmentOutcomeMonitor />
      {dirty ? (
        <div class="save-dock">
          <span>
            <i />
            Unsaved configuration changes
          </span>
          <Button
            tone="primary"
            busy={saving}
            onClick={() => void saveSettings()}
          >
            Save settings
          </Button>
        </div>
      ) : null}
      <ToastViewport />
    </AppShell>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AuthenticationProvider>
        <SettingsProvider>
          <MarketplaceConnectionsProvider>
            <OrdersProvider>
              <MessagesProvider>
                <Console />
              </MessagesProvider>
            </OrdersProvider>
          </MarketplaceConnectionsProvider>
        </SettingsProvider>
      </AuthenticationProvider>
    </ToastProvider>
  );
}
