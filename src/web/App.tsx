import type { JSX } from "preact";
import { lazy, Suspense } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { AppShell, routes, type RouteId } from "./components/AppShell.js";
import { Button, EmptyState, Notice, Spinner } from "./components/ui.js";
import { ToastViewport } from "./components/ToastViewport.js";
import { AddCardsPage } from "./pages/AddCardsPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { InventoryPage } from "./pages/InventoryPage.js";
import { JobsPage } from "./pages/JobsPage.js";
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
import {
  AuthenticationProvider,
  useAuthentication,
} from "./state/AuthenticationContext.js";
import { SellerConnectionCard } from "./components/SellerConnectionCard.js";
import { errorMessage } from "./utils.js";

const ALIASES: Readonly<Record<string, RouteId>> = {
  automation: "settings",
  repricing: "inventory",
};

const SELLER_CONNECTION_ROUTES = new Set<RouteId>([
  "add-cards",
  "orders",
  "scanner",
  "messages",
  "payments",
  "feedback",
  "inventory",
]);

const ShipmentScannerPage = lazy(async () => {
  const module = await import("./pages/ShipmentScannerPage.js");
  return { default: module.ShipmentScannerPage };
});

interface ApplicationRoute {
  readonly id: RouteId;
  readonly orderNumber?: string;
  readonly orderView?: "detail" | "master-pull-list";
}

function routeFromHash(): ApplicationRoute {
  const candidate = window.location.hash.slice(1);
  if (candidate === "orders/pull-list") {
    return { id: "orders", orderView: "master-pull-list" };
  }
  if (candidate.startsWith("orders/")) {
    const encodedOrderNumber = candidate.slice("orders/".length);
    if (encodedOrderNumber !== "" && !encodedOrderNumber.includes("/")) {
      try {
        const orderNumber = decodeURIComponent(encodedOrderNumber).trim();
        if (orderNumber !== "") {
          return { id: "orders", orderNumber, orderView: "detail" };
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
  const { settings, loading, saving, dirty, error, save, reload } =
    useSettings();
  const toast = useToast();
  const { unreadCount } = useMessages();
  const {
    status: sellerConnection,
    loading: sellerConnectionLoading,
    busy: sellerConnectionBusy,
    disconnect,
  } = useAuthentication();
  const sellerConnectionState =
    sellerConnection?.state ??
    (sellerConnectionLoading ? "checking" : "disconnected");
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

  async function logout() {
    try {
      await disconnect();
      toast.show("Logged out of TCGPlayerAlert.", "success");
    } catch (cause) {
      toast.show(
        errorMessage(cause, "TCGplayer could not be disconnected."),
        "danger",
      );
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
      orders: () =>
        applicationRoute.orderView === "master-pull-list" ? (
          <MasterPullListPage />
        ) : applicationRoute.orderNumber === undefined ? (
          <OrdersPage />
        ) : (
          <OrderDetailPage orderNumber={applicationRoute.orderNumber} />
        ),
      payments: PaymentsPage,
      feedback: FeedbackPage,
      messages: MessagesPage,
      scanner: ShipmentScannerPage,
      "add-cards": AddCardsPage,
      inventory: InventoryPage,
      settings: SettingsPage,
      jobs: JobsPage,
    };
    content = routes.map((candidate) => {
      if (!visited.has(candidate.id)) return null;
      const Page = pages[candidate.id];
      const requiresSellerConnection = SELLER_CONNECTION_ROUTES.has(
        candidate.id,
      );
      return (
        <div
          key={candidate.id}
          class="route-panel"
          hidden={route !== candidate.id}
        >
          {requiresSellerConnection && sellerConnectionState !== "connected" ? (
            <main class="page">
              <div class="app-loading">
                <EmptyState
                  title={
                    sellerConnectionState === "checking"
                      ? "Checking TCGplayer connection"
                      : `Connect TCGplayer to use ${candidate.label}`
                  }
                  detail={
                    sellerConnectionState === "checking"
                      ? "Seller requests remain paused until the connection is confirmed."
                      : "This workspace will not make seller requests while logged out."
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
              <Page />
            </Suspense>
          )}
        </div>
      );
    });
  }

  return (
    <AppShell
      route={route}
      onNavigate={navigate}
      unreadMessageCount={unreadCount}
      sellerConnectionState={sellerConnectionState}
      logoutBusy={sellerConnectionBusy}
      onLogout={() => void logout()}
      connectionBanner={
        sellerConnectionLoading ||
        sellerConnectionState === "connected" ||
        route === "settings" ? undefined : (
          <SellerConnectionCard compact />
        )
      }
    >
      {content}
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
          <OrdersProvider>
            <MessagesProvider>
              <Console />
            </MessagesProvider>
          </OrdersProvider>
        </SettingsProvider>
      </AuthenticationProvider>
    </ToastProvider>
  );
}
