import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { uiApi } from "../api.js";
import type { OrderList } from "../contracts.js";
import { errorMessage } from "../utils.js";

type Scope = "all" | "ready-to-ship";

interface OrdersContextValue {
  readonly lists: Readonly<Record<Scope, OrderList | null>>;
  readonly loading: Readonly<Record<Scope, boolean>>;
  readonly errors: Readonly<Record<Scope, string>>;
  readonly shipmentsPendingReconciliation: ReadonlySet<string>;
  readonly load: (scope: Scope, force?: boolean) => Promise<void>;
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
  const [lists, setLists] = useState<Readonly<Record<Scope, OrderList | null>>>(
    { all: null, "ready-to-ship": null },
  );
  const [loading, setLoading] = useState<Readonly<Record<Scope, boolean>>>({
    all: false,
    "ready-to-ship": false,
  });
  const [errors, setErrors] = useState<Readonly<Record<Scope, string>>>({
    all: "",
    "ready-to-ship": "",
  });
  const shipmentReconciliationsRef = useRef(new Set<string>());
  const [shipmentsPendingReconciliation, setShipmentsPendingReconciliation] =
    useState<ReadonlySet<string>>(new Set());

  const acknowledgeShipment = useCallback((orderNumber: string) => {
    shipmentReconciliationsRef.current.add(orderNumber);
    setShipmentsPendingReconciliation(
      new Set(shipmentReconciliationsRef.current),
    );
    setLists((current) => ({
      ...current,
      "ready-to-ship":
        current["ready-to-ship"] === null
          ? null
          : readyList(
              current["ready-to-ship"],
              shipmentReconciliationsRef.current,
            ),
    }));
  }, []);

  const load = useCallback(
    async (scope: Scope, force = false) => {
      if (loading[scope]) return;
      if (!force && lists[scope] !== null) return;
      if (!force && scope === "ready-to-ship" && lists.all !== null) {
        const allOrders = lists.all;
        setLists((current) => ({
          ...current,
          "ready-to-ship": readyList(current.all ?? allOrders),
        }));
        return;
      }
      if (force) {
        const otherScope: Scope = scope === "all" ? "ready-to-ship" : "all";
        setLists((current) => ({ ...current, [otherScope]: null }));
      }
      setLoading((current) => ({ ...current, [scope]: true }));
      setErrors((current) => ({ ...current, [scope]: "" }));
      try {
        const result = await uiApi.orders(scope, force);
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
        setLists((current) => ({
          ...current,
          [scope]:
            scope === "ready-to-ship"
              ? readyList(result, shipmentReconciliationsRef.current)
              : result,
          ...(scope === "all"
            ? {
                "ready-to-ship": readyList(
                  result,
                  shipmentReconciliationsRef.current,
                ),
              }
            : {}),
        }));
      } catch (cause) {
        setErrors((current) => ({
          ...current,
          [scope]: errorMessage(cause, "Orders could not be loaded."),
        }));
      } finally {
        setLoading((current) => ({ ...current, [scope]: false }));
      }
    },
    [lists, loading],
  );

  const value = useMemo(
    () => ({
      lists,
      loading,
      errors,
      shipmentsPendingReconciliation,
      load,
      acknowledgeShipment,
    }),
    [
      acknowledgeShipment,
      errors,
      lists,
      load,
      loading,
      shipmentsPendingReconciliation,
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
