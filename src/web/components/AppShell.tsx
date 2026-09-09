import { Fragment, type ComponentChildren } from "preact";
import { Icon, type IconName } from "./Icon.js";

export type RouteId =
  | "dashboard"
  | "labels"
  | "orders"
  | "payments"
  | "feedback"
  | "messages"
  | "scanner"
  | "add-cards"
  | "inventory"
  | "repricing"
  | "settings"
  | "jobs";

export const routes: readonly {
  readonly id: RouteId;
  readonly label: string;
  readonly icon: IconName;
  readonly group: string;
}[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", group: "Overview" },
  { id: "add-cards", label: "Add cards", icon: "add", group: "Selling" },
  { id: "inventory", label: "Inventory", icon: "inventory", group: "Selling" },
  { id: "repricing", label: "Repricing", icon: "pricing", group: "Selling" },
  { id: "orders", label: "Orders", icon: "orders", group: "Fulfillment" },
  { id: "scanner", label: "Scanner", icon: "scan", group: "Fulfillment" },
  { id: "labels", label: "Labels", icon: "printer", group: "Fulfillment" },
  { id: "messages", label: "Messages", icon: "messages", group: "Account" },
  { id: "payments", label: "Payments", icon: "payments", group: "Account" },
  { id: "feedback", label: "Feedback", icon: "feedback", group: "Account" },
  { id: "jobs", label: "Jobs", icon: "jobs", group: "Automation" },
  { id: "settings", label: "Settings", icon: "settings", group: "System" },
];

export function AppShell({
  route,
  onNavigate,
  unreadMessageCount,
  visibleRoutes = routes,
  children,
}: {
  readonly route: RouteId;
  readonly onNavigate: (route: RouteId) => void;
  readonly unreadMessageCount: number;
  readonly visibleRoutes?: typeof routes;
  readonly children: ComponentChildren;
}) {
  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand__mark">ST</span>
          <span class="brand__copy">
            <strong>Seller Tools</strong>
            <small>Local console</small>
          </span>
        </div>
        <nav class="nav" aria-label="Primary navigation">
          {visibleRoutes.map((item, index) => (
            <Fragment key={item.id}>
              {index === 0 || visibleRoutes[index - 1]?.group !== item.group ? (
                <span class="nav__group">{item.group}</span>
              ) : null}
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
                    {unreadMessageCount > 99
                      ? "99+"
                      : String(unreadMessageCount)}
                  </i>
                ) : null}
              </a>
            </Fragment>
          ))}
        </nav>
      </aside>
      <section class="workspace">{children}</section>
    </div>
  );
}
