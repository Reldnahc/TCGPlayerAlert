import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "./Icon.js";

export type RouteId =
  | "dashboard"
  | "orders"
  | "payments"
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
  { id: "payments", label: "Payments", icon: "payments" },
  { id: "inventory", label: "Inventory", icon: "inventory" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "jobs", label: "Jobs", icon: "jobs" },
];

export function AppShell({
  route,
  onNavigate,
  children,
}: {
  readonly route: RouteId;
  readonly onNavigate: (route: RouteId) => void;
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
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <footer class="sidebar__footer">
          <span class="connection">
            <i class="connection__dot" />
            Local service
          </span>
          <span>Credentials remain server-side</span>
        </footer>
      </aside>
      <section class="workspace">{children}</section>
    </div>
  );
}
