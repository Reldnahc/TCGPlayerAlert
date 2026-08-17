import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { sellerPortalOrderUrl, uiApi } from "../api.js";
import { Icon } from "../components/Icon.js";
import { OrderActions } from "../components/OrderActions.js";
import { OrderRefundPanel } from "../components/OrderRefundPanel.js";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from "../components/ui.js";
import type { Order, OrderDetail, RefundOptions } from "../contracts.js";
import { dateTime, errorMessage, money } from "../utils.js";
import { useOrders } from "../state/OrdersContext.js";

export function OrderDetailPage({
  orderNumber,
}: {
  readonly orderNumber: string;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showRefund, setShowRefund] = useState(false);
  const [refundOptions, setRefundOptions] = useState<RefundOptions | null>(
    null,
  );
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundError, setRefundError] = useState("");
  const { shipmentsPendingReconciliation } = useOrders();
  const shipmentPendingReconciliation =
    shipmentsPendingReconciliation.has(orderNumber);

  const load = useCallback(
    async (force = false, signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        setDetail(await uiApi.order(orderNumber, force, signal));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setError(errorMessage(cause, "The order could not be loaded."));
      } finally {
        if (signal?.aborted !== true) setLoading(false);
      }
    },
    [orderNumber],
  );

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  const actionOrder = useMemo<Order | null>(() => {
    if (detail === null) return null;
    return {
      orderNumber: detail.orderNumber,
      buyerName: detail.buyerName,
      orderDate: detail.createdAt,
      status: detail.status,
      statusCode: detail.statusCode,
      canMarkShipped: detail.canMarkShipped,
      shippingType: detail.shippingType,
      productAmount: detail.transaction.productAmount,
      shippingAmount: detail.transaction.shippingAmount,
      totalAmount: detail.transaction.grossAmount,
    };
  }, [detail]);

  const toggleRefund = async () => {
    if (showRefund) {
      setShowRefund(false);
      return;
    }
    if (refundOptions !== null) {
      setShowRefund(true);
      return;
    }
    setRefundLoading(true);
    setRefundError("");
    try {
      setRefundOptions(await uiApi.refundOptions());
      setShowRefund(true);
    } catch (cause) {
      setRefundError(
        errorMessage(cause, "Refund options could not be loaded."),
      );
    } finally {
      setRefundLoading(false);
    }
  };

  return (
    <main class="page">
      <PageHeader
        title={`Order ${orderNumber}`}
        description={
          detail === null
            ? "Review fulfillment and order information"
            : `${detail.buyerName} · ${dateTime(detail.createdAt)}`
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
            <a
              class="button button--secondary"
              href={sellerPortalOrderUrl(orderNumber)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="external" size={16} />
              <span>Open in TCGplayer</span>
            </a>
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
        ) : detail === null || actionOrder === null ? (
          error === "" ? (
            <EmptyState title="Order details are unavailable" />
          ) : null
        ) : (
          <>
            <section class="surface order-detail-command-bar">
              <div class="order-detail-command-bar__identity">
                <StatusBadge status={detail.status} />
                <div>
                  <strong>{detail.buyerName}</strong>
                  <small>
                    {detail.shippingType} · {detail.orderFulfillment}
                  </small>
                  {shipmentPendingReconciliation ? (
                    <small>Shipment accepted · syncing TCGplayer status</small>
                  ) : null}
                </div>
              </div>
              <div class="order-detail-command-bar__actions">
                <OrderActions
                  order={actionOrder}
                  scope="all"
                  hasTracking={detail.trackingNumbers.length > 0}
                  onChanged={() => load(true)}
                />
                {detail.refundCapabilities.full ||
                detail.refundCapabilities.partial ? (
                  <Button
                    tone={showRefund ? "primary" : "secondary"}
                    busy={refundLoading}
                    onClick={() => void toggleRefund()}
                  >
                    Refund
                  </Button>
                ) : null}
              </div>
            </section>

            {refundError === "" ? null : (
              <Notice tone="danger">{refundError}</Notice>
            )}

            {showRefund && refundOptions !== null ? (
              <OrderRefundPanel
                order={detail}
                options={refundOptions}
                onClose={() => setShowRefund(false)}
                onSubmitted={() => load(true)}
              />
            ) : null}

            <section class="metric-strip order-detail-metrics">
              <DetailMetric
                label="Products"
                value={money(detail.transaction.productAmount)}
                detail={`${String(totalQuantity(detail))} item${totalQuantity(detail) === 1 ? "" : "s"}`}
              />
              <DetailMetric
                label="Shipping"
                value={money(detail.transaction.shippingAmount)}
                detail={detail.shippingType}
              />
              <DetailMetric
                label="Order total"
                value={money(detail.transaction.grossAmount)}
                detail={taxSummary(detail)}
              />
              <DetailMetric
                label="Net"
                value={money(detail.transaction.netAmount)}
                detail={`${money(detail.transaction.feeAmount)} fees`}
              />
            </section>

            <div class="order-detail-grid">
              <section class="surface order-detail-panel">
                <header class="surface__header">
                  <strong>Ship to</strong>
                </header>
                <div class="surface__body order-address">
                  <strong>{detail.shippingAddress.recipientName}</strong>
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
                  <DetailFact label="Channel" value={detail.orderChannel} />
                  <DetailFact
                    label="Fulfillment"
                    value={detail.orderFulfillment}
                  />
                  <DetailFact label="Payment" value={detail.paymentType} />
                  <DetailFact label="Refund" value={detail.refundStatus} />
                  <DetailFact
                    label="Estimated delivery"
                    value={dateTime(detail.estimatedDeliveryDate)}
                  />
                </dl>
              </section>

              <section class="surface order-detail-panel">
                <header class="surface__header">
                  <strong>Settlement</strong>
                </header>
                <dl class="detail-list">
                  <DetailFact
                    label="Products"
                    value={money(detail.transaction.productAmount)}
                  />
                  <DetailFact
                    label="Shipping"
                    value={money(detail.transaction.shippingAmount)}
                  />
                  {detail.transaction.taxes.map((tax) => (
                    <DetailFact
                      key={tax.code}
                      label={tax.code}
                      value={money(tax.amount)}
                    />
                  ))}
                  <DetailFact
                    label="Gross"
                    value={money(detail.transaction.grossAmount)}
                    strong
                  />
                  <DetailFact
                    label="Fees"
                    value={money(detail.transaction.feeAmount)}
                  />
                  {detail.transaction.directFeeAmount === 0 ? null : (
                    <DetailFact
                      label="Direct fees"
                      value={money(detail.transaction.directFeeAmount)}
                    />
                  )}
                  <DetailFact
                    label="Net"
                    value={money(detail.transaction.netAmount)}
                    strong
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
              {detail.products.length === 0 ? (
                <EmptyState title="No products were returned for this order" />
              ) : (
                <div class="data-region data-region--embedded">
                  <table class="data-table order-products-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th class="align-right">Quantity</th>
                        <th class="align-right">Unit price</th>
                        <th class="align-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.products.map((product) => (
                        <tr key={`${product.productId}:${product.skuId}`}>
                          <td>
                            <strong>{product.name}</strong>
                          </td>
                          <td class="align-right numeric">
                            {String(product.quantity)}
                          </td>
                          <td class="align-right numeric">
                            {money(product.unitPrice)}
                          </td>
                          <td class="align-right numeric">
                            <strong>{money(product.extendedPrice)}</strong>
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
                <div>
                  <strong>Tracking</strong>
                  <p>Tracking reported by TCGplayer</p>
                </div>
              </header>
              {detail.trackingNumbers.length === 0 ? (
                <EmptyState title="No tracking has been added" />
              ) : (
                <div class="data-region data-region--embedded">
                  <table class="data-table order-tracking-table">
                    <thead>
                      <tr>
                        <th>Carrier</th>
                        <th>Tracking number</th>
                        <th>Status</th>
                        <th>Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.trackingNumbers.map((tracking) => (
                        <tr
                          key={`${tracking.carrier}:${tracking.trackingNumber}`}
                        >
                          <td>{tracking.carrier}</td>
                          <td class="numeric">{tracking.trackingNumber}</td>
                          <td>{tracking.status}</td>
                          <td>{dateTime(tracking.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
    <div class="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function DetailFact({
  label,
  value,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{strong ? <strong>{value}</strong> : value}</dd>
    </div>
  );
}

function totalQuantity(detail: OrderDetail): number {
  return detail.products.reduce(
    (total, product) => total + product.quantity,
    0,
  );
}

function productSummary(detail: OrderDetail): string {
  const quantity = totalQuantity(detail);
  return `${String(detail.products.length)} product line${detail.products.length === 1 ? "" : "s"} · ${String(quantity)} item${quantity === 1 ? "" : "s"}`;
}

function taxSummary(detail: OrderDetail): string {
  const taxes = detail.transaction.taxes.reduce(
    (total, tax) => total + tax.amount,
    0,
  );
  return taxes === 0 ? "No tax reported" : `${money(taxes)} tax`;
}
