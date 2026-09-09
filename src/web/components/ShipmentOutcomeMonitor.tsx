import { useEffect, useRef } from "preact/hooks";
import { uiApi } from "../api.js";
import { useOrders } from "../state/OrdersContext.js";
import { useSettings } from "../state/SettingsContext.js";
import { useToast } from "../state/ToastContext.js";

const SHIPMENT_OUTCOME_POLL_MILLISECONDS = 250;

export function ShipmentOutcomeMonitor() {
  const { settings } = useSettings();
  const { completeShipment } = useOrders();
  const { show } = useToast();
  const lastResultAtRef = useRef<string>();
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    if (settings?.shipmentScanner.enabled !== true) return;
    let stopped = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const status = await uiApi.shipmentScannerStatus();
        if (stopped) return;
        const resultAt = status.backgroundCamera.lastResultAt;
        const result = status.backgroundCamera.lastResult;
        if (resultAt !== undefined && resultAt !== lastResultAtRef.current) {
          const isFirstObservation = lastResultAtRef.current === undefined;
          lastResultAtRef.current = resultAt;
          const happenedWhileOpen =
            Date.parse(resultAt) >= startedAtRef.current;
          if (
            result?.state === "shipped" &&
            (!isFirstObservation || happenedWhileOpen)
          ) {
            await completeShipment(result.order, "ready-to-ship");
          }
          if (
            result !== undefined &&
            (!isFirstObservation || happenedWhileOpen)
          ) {
            const notification = scannerNotification(result);
            show(notification.text, notification.tone);
          }
        }
      } catch {
        // The Scanner workspace owns status-error presentation. This observer
        // stays quiet so a disconnected scanner cannot create repeated toasts.
      } finally {
        if (!stopped) {
          timer = window.setTimeout(
            () => void poll(),
            SHIPMENT_OUTCOME_POLL_MILLISECONDS,
          );
        }
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [completeShipment, settings?.shipmentScanner.enabled, show]);

  return null;
}

function scannerNotification(
  result: Awaited<ReturnType<typeof uiApi.scanShipmentTag>>,
): {
  readonly text: string;
  readonly tone: "success" | "warning" | "danger" | "info";
} {
  if (result.state === "shipped") {
    return {
      text: `Order ${result.order.displayOrderNumber} marked shipped from scanner.`,
      tone: "success",
    };
  }
  if (result.state === "matched") {
    return {
      text: `Scanner matched order ${result.order.displayOrderNumber}. Review it on the Scanner page.`,
      tone: "warning",
    };
  }
  if (result.state === "already-processed") {
    return {
      text: `Order ${result.ref.remoteId} was already processed.`,
      tone: "info",
    };
  }
  if (result.state === "ambiguous") {
    return {
      text: `Scanner tag ${String(result.tagId)} matched multiple ready orders.`,
      tone: "danger",
    };
  }
  if (result.state === "review-required") {
    return {
      text: `Scanner shipment for order ${result.ref.remoteId} requires review.`,
      tone: "danger",
    };
  }
  return {
    text: `No ready order matched scanner tag ${String(result.tagId)}.`,
    tone: "warning",
  };
}
