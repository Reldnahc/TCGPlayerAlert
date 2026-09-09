import { useEffect, useMemo, useState } from "preact/hooks";
import { masterPullListUrl } from "../api.js";
import { OrderActions } from "../components/OrderActions.js";
import { Icon } from "../components/Icon.js";
import { OrderNumberLink } from "../components/OrderNumberLink.js";
import {
  Button,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
  Toolbar,
} from "../components/ui.js";
import { orderKey, type MarketplaceConnections } from "../contracts.js";
import { useOrders } from "../state/OrdersContext.js";
import { compactDate, money, normalizedTokens } from "../utils.js";
import { useReadyOrderSnapshotPolling } from "../useReadyOrderSnapshotPolling.js";

export function OrdersPage() {
  const {
    lists,
    loading,
    errors,
    load,
    shipmentsPendingReconciliation,
    connections,
  } = useOrders();
  const [query, setQuery] = useState("");
  const list = lists.all;
  useEffect(() => void load("all"), [load]);
  useReadyOrderSnapshotPolling();
  const orders = useMemo(() => {
    const tokens = normalizedTokens(query);
    return (
      list?.orders.filter((order) => {
        const searchable = [
          order.displayOrderNumber,
          connectionLabel(connections, order.ref.connectionId),
          order.buyerName ?? "",
          order.providerStatus,
          order.shippingMethod,
        ]
          .join(" ")
          .toLocaleLowerCase();
        return tokens.every((token) => searchable.includes(token));
      }) ?? []
    );
  }, [connections, list, query]);
  const pullListAvailable =
    connections?.connections.some(
      (connection) =>
        connection.enabled &&
        connection.supportedFacets.includes("pull-lines") &&
        (connection.health.state === "connected" ||
          connection.health.state === "degraded"),
    ) === true;

  return (
    <main class="page">
      <PageHeader
        title="Orders"
        description="Review and fulfill seller orders"
        actions={
          <>
            {pullListAvailable ? (
              <a class="button button--secondary" href={masterPullListUrl()}>
                <Icon name="printer" size={16} />
                <span>Master pull list</span>
              </a>
            ) : null}
            <Button
              icon="refresh"
              busy={loading.all}
              onClick={() => void load("all", true)}
            >
              Refresh
            </Button>
          </>
        }
      />
      <div class="page-body orders-layout">
        <Toolbar>
          <Field label="Filter orders" class="toolbar-search">
            <input
              type="search"
              placeholder="Order, buyer, status, shipping"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </Field>
          <span class="toolbar__spacer" />
          {connections?.connections.map((connection) => (
            <StatusBadge
              key={connection.descriptor.connectionId}
              status={`${connection.descriptor.connectionLabel} ${connection.health.state}`}
            />
          ))}
          <span class="muted">
            {orders.length} of {list?.orders.length ?? 0} orders
          </span>
        </Toolbar>
        {errors.all === "" ? null : <Notice tone="danger">{errors.all}</Notice>}
        {list?.issues.map((issue) => (
          <Notice
            key={`${issue.connectionId}:${issue.operation}`}
            tone="warning"
          >
            {connectionLabel(connections, issue.connectionId)} could not load (
            {issue.code}).
          </Notice>
        ))}
        <div class="data-region">
          {loading.all && list === null ? (
            <div class="empty-state">
              <Spinner label="Loading orders" />
            </div>
          ) : orders.length === 0 ? (
            <EmptyState
              title={
                query === "" ? "No orders found" : "No orders match this filter"
              }
            />
          ) : (
            <table class="data-table orders-table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Connection</th>
                  <th>Buyer</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Shipping type</th>
                  <th class="align-right">Products</th>
                  <th class="align-right">Shipping</th>
                  <th class="align-right">Total</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={orderKey(order)}>
                    <td>
                      <strong>
                        <OrderNumberLink
                          orderNumber={order.displayOrderNumber}
                          orderRef={order.ref}
                        />
                      </strong>
                    </td>
                    <td>
                      <StatusBadge
                        status={connectionLabel(
                          connections,
                          order.ref.connectionId,
                        )}
                      />
                    </td>
                    <td>{order.buyerName ?? "Unknown buyer"}</td>
                    <td>{compactDate(order.createdAt)}</td>
                    <td>
                      <div class="order-status-cell">
                        <StatusBadge status={order.providerStatus} />
                        {shipmentsPendingReconciliation.has(orderKey(order)) ? (
                          <small>Shipment accepted · syncing status</small>
                        ) : null}
                      </div>
                    </td>
                    <td>{order.shippingMethod}</td>
                    <td class="align-right numeric">
                      {money(order.totals.subtotal)}
                    </td>
                    <td class="align-right numeric">
                      {money(order.totals.shipping)}
                    </td>
                    <td class="align-right numeric">
                      <strong>{money(order.totals.total)}</strong>
                    </td>
                    <td class="cell-actions">
                      <OrderActions order={order} scope="all" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}

function connectionLabel(
  connections: MarketplaceConnections | null,
  connectionId: string,
): string {
  return (
    connections?.connections.find(
      (connection) => connection.descriptor.connectionId === connectionId,
    )?.descriptor.connectionLabel ?? connectionId
  );
}
