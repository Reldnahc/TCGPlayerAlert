import { useState } from "preact/hooks";
import { requiresShipmentTracking } from "../../shipment-policy.js";
import { orderDetailUrl, packingSlipUrl, uiApi } from "../api.js";
import { orderActionAvailable, orderKey, type Order } from "../contracts.js";
import { useOrders } from "../state/OrdersContext.js";
import { useSettings } from "../state/SettingsContext.js";
import { useToast } from "../state/ToastContext.js";
import { errorMessage } from "../utils.js";
import { Icon } from "./Icon.js";
import { Button, IconButton } from "./ui.js";

export function OrderActions({
  order,
  scope,
  compact = false,
  hasTracking,
  onChanged,
}: {
  readonly order: Order;
  readonly scope: "all" | "ready-to-ship";
  readonly compact?: boolean;
  readonly hasTracking?: boolean;
  readonly onChanged?: () => void | Promise<void>;
}) {
  const { completeShipment, load, shipmentsPendingReconciliation } =
    useOrders();
  const { settings } = useSettings();
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingAdded, setTrackingAdded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function run(
    name: string,
    action: () => Promise<void>,
    success: string,
    refresh = false,
  ): Promise<void> {
    if (busy !== "") return;
    setBusy(name);
    try {
      await action();
      if (refresh) await load(scope, true);
      toast.show(success, "success");
    } catch (cause) {
      toast.show(errorMessage(cause, "The order action failed."), "danger");
    } finally {
      setBusy("");
    }
  }

  async function openPirateShip() {
    if (busy !== "") return;
    const prepared = uiApi.pirateShip(order.ref);
    const copying = copyPromisedTextToClipboard(
      prepared.then((result) => result.pasteAddress),
    );
    const opened = window.open("about:blank", "_blank");
    if (opened !== null) opened.opener = null;
    await run(
      "pirate",
      async () => {
        try {
          const result = await prepared;
          await copying;
          if (opened === null) {
            throw new Error(
              "Address copied, but Pirate Ship was blocked. Allow pop-ups and try again.",
            );
          }
          opened.location.assign(result.url);
        } catch (cause) {
          opened?.close();
          throw cause;
        }
      },
      "Address copied. Paste it into Pirate Ship.",
    );
  }

  async function printOrder(
    actionType: "print-address-label" | "print-packing-slip",
  ) {
    setMenuOpen(false);
    await run(
      actionType,
      () => uiApi.printOrder(order.ref, actionType),
      actionType === "print-address-label"
        ? "Address label sent to the printer."
        : "Packing slip sent to the printer.",
    );
  }

  async function addTracking() {
    const normalized = trackingNumber.trim();
    if (normalized === "") {
      toast.show("Enter a tracking number.", "warning");
      return;
    }
    await run(
      "tracking",
      async () => {
        await uiApi.addTracking(order.ref, normalized);
        setTrackingAdded(true);
        setTrackingOpen(false);
        setTrackingNumber("");
        await onChanged?.();
      },
      "Tracking added.",
      true,
    );
  }

  async function markShipped() {
    if (
      requiresShipmentTracking(order.totals.total.minorUnits / 100) &&
      hasTracking !== true &&
      !trackingAdded
    ) {
      if (hasTracking === undefined) {
        if (busy !== "") return;
        setBusy("shipped");
        try {
          const detail = await uiApi.order(order.ref, true);
          if (detail.trackingNumbers.length > 0) setTrackingAdded(true);
          else {
            setTrackingOpen(true);
            toast.show(
              "Add tracking before marking an order of $50 or more shipped.",
              "warning",
            );
            return;
          }
        } catch (cause) {
          toast.show(
            errorMessage(cause, "Tracking could not be verified."),
            "danger",
          );
          return;
        } finally {
          setBusy("");
        }
      } else {
        setTrackingOpen(true);
        toast.show(
          "Add tracking before marking an order of $50 or more shipped.",
          "warning",
        );
        return;
      }
    }
    if (
      settings?.confirmBeforeMarkingShipped !== false &&
      !window.confirm(`Mark order ${order.displayOrderNumber} as shipped?`)
    ) {
      return;
    }
    await run(
      "shipped",
      async () => {
        await uiApi.markShipped(order.ref);
        await completeShipment(order, scope);
        await onChanged?.();
      },
      "Order marked shipped.",
    );
  }

  const shipmentPendingReconciliation = shipmentsPendingReconciliation.has(
    orderKey(order),
  );
  const missingRequiredTracking =
    requiresShipmentTracking(order.totals.total.minorUnits / 100) &&
    hasTracking === false &&
    !trackingAdded;
  const canMarkShipped = orderActionAvailable(order, "mark-shipped");
  const markShippedDisabled =
    !canMarkShipped || shipmentPendingReconciliation || missingRequiredTracking;
  const markShippedTitle = shipmentPendingReconciliation
    ? "Shipment was accepted and is waiting for the order list to reconcile."
    : missingRequiredTracking
      ? "Add tracking before marking an order of $50 or more shipped."
      : canMarkShipped
        ? ""
        : `Unavailable for order status: ${order.providerStatus}`;
  const canTrack = orderActionAvailable(order, "add-tracking");
  const canPirateShip = orderActionAvailable(order, "pirate-ship");

  const primary = (
    <>
      {canPirateShip ? (
        <Button
          tone="secondary"
          icon="truck"
          busy={busy === "pirate"}
          onClick={() => void openPirateShip()}
        >
          Pirate Ship
        </Button>
      ) : null}
      {canTrack ? (
        <Button
          tone="secondary"
          busy={busy === "tracking"}
          onClick={() => setTrackingOpen((value) => !value)}
        >
          Tracking
        </Button>
      ) : null}
      {canMarkShipped ? (
        <Button
          tone="primary"
          busy={busy === "shipped"}
          disabled={markShippedDisabled}
          title={markShippedTitle}
          onClick={() => void markShipped()}
        >
          Mark shipped
        </Button>
      ) : null}
    </>
  );

  return (
    <div class="order-action-stack">
      <div class="row-actions">
        {compact ? (
          primary
        ) : (
          <>
            {canTrack ? (
              <Button
                tone="secondary"
                busy={busy === "tracking"}
                onClick={() => setTrackingOpen((value) => !value)}
              >
                Tracking
              </Button>
            ) : null}
            {canMarkShipped ? (
              <Button
                tone="primary"
                busy={busy === "shipped"}
                disabled={markShippedDisabled}
                title={markShippedTitle}
                onClick={() => void markShipped()}
              >
                Mark shipped
              </Button>
            ) : null}
            <div class="menu">
              <IconButton
                label="More order actions"
                icon="more"
                onClick={() => setMenuOpen((value) => !value)}
              />
              {menuOpen ? (
                <div class="menu__popover">
                  {orderActionAvailable(order, "print-address-label") ? (
                    <button
                      type="button"
                      disabled={busy !== ""}
                      onClick={() => void printOrder("print-address-label")}
                    >
                      <Icon name="printer" size={15} />
                      Print address label
                    </button>
                  ) : null}
                  {orderActionAvailable(order, "packing-slip") ? (
                    <button
                      type="button"
                      disabled={busy !== ""}
                      onClick={() => void printOrder("print-packing-slip")}
                    >
                      <Icon name="printer" size={15} />
                      Print packing slip
                    </button>
                  ) : null}
                  {orderActionAvailable(order, "packing-slip") ? (
                    <a
                      href={packingSlipUrl(order.ref)}
                      download={`packing-slip-${order.displayOrderNumber}.pdf`}
                      onClick={() => setMenuOpen(false)}
                    >
                      <Icon name="download" size={15} />
                      Download packing slip
                    </a>
                  ) : null}
                  {canPirateShip ? (
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        void openPirateShip();
                      }}
                    >
                      <Icon name="truck" size={15} />
                      Open in Pirate Ship
                    </button>
                  ) : null}
                  {orderActionAvailable(order, "view-detail") ? (
                    <a
                      href={orderDetailUrl(order.ref)}
                      onClick={() => setMenuOpen(false)}
                    >
                      <Icon name="external" size={15} />
                      Order details
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
      {trackingOpen && canTrack ? (
        <div class="tracking-entry">
          <input
            aria-label={`Tracking number for order ${order.displayOrderNumber}`}
            type="text"
            maxLength={256}
            autoComplete="off"
            placeholder="Tracking number"
            value={trackingNumber}
            onInput={(event) => setTrackingNumber(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addTracking();
            }}
          />
          <Button
            tone="primary"
            busy={busy === "tracking"}
            onClick={() => void addTracking()}
          >
            Add
          </Button>
          <IconButton
            label="Cancel tracking"
            icon="close"
            onClick={() => setTrackingOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

interface ClipboardCopyDependencies {
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly document?: Document;
  readonly executeCopy?: (command: string) => boolean;
}

function copyPromisedTextToClipboard(text: Promise<string>): Promise<void> {
  if (
    typeof globalThis.ClipboardItem !== "function" ||
    typeof navigator.clipboard.write !== "function"
  ) {
    return text.then((value) => copyTextToClipboard(value));
  }
  const item = new globalThis.ClipboardItem({
    "text/plain": text.then(
      (value) => new Blob([value], { type: "text/plain" }),
    ),
  });
  return navigator.clipboard.write([item]);
}

export async function copyTextToClipboard(
  text: string,
  dependencies: ClipboardCopyDependencies = {},
): Promise<void> {
  const clipboard = dependencies.clipboard ?? navigator.clipboard;
  try {
    await clipboard.writeText(text);
    return;
  } catch {
    // Clipboard permission can expire while the address request is in flight.
  }

  const ownerDocument = dependencies.document ?? document;
  const textarea = ownerDocument.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -10000px";
  textarea.style.opacity = "0";
  ownerDocument.body.append(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const executeCopy =
      dependencies.executeCopy ??
      ((command: string) => {
        // Required only when the modern clipboard permission expires mid-action.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        return ownerDocument.execCommand(command);
      });
    const copied = executeCopy("copy");
    if (!copied) throw new Error("Clipboard copy was rejected.");
  } catch {
    throw new Error(
      "The address could not be copied. Allow clipboard access and try again.",
    );
  } finally {
    textarea.remove();
  }
}
