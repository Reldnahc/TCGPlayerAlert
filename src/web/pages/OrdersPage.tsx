import { useEffect, useMemo, useState } from "preact/hooks";
import { OrderActions } from "../components/OrderActions.js";
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
import { useOrders } from "../state/OrdersContext.js";
import { compactDate, money, normalizedTokens } from "../utils.js";

export function OrdersPage() {
  const { lists, loading, errors, load } = useOrders();
  const [query, setQuery] = useState("");
  const list = lists.all;
  useEffect(() => {
    void load("all");
  }, [load]);
  const orders = useMemo(() => {
    const tokens = normalizedTokens(query);
    return (
      list?.orders.filter((order) => {
        const text = [
          order.orderNumber,
          order.buyerName,
          order.status,
          order.shippingType,
        ]
          .join(" ")
          .toLocaleLowerCase();
        return tokens.every((token) => text.includes(token));
      }) ?? []
    );
  }, [list, query]);
  return (
    <main class="page">
      <PageHeader
        title="Orders"
        description="Review and fulfill seller orders"
        actions={
          <Button
            icon="refresh"
            busy={loading.all}
            onClick={() => void load("all", true)}
          >
            Refresh
          </Button>
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
          <span class="muted">
            {orders.length} of {list?.orders.length ?? 0} orders
          </span>
        </Toolbar>
        {errors.all === "" ? null : <Notice tone="danger">{errors.all}</Notice>}
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
              <colgroup>
                <col class="orders-col-number" />
                <col />
                <col />
                <col class="orders-col-status" />
                <col />
                <col />
                <col />
                <col />
                <col class="orders-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th>Order #</th>
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
                  <tr key={order.orderNumber}>
                    <td>
                      <strong>
                        <OrderNumberLink orderNumber={order.orderNumber} />
                      </strong>
                    </td>
                    <td>{order.buyerName}</td>
                    <td>{compactDate(order.orderDate)}</td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td>{order.shippingType}</td>
                    <td class="align-right numeric">
                      {money(order.productAmount)}
                    </td>
                    <td class="align-right numeric">
                      {money(order.shippingAmount)}
                    </td>
                    <td class="align-right numeric">
                      <strong>{money(order.totalAmount)}</strong>
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
