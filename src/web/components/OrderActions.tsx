import { useState } from "preact/hooks";
import { requiresShipmentTracking } from "../../shipment-policy.js";
import { orderDetailUrl, packingSlipUrl, uiApi } from "../api.js";
import type { Order } from "../contracts.js";
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
    await run(
      "pirate",
      async () => {
        const prepared = await uiApi.pirateShip(order.orderNumber);
        try {
          await navigator.clipboard.writeText(prepared.pasteAddress);
        } catch {
          const accepted = window.prompt(
            "Copy this address, then select OK to open Pirate Ship.",
            prepared.pasteAddress,
          );
          if (accepted === null) {
            throw new Error("Pirate Ship was not opened.");
          }
        }
        const opened = window.open(
          prepared.url,
          "_blank",
          "noopener,noreferrer",
        );
        if (opened === null) window.location.assign(prepared.url);
      },
      "Address copied. Paste it into Pirate Ship.",
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
        await uiApi.addTracking(order.orderNumber, normalized);
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
      requiresShipmentTracking(order.totalAmount) &&
      hasTracking !== true &&
      !trackingAdded
    ) {
      if (hasTracking === undefined) {
        if (busy !== "") return;
        setBusy("shipped");
        try {
          const detail = await uiApi.order(order.orderNumber, true);
          if (detail.trackingNumbers.length > 0) {
            setTrackingAdded(true);
          } else {
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
      !window.confirm(`Mark order ${order.orderNumber} as shipped?`)
    )
      return;
    await run(
      "shipped",
      async () => {
        const result = await uiApi.markShipped(order.orderNumber);
        await completeShipment(result.orderNumber, scope);
        await onChanged?.();
      },
      "Order marked shipped.",
    );
  }

  const shipmentPendingReconciliation = shipmentsPendingReconciliation.has(
    order.orderNumber,
  );
  const missingRequiredTracking =
    requiresShipmentTracking(order.totalAmount) &&
    hasTracking === false &&
    !trackingAdded;
  const markShippedDisabled =
    !order.canMarkShipped ||
    shipmentPendingReconciliation ||
    missingRequiredTracking;
  const markShippedTitle = shipmentPendingReconciliation
    ? "Shipment was accepted and is waiting for the order list to reconcile."
    : missingRequiredTracking
      ? "Add tracking before marking an order of $50 or more shipped."
      : order.canMarkShipped
        ? ""
        : `Unavailable for TCGplayer status: ${order.status}`;

  const primary = (
    <>
      <Button
        tone="secondary"
        icon="truck"
        busy={busy === "pirate"}
        onClick={() => void openPirateShip()}
      >
        Pirate Ship
      </Button>
      <Button
        tone="secondary"
        busy={busy === "tracking"}
        onClick={() => setTrackingOpen((value) => !value)}
      >
        Tracking
      </Button>
      <Button
        tone="primary"
        busy={busy === "shipped"}
        disabled={markShippedDisabled}
        title={markShippedTitle}
        onClick={() => void markShipped()}
      >
        Mark shipped
      </Button>
    </>
  );

  return (
    <div class="order-action-stack">
      <div class="row-actions">
        {compact ? (
          primary
        ) : (
          <>
            <Button
              tone="secondary"
              busy={busy === "tracking"}
              onClick={() => setTrackingOpen((value) => !value)}
            >
              Tracking
            </Button>
            <Button
              tone="primary"
              busy={busy === "shipped"}
              disabled={markShippedDisabled}
              title={markShippedTitle}
              onClick={() => void markShipped()}
            >
              Mark shipped
            </Button>
            <div class="menu">
              <IconButton
                label="More order actions"
                icon="more"
                onClick={() => setMenuOpen((value) => !value)}
              />
              {menuOpen ? (
                <div class="menu__popover">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      void run(
                        "label",
                        async () => {
                          await uiApi.printOrder(
                            order.orderNumber,
                            "print-address-label",
                          );
                        },
                        "Address label sent to the printer.",
                      );
                    }}
                  >
                    <Icon name="printer" size={15} />
                    Print address label
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      void run(
                        "slip",
                        async () => {
                          await uiApi.printOrder(
                            order.orderNumber,
                            "print-packing-slip",
                          );
                        },
                        "Packing slip sent to the printer.",
                      );
                    }}
                  >
                    <Icon name="printer" size={15} />
                    Print packing slip
                  </button>
                  <a
                    href={packingSlipUrl(order.orderNumber)}
                    download={`packing-slip-${order.orderNumber}.pdf`}
                    onClick={() => setMenuOpen(false)}
                  >
                    <Icon name="download" size={15} />
                    Download packing slip
                  </a>
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
                  <a
                    href={orderDetailUrl(order.orderNumber)}
                    onClick={() => setMenuOpen(false)}
                  >
                    <Icon name="external" size={15} />
                    Order details
                  </a>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
      {trackingOpen ? (
        <div class="tracking-entry">
          <input
            aria-label={`Tracking number for order ${order.orderNumber}`}
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
