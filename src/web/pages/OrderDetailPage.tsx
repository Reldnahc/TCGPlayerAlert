import { useCallback, useEffect, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import { Icon } from "../components/Icon.js";
import { OrderActions } from "../components/OrderActions.js";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from "../components/ui.js";
import { orderKey, type OrderDetail } from "../contracts.js";
import { useOrders } from "../state/OrdersContext.js";
import { dateTime, errorMessage, money } from "../utils.js";

export function OrderDetailPage({
  connectionId,
  remoteId,
}: {
  readonly connectionId: string;
  readonly remoteId: string;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { shipmentsPendingReconciliation, connections } = useOrders();
  const ref = { connectionId, remoteId };
  const connection = connections?.connections.find(
    (candidate) => candidate.descriptor.connectionId === connectionId,
  );
  const connectionLabel =
    connection?.descriptor.connectionLabel ?? connectionId;
  const providerLabel = connection?.descriptor.providerLabel;
  const shipmentPendingReconciliation =
    detail !== null && shipmentsPendingReconciliation.has(orderKey(detail));

  const load = useCallback(
    async (force = false, signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        setDetail(await uiApi.order(ref, force, signal));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setError(errorMessage(cause, "The order could not be loaded."));
      } finally {
        if (signal?.aborted !== true) setLoading(false);
      }
    },
    [connectionId, remoteId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main class="page">
      <PageHeader
        title={`Order ${detail?.displayOrderNumber ?? remoteId}`}
        description={
          detail === null
            ? `Review fulfillment from ${connectionLabel}`
            : `${detail.buyerName ?? "Unknown buyer"} · ${dateTime(detail.createdAt)}`
        }
        actions={
          <>
            <a class="button button--quiet" href="#orders">
              <Icon name="chevron-left" size={16} />
              <span>All orders</span>
            </a>
            <Button
              icon="refresh"
              busy={loading && detail !== null}
              onClick={() => void load(true)}
            >
              Refresh
            </Button>
          </>
        }
      />
      <div class="page-body order-detail-layout">
        {error === "" ? null : (
          <Notice tone="danger">
            <strong>Order details could not be loaded</strong>
            <span>{error}</span>
            <Button tone="secondary" onClick={() => void load(true)}>
              Try again
            </Button>
          </Notice>
        )}
        {loading && detail === null ? (
          <div class="order-detail-loading">
            <Spinner label="Loading order details" />
          </div>
        ) : detail === null ? (
          error === "" ? (
            <EmptyState title="Order details are unavailable" />
          ) : null
        ) : (
          <>
            <section class="surface order-detail-command-bar">
              <div class="order-detail-command-bar__identity">
                <StatusBadge status={detail.providerStatus} />
                <StatusBadge status={connectionLabel} />
                <div>
                  <strong>{detail.buyerName ?? "Unknown buyer"}</strong>
                  <small>
                    {detail.shippingMethod}
                    {providerLabel === undefined ? "" : ` · ${providerLabel}`}
                  </small>
                  {shipmentPendingReconciliation ? (
                    <small>
                      Shipment accepted · syncing {connectionLabel} status
                    </small>
                  ) : null}
                </div>
              </div>
              <div class="order-detail-command-bar__actions">
                <OrderActions
                  order={detail}
                  scope="all"
                  hasTracking={detail.trackingNumbers.length > 0}
                  onChanged={() => load(true)}
                />
              </div>
            </section>

            <section class="metric-strip order-detail-metrics">
              <DetailMetric
                label="Products"
                value={money(detail.totals.subtotal)}
                detail={`${String(totalQuantity(detail))} item${totalQuantity(detail) === 1 ? "" : "s"}`}
              />
              <DetailMetric
                label="Shipping"
                value={money(detail.totals.shipping)}
                detail={detail.shippingMethod}
              />
              <DetailMetric
                label="Tax"
                value={money(detail.totals.tax)}
                detail={
                  detail.totals.tax === undefined
                    ? "Not provided"
                    : "Provider total"
                }
              />
              <DetailMetric
                label="Order total"
                value={money(detail.totals.total)}
                detail={detail.providerStatus}
              />
            </section>

            <div class="order-detail-grid">
              <section class="surface order-detail-panel">
                <header class="surface__header">
                  <strong>Ship to</strong>
                </header>
                <div class="surface__body order-address">
                  <strong>{detail.shippingAddress.recipientName}</strong>
                  {detail.shippingAddress.company === undefined ? null : (
                    <span>{detail.shippingAddress.company}</span>
                  )}
                  <span>{detail.shippingAddress.addressOne}</span>
                  {detail.shippingAddress.addressTwo === undefined ? null : (
                    <span>{detail.shippingAddress.addressTwo}</span>
                  )}
                  <span>
                    {detail.shippingAddress.city},{" "}
                    {detail.shippingAddress.territory}{" "}
                    {detail.shippingAddress.postalCode}
                  </span>
                  <span>{detail.shippingAddress.country}</span>
                </div>
              </section>
              <section class="surface order-detail-panel">
                <header class="surface__header">
                  <strong>Order</strong>
                </header>
                <dl class="detail-list">
                  <DetailFact
                    label="Placed"
                    value={dateTime(detail.createdAt)}
                  />
                  <DetailFact label="Connection" value={connectionLabel} />
                  <DetailFact
                    label="Channel"
                    value={detail.orderChannel ?? "Not provided"}
                  />
                  <DetailFact
                    label="Seller"
                    value={detail.sellerName ?? "Not provided"}
                  />
                  <DetailFact
                    label="Payment"
                    value={detail.paymentMethod ?? "Not provided"}
                  />
                </dl>
              </section>
            </div>

            <section class="surface order-detail-products">
              <header class="surface__header">
                <div>
                  <strong>Products</strong>
                  <p>{productSummary(detail)}</p>
                </div>
              </header>
              {detail.lines.length === 0 ? (
                <EmptyState title="No products were returned for this order" />
              ) : (
                <div class="data-region data-region--embedded">
                  <table class="data-table order-products-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Variant</th>
                        <th class="align-right">Quantity</th>
                        <th class="align-right">Unit price</th>
                        <th class="align-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lines.map((line) => (
                        <tr key={line.lineKey}>
                          <td>
                            <strong>{line.description}</strong>
                          </td>
                          <td>{attributeSummary(line.attributes)}</td>
                          <td class="align-right numeric">
                            {String(line.quantity)}
                          </td>
                          <td class="align-right numeric">
                            {money(line.unitPrice)}
                          </td>
                          <td class="align-right numeric">
                            <strong>{money(line.lineTotal)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section class="surface order-detail-tracking">
              <header class="surface__header">
                <strong>Tracking</strong>
              </header>
              {detail.trackingNumbers.length === 0 ? (
                <EmptyState title="No tracking has been added" />
              ) : (
                <ul>
                  {detail.trackingNumbers.map((trackingNumber) => (
                    <li key={trackingNumber} class="numeric">
                      {trackingNumber}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function DetailMetric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function DetailFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function totalQuantity(detail: OrderDetail): number {
  return detail.lines.reduce((total, line) => total + line.quantity, 0);
}

function productSummary(detail: OrderDetail): string {
  const count = totalQuantity(detail);
  return `${String(count)} item${count === 1 ? "" : "s"} across ${String(detail.lines.length)} line${detail.lines.length === 1 ? "" : "s"}`;
}

function attributeSummary(
  attributes: Readonly<Record<string, string>>,
): string {
  const values = Object.values(attributes);
  return values.length === 0 ? "—" : values.join(" · ");
}
