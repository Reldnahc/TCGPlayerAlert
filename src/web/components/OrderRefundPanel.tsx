import { useMemo, useRef, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import type {
  OrderDetail,
  RefundOptions,
  RefundRequest,
} from "../contracts.js";
import { useToast } from "../state/ToastContext.js";
import { errorMessage, money } from "../utils.js";
import { Button, Field, Notice } from "./ui.js";

export function OrderRefundPanel({
  order,
  options,
  onClose,
  onSubmitted,
}: {
  readonly order: OrderDetail;
  readonly options: RefundOptions;
  readonly onClose: () => void;
  readonly onSubmitted: () => Promise<void>;
}) {
  const toast = useToast();
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [type, setType] = useState<"full" | "partial">(
    order.refundCapabilities.full ? "full" : "partial",
  );
  const [origin, setOrigin] = useState(options.origins[0]?.value ?? "");
  const [reason, setReason] = useState(options.reasons[0]?.value ?? "");
  const [reasonText, setReasonText] = useState("");
  const [shippingAmount, setShippingAmount] = useState("");
  const [productAmounts, setProductAmounts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [review, setReview] = useState<RefundRequest | null>(null);
  const refundableProducts = useMemo(() => productRefundLines(order), [order]);
  const refundableShipping = useMemo(() => remainingShipping(order), [order]);

  const change = (action: () => void) => {
    action();
    setReview(null);
    setError("");
  };

  const prepareReview = () => {
    if (origin === "" || reason === "" || reasonText.trim() === "") {
      setError("Choose an origin and reason, then enter the refund message.");
      return;
    }
    if (type === "full") {
      setReview({
        type,
        origin,
        reason,
        reasonText: reasonText.trim(),
      });
      setError("");
      return;
    }

    const shippingRefundAmount = inputAmount(shippingAmount);
    if (
      shippingRefundAmount === undefined ||
      toCents(shippingRefundAmount) > toCents(refundableShipping)
    ) {
      setError("Enter a valid shipping amount within the refundable balance.");
      return;
    }
    const products: { skuId: string; refundAmount: number }[] = [];
    for (const product of refundableProducts) {
      const amount = inputAmount(productAmounts[product.skuId] ?? "");
      if (amount === undefined || toCents(amount) > toCents(product.maximum)) {
        setError(`Enter a valid refund amount for ${product.name}.`);
        return;
      }
      if (toCents(amount) > 0) {
        products.push({ skuId: product.skuId, refundAmount: amount });
      }
    }
    if (
      toCents(shippingRefundAmount) === 0 &&
      products.every((product) => toCents(product.refundAmount) === 0)
    ) {
      setError("A partial refund must total at least $0.01.");
      return;
    }
    setReview({
      type,
      origin,
      reason,
      reasonText: reasonText.trim(),
      shippingRefundAmount,
      products,
    });
    setError("");
  };

  const submit = async () => {
    if (review === null || submittingRef.current || uncertain) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await uiApi.refundOrder(order.orderNumber, review);
      toast.show("Refund submitted. Refreshing the order.", "success");
      onClose();
      await onSubmitted();
    } catch (cause) {
      const isUncertain =
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "AMBIGUOUS_RESULT";
      setUncertain(isUncertain);
      setError(
        isUncertain
          ? "The refund result is uncertain. Do not submit another refund. Refresh this order and verify it in TCGplayer."
          : errorMessage(cause, "The refund could not be submitted."),
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section class="surface order-refund-panel" aria-label="Order refund">
      <header class="surface__header">
        <div>
          <strong>Refund order</strong>
          <p>Review is always required before money is returned.</p>
        </div>
        <Button tone="quiet" onClick={onClose} disabled={submitting}>
          Close
        </Button>
      </header>
      <div class="surface__body order-refund-body">
        {error === "" ? null : <Notice tone="danger">{error}</Notice>}
        <>
          <div class="refund-type-picker" aria-label="Refund type">
            <button
              type="button"
              aria-label="Full refund"
              class={type === "full" ? "is-selected" : ""}
              aria-pressed={type === "full"}
              disabled={!order.refundCapabilities.full || uncertain}
              onClick={() => change(() => setType("full"))}
            >
              <strong>Full refund</strong>
              <span>Return the provider-calculated remaining order value</span>
            </button>
            <button
              type="button"
              aria-label="Partial refund"
              class={type === "partial" ? "is-selected" : ""}
              aria-pressed={type === "partial"}
              disabled={!order.refundCapabilities.partial || uncertain}
              onClick={() => change(() => setType("partial"))}
            >
              <strong>Partial refund</strong>
              <span>Choose product and shipping amounts</span>
            </button>
          </div>

          <div class="order-refund-fields">
            <Field label="Initiated by">
              <select
                value={origin}
                disabled={submitting || uncertain}
                onChange={(event) =>
                  change(() => setOrigin(event.currentTarget.value))
                }
              >
                {options.origins.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason">
              <select
                value={reason}
                disabled={submitting || uncertain}
                onChange={(event) =>
                  change(() => setReason(event.currentTarget.value))
                }
              >
                {options.reasons.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              class="order-refund-message"
              label="Message"
              hint="TCGplayer sends this to the buyer, seller, and TCGplayer."
            >
              <textarea
                aria-label="Message"
                value={reasonText}
                maxLength={500}
                rows={3}
                disabled={submitting || uncertain}
                onInput={(event) =>
                  change(() => setReasonText(event.currentTarget.value))
                }
              />
            </Field>
          </div>

          {type === "partial" ? (
            <div class="refund-amounts">
              <RefundAmountField
                label="Shipping"
                maximum={refundableShipping}
                value={shippingAmount}
                disabled={submitting || uncertain}
                onInput={(value) => change(() => setShippingAmount(value))}
              />
              {refundableProducts.map((product) => (
                <RefundAmountField
                  key={product.skuId}
                  label={product.name}
                  maximum={product.maximum}
                  value={productAmounts[product.skuId] ?? ""}
                  disabled={submitting || uncertain}
                  onInput={(value) =>
                    change(() =>
                      setProductAmounts((current) => ({
                        ...current,
                        [product.skuId]: value,
                      })),
                    )
                  }
                />
              ))}
            </div>
          ) : null}

          {review === null ? (
            <div class="order-refund-actions">
              <Button
                tone="danger"
                disabled={uncertain}
                onClick={prepareReview}
              >
                Review refund
              </Button>
            </div>
          ) : (
            <div class="refund-confirmation" role="alert">
              <div>
                <strong>Confirm this {review.type} refund</strong>
                <p>
                  {review.type === "full"
                    ? `TCGplayer will refund the remaining eligible value on order ${order.orderNumber}.`
                    : `${money(partialTotal(review))} will be refunded on order ${order.orderNumber}.`}
                </p>
                <small>This financial action cannot be undone here.</small>
              </div>
              <div class="order-refund-actions">
                <Button
                  tone="secondary"
                  disabled={submitting}
                  onClick={() => setReview(null)}
                >
                  Back
                </Button>
                <Button
                  tone="danger"
                  busy={submitting}
                  disabled={uncertain}
                  onClick={() => void submit()}
                >
                  {review.type === "full"
                    ? "Confirm full refund"
                    : `Confirm ${money(partialTotal(review))} refund`}
                </Button>
              </div>
            </div>
          )}
        </>
      </div>
    </section>
  );
}

function RefundAmountField({
  label,
  maximum,
  value,
  disabled,
  onInput,
}: {
  readonly label: string;
  readonly maximum: number;
  readonly value: string;
  readonly disabled: boolean;
  readonly onInput: (value: string) => void;
}) {
  return (
    <Field label={label} hint={`${money(maximum)} available`}>
      <div class="currency-input">
        <span aria-hidden="true">$</span>
        <input
          aria-label={label}
          type="number"
          min="0"
          max={maximum.toFixed(2)}
          step="0.01"
          inputMode="decimal"
          value={value}
          disabled={disabled || maximum <= 0}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
      </div>
    </Field>
  );
}

function inputAmount(value: string): number | undefined {
  if (value.trim() === "") return 0;
  const amount = Number(value);
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-9
  ) {
    return undefined;
  }
  return Math.round(amount * 100) / 100;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function productRefundLines(order: OrderDetail) {
  const lines = new Map<
    string,
    { skuId: string; name: string; cents: number }
  >();
  for (const product of order.products) {
    const current = lines.get(product.skuId);
    lines.set(product.skuId, {
      skuId: product.skuId,
      name: current?.name ?? product.name,
      cents: (current?.cents ?? 0) + toCents(product.extendedPrice),
    });
  }
  for (const refund of order.refunds) {
    for (const product of refund.products) {
      const current = lines.get(product.skuId);
      if (current !== undefined) {
        lines.set(product.skuId, {
          ...current,
          cents: current.cents - toCents(product.amount),
        });
      }
    }
  }
  return [...lines.values()].map((line) => ({
    skuId: line.skuId,
    name: line.name,
    maximum: Math.max(0, line.cents) / 100,
  }));
}

function remainingShipping(order: OrderDetail): number {
  const previous = order.refunds.reduce(
    (total, refund) => total + toCents(refund.shippingAmount),
    0,
  );
  return (
    Math.max(0, toCents(order.transaction.shippingAmount) - previous) / 100
  );
}

function partialTotal(refund: Extract<RefundRequest, { type: "partial" }>) {
  return (
    (toCents(refund.shippingRefundAmount) +
      refund.products.reduce(
        (total, product) => total + toCents(product.refundAmount),
        0,
      )) /
    100
  );
}
