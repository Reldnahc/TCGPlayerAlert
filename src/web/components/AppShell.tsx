import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "./Icon.js";

export type RouteId =
  | "dashboard"
  | "orders"
  | "payments"
  | "feedback"
  | "messages"
  | "scan-lab"
  | "add-cards"
  | "inventory"
  | "settings"
  | "jobs";

export const routes: readonly {
  readonly id: RouteId;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "add-cards", label: "Add cards", icon: "add" },
  { id: "orders", label: "Orders", icon: "orders" },
  { id: "scan-lab", label: "Scan lab", icon: "scan" },
  { id: "messages", label: "Messages", icon: "messages" },
  { id: "payments", label: "Payments", icon: "payments" },
  { id: "feedback", label: "Feedback", icon: "feedback" },
  { id: "inventory", label: "Inventory", icon: "inventory" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "jobs", label: "Jobs", icon: "jobs" },
];

export function AppShell({
  route,
  onNavigate,
  unreadMessageCount,
  sellerConnectionState,
  logoutBusy,
  onLogout,
  connectionBanner,
  children,
}: {
  readonly route: RouteId;
  readonly onNavigate: (route: RouteId) => void;
  readonly unreadMessageCount: number;
  readonly sellerConnectionState:
    "checking" | "connected" | "expired" | "disconnected";
  readonly logoutBusy: boolean;
  readonly onLogout: () => void;
  readonly connectionBanner?: ComponentChildren;
  readonly children: ComponentChildren;
}) {
  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand__mark">TCG</span>
          <span class="brand__copy">
            <strong>Seller Tools</strong>
            <small>Local console</small>
          </span>
        </div>
        <nav class="nav" aria-label="Primary navigation">
          {routes.map((item) => (
            <a
              key={item.id}
              class="nav__item"
              href={`#${item.id}`}
              aria-current={route === item.id ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(item.id);
              }}
              title={item.label}
              aria-label={
                item.id === "messages" && unreadMessageCount > 0
                  ? `Messages, ${String(unreadMessageCount)} unread message${unreadMessageCount === 1 ? "" : "s"}`
                  : item.label
              }
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === "messages" && unreadMessageCount > 0 ? (
                <i class="nav__unread" aria-hidden="true">
                  {unreadMessageCount > 99 ? "99+" : String(unreadMessageCount)}
                </i>
              ) : null}
            </a>
          ))}
        </nav>
        <footer class="sidebar__footer">
          <div class="sidebar__connection-row">
            <span class="connection">
              <i
                class={`connection__dot connection__dot--${sellerConnectionState}`}
              />
              {sellerConnectionState === "connected"
                ? "Authenticated"
                : sellerConnectionState === "checking"
                  ? "Checking"
                  : sellerConnectionState === "expired"
                    ? "Session expired"
                    : "Disconnected"}
            </span>
            {sellerConnectionState === "connected" ? (
              <button
                type="button"
                class="sidebar__logout"
                disabled={logoutBusy}
                aria-busy={logoutBusy || undefined}
                title="Disconnect this application without signing out of the Seller Portal"
                onClick={onLogout}
              >
                {logoutBusy ? "Logging out…" : "Log out"}
              </button>
            ) : null}
          </div>
          <span>Credentials remain server-side</span>
        </footer>
      </aside>
      <section
        class={`workspace${connectionBanner === undefined ? "" : " workspace--with-banner"}`}
      >
        {connectionBanner}
        {children}
      </section>
    </div>
  );
}
