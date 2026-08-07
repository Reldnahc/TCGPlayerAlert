import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AppShell, routes, type RouteId } from "./components/AppShell.js";
import { Button, Notice, Spinner } from "./components/ui.js";
import { ToastViewport } from "./components/ToastViewport.js";
import { AddCardsPage } from "./pages/AddCardsPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { InventoryPage } from "./pages/InventoryPage.js";
import { JobsPage } from "./pages/JobsPage.js";
import { OrdersPage } from "./pages/OrdersPage.js";
import { PaymentsPage } from "./pages/PaymentsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { OrdersProvider } from "./state/OrdersContext.js";
import { SettingsProvider, useSettings } from "./state/SettingsContext.js";
import { ToastProvider, useToast } from "./state/ToastContext.js";
import { errorMessage } from "./utils.js";

const ALIASES: Readonly<Record<string, RouteId>> = {
  automation: "settings",
  repricing: "inventory",
};

function routeFromHash(): RouteId {
  const candidate = window.location.hash.slice(1);
  const aliased = ALIASES[candidate] ?? candidate;
  return routes.some((route) => route.id === aliased)
    ? (aliased as RouteId)
    : "dashboard";
}

function Console() {
  const [route, setRoute] = useState<RouteId>(routeFromHash);
  const [visited, setVisited] = useState<ReadonlySet<RouteId>>(
    () => new Set<RouteId>([routeFromHash()]),
  );
  const { settings, loading, saving, dirty, error, save, reload } =
    useSettings();
  const toast = useToast();
  useEffect(() => {
    const sync = () => {
      const next = routeFromHash();
      setRoute(next);
      setVisited((current) => new Set(current).add(next));
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function navigate(next: RouteId) {
    window.location.hash = next;
    setRoute(next);
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
      orders: OrdersPage,
      payments: PaymentsPage,
      "add-cards": AddCardsPage,
      inventory: InventoryPage,
      settings: SettingsPage,
      jobs: JobsPage,
    };
    content = routes.map((candidate) => {
      if (!visited.has(candidate.id)) return null;
      const Page = pages[candidate.id];
      return (
        <div
          key={candidate.id}
          class="route-panel"
          hidden={route !== candidate.id}
        >
          <Page />
        </div>
      );
    });
  }

  return (
    <AppShell route={route} onNavigate={navigate}>
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
      <SettingsProvider>
        <OrdersProvider>
          <Console />
        </OrdersProvider>
      </SettingsProvider>
    </ToastProvider>
  );
}
