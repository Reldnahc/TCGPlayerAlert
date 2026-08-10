import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { UiApiError, uiApi } from "../api.js";
import type { OrderList } from "../contracts.js";
import { errorMessage } from "../utils.js";
import { useAuthentication } from "./AuthenticationContext.js";

type Scope = "all" | "ready-to-ship";

interface OrdersContextValue {
  readonly lists: Readonly<Record<Scope, OrderList | null>>;
  readonly loading: Readonly<Record<Scope, boolean>>;
  readonly errors: Readonly<Record<Scope, string>>;
  readonly shipmentsPendingReconciliation: ReadonlySet<string>;
  readonly load: (
    scope: Scope,
    force?: boolean,
    refreshLoaded?: boolean,
  ) => Promise<void>;
  readonly synchronizeReadyOrders: () => Promise<void>;
  readonly acknowledgeShipment: (orderNumber: string) => void;
}

const OrdersContext = createContext<OrdersContextValue | null>(null);

function readyList(
  list: OrderList,
  shipmentsPendingReconciliation: ReadonlySet<string> = new Set(),
): OrderList {
  return {
    ...list,
    orders: list.orders.filter(
      (order) =>
        order.canMarkShipped &&
        !shipmentsPendingReconciliation.has(order.orderNumber),
    ),
  };
}

export function OrdersProvider({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  const { status: sellerConnection } = useAuthentication();
  const connected = sellerConnection?.state === "connected";
  const [lists, setLists] = useState<Readonly<Record<Scope, OrderList | null>>>(
    { all: null, "ready-to-ship": null },
  );
  const [loading, setLoading] = useState<Readonly<Record<Scope, boolean>>>({
    all: false,
    "ready-to-ship": false,
  });
  const listsRef = useRef(lists);
  const loadingRef = useRef(loading);
  listsRef.current = lists;
  loadingRef.current = loading;
  const [errors, setErrors] = useState<Readonly<Record<Scope, string>>>({
    all: "",
    "ready-to-ship": "",
  });
  const shipmentReconciliationsRef = useRef(new Set<string>());
  const [shipmentsPendingReconciliation, setShipmentsPendingReconciliation] =
    useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (connected) return;
    const emptyLists = { all: null, "ready-to-ship": null } as const;
    const idle = { all: false, "ready-to-ship": false } as const;
    shipmentReconciliationsRef.current.clear();
    listsRef.current = emptyLists;
    loadingRef.current = idle;
    setLists(emptyLists);
    setLoading(idle);
    setErrors({ all: "", "ready-to-ship": "" });
    setShipmentsPendingReconciliation(new Set());
  }, [connected]);

  const acknowledgeShipment = useCallback((orderNumber: string) => {
    shipmentReconciliationsRef.current.add(orderNumber);
    setShipmentsPendingReconciliation(
      new Set(shipmentReconciliationsRef.current),
    );
    setLists((current) => {
      const next = {
        ...current,
        "ready-to-ship":
          current["ready-to-ship"] === null
            ? null
            : readyList(
                current["ready-to-ship"],
                shipmentReconciliationsRef.current,
              ),
      };
      listsRef.current = next;
      return next;
    });
  }, []);

  const acceptOrderList = useCallback((scope: Scope, result: OrderList) => {
    let reconciliationsChanged = false;
    for (const orderNumber of shipmentReconciliationsRef.current) {
      const order = result.orders.find(
        (candidate) => candidate.orderNumber === orderNumber,
      );
      if (order?.canMarkShipped !== true) {
        shipmentReconciliationsRef.current.delete(orderNumber);
        reconciliationsChanged = true;
      }
    }
    if (reconciliationsChanged) {
      setShipmentsPendingReconciliation(
        new Set(shipmentReconciliationsRef.current),
      );
    }
    setLists((current) => {
      const next = {
        ...current,
        [scope]:
          scope === "ready-to-ship"
            ? readyList(result, shipmentReconciliationsRef.current)
            : result,
      };
      listsRef.current = next;
      return next;
    });
  }, []);

  const load = useCallback(
    async (scope: Scope, force = false, refreshLoaded = false) => {
      if (!connected) return;
      if (loadingRef.current[scope]) return;
      if (!force && !refreshLoaded && listsRef.current[scope] !== null) return;
      const started = { ...loadingRef.current, [scope]: true };
      loadingRef.current = started;
      setLoading(started);
      setErrors((current) => ({ ...current, [scope]: "" }));
      try {
        const result =
          scope === "ready-to-ship"
            ? (await uiApi.readyOrders()).snapshot
            : await uiApi.orders(force);
        if (result === null) return;
        acceptOrderList(scope, result);
      } catch (cause) {
        if (
          cause instanceof UiApiError &&
          cause.code === "AUTHENTICATION_REQUIRED"
        ) {
          return;
        }
        setErrors((current) => ({
          ...current,
          [scope]: errorMessage(cause, "Orders could not be loaded."),
        }));
      } finally {
        const finished = { ...loadingRef.current, [scope]: false };
        loadingRef.current = finished;
        setLoading(finished);
      }
    },
    [acceptOrderList, connected],
  );

  const synchronizeReadyOrders = useCallback(async () => {
    if (!connected || loadingRef.current["ready-to-ship"]) return;
    const scope = "ready-to-ship" as const;
    const started = { ...loadingRef.current, [scope]: true };
    loadingRef.current = started;
    setLoading(started);
    setErrors((current) => ({ ...current, [scope]: "" }));
    try {
      const result = await uiApi.synchronizeReadyOrders();
      acceptOrderList(scope, result);
    } catch (cause) {
      if (
        cause instanceof UiApiError &&
        cause.code === "AUTHENTICATION_REQUIRED"
      ) {
        return;
      }
      setErrors((current) => ({
        ...current,
        [scope]: errorMessage(cause, "Orders could not be synchronized."),
      }));
    } finally {
      const finished = { ...loadingRef.current, [scope]: false };
      loadingRef.current = finished;
      setLoading(finished);
    }
  }, [acceptOrderList, connected]);

  const value = useMemo(
    () => ({
      lists,
      loading,
      errors,
      shipmentsPendingReconciliation,
      load,
      synchronizeReadyOrders,
      acknowledgeShipment,
    }),
    [
      acknowledgeShipment,
      errors,
      lists,
      load,
      loading,
      shipmentsPendingReconciliation,
      synchronizeReadyOrders,
    ],
  );
  return (
    <OrdersContext.Provider value={value}>{children}</OrdersContext.Provider>
  );
}

export function useOrders(): OrdersContextValue {
  const value = useContext(OrdersContext);
  if (value === null) throw new Error("OrdersProvider is missing.");
  return value;
}
