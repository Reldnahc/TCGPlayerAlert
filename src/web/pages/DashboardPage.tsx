import { useEffect } from "preact/hooks";
import { OrderActions } from "../components/OrderActions.js";
import {
  Button,
  EmptyState,
  Metric,
  Notice,
  PageHeader,
  Spinner,
  Toggle,
} from "../components/ui.js";
import { useOrders } from "../state/OrdersContext.js";
import { useSettings } from "../state/SettingsContext.js";
import { compactDate, dateTime, money } from "../utils.js";

export function DashboardPage() {
  const { settings, update } = useSettings();
  const { lists, loading, errors, load } = useOrders();
  const list = lists["ready-to-ship"];
  useEffect(() => {
    void load("ready-to-ship");
  }, [load]);
  const totals = list?.orders.reduce(
    (result, order) => ({
      products: result.products + order.productAmount,
      shipping: result.shipping + order.shippingAmount,
      total: result.total + order.totalAmount,
    }),
    { products: 0, shipping: 0, total: 0 },
  );
  const outputs = settings?.outputs ?? [];

  function setOutputEnabled(actionId: string, enabled: boolean) {
    update((current) => ({
      ...current,
      outputs: current.outputs.map((output) =>
        output.actionId === actionId ? { ...output, enabled } : output,
      ),
    }));
  }

  return (
    <main class="page">
      <PageHeader
        title="Dashboard"
        description={
          list === null
            ? "Ready-to-ship activity and fulfillment controls"
            : `Orders updated ${dateTime(list.fetchedAt)}`
        }
        actions={
          <Button
            icon="refresh"
            busy={loading["ready-to-ship"]}
            onClick={() => void load("ready-to-ship", true)}
          >
            Refresh
          </Button>
        }
      />
      <div class="page-body">
        <div class="page-stack">
          <div class="metric-strip">
            <Metric
              label="Ready orders"
              value={String(list?.orders.length ?? 0)}
            />
            <Metric label="Products" value={money(totals?.products)} />
            <Metric label="Shipping" value={money(totals?.shipping)} />
            <Metric label="Order total" value={money(totals?.total)} />
          </div>
          <section class="surface">
            <div class="surface__header">
              <div>
                <h2>Automation</h2>
                <p>
                  Quick controls use the same saved settings as the full
                  configuration.
                </p>
              </div>
            </div>
            <div class="automation-strip">
              {outputs.map((output) => (
                <Toggle
                  key={output.actionId}
                  label={
                    output.type === "print-address-label"
                      ? "Address labels"
                      : "Packing slips"
                  }
                  description={
                    output.enabled
                      ? `Enabled · ${output.printerName}`
                      : `Disabled · ${output.printerName}`
                  }
                  checked={output.enabled}
                  onChange={(checked) =>
                    setOutputEnabled(output.actionId, checked)
                  }
                />
              ))}
            </div>
          </section>
          {errors["ready-to-ship"] === "" ? null : (
            <Notice tone="danger">{errors["ready-to-ship"]}</Notice>
          )}
          <section class="surface work-surface">
            <div class="surface__header">
              <div>
                <h2>Ready to ship</h2>
                <p>
                  Only authoritative orders currently eligible for shipment.
                </p>
              </div>
            </div>
            <div class="data-region data-region--embedded">
              {loading["ready-to-ship"] && list === null ? (
                <div class="empty-state">
                  <Spinner label="Loading orders" />
                </div>
              ) : list === null || list.orders.length === 0 ? (
                <EmptyState
                  title="No orders are ready to ship"
                  detail="Refresh to check TCGplayer again."
                />
              ) : (
                <table class="data-table dashboard-table">
                  <thead>
                    <tr>
                      <th>Buyer / order</th>
                      <th>Date</th>
                      <th>Shipping</th>
                      <th class="align-right">Products</th>
                      <th class="align-right">Shipping</th>
                      <th class="align-right">Total</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.orders.map((order) => (
                      <tr key={order.orderNumber}>
                        <td>
                          <span class="cell-stack">
                            <strong>{order.buyerName}</strong>
                            <small>{order.orderNumber}</small>
                          </span>
                        </td>
                        <td>{compactDate(order.orderDate)}</td>
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
                          <OrderActions
                            order={order}
                            scope="ready-to-ship"
                            compact
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
