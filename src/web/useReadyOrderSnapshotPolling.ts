import { useEffect } from "preact/hooks";
import { useOrders } from "./state/OrdersContext.js";

const SNAPSHOT_REFRESH_MILLISECONDS = 5_000;

export function useReadyOrderSnapshotPolling(enabled = true): void {
  const { load } = useOrders();

  useEffect(() => {
    if (!enabled) return;
    void load("ready-to-ship", false, true);
    const timer = window.setInterval(() => {
      void load("ready-to-ship", false, true);
    }, SNAPSHOT_REFRESH_MILLISECONDS);
    return () => window.clearInterval(timer);
  }, [enabled, load]);
}
