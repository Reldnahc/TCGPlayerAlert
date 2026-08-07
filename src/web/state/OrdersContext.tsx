import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useMemo, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import type { OrderList } from "../contracts.js";
import { errorMessage } from "../utils.js";

type Scope = "all" | "ready-to-ship";

interface OrdersContextValue {
  readonly lists: Readonly<Record<Scope, OrderList | null>>;
  readonly loading: Readonly<Record<Scope, boolean>>;
  readonly errors: Readonly<Record<Scope, string>>;
  readonly load: (scope: Scope, force?: boolean) => Promise<void>;
}

const OrdersContext = createContext<OrdersContextValue | null>(null);

function readyList(list: OrderList): OrderList {
  return {
    ...list,
    orders: list.orders.filter((order) => order.canMarkShipped),
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
        setLists((current) => ({
          ...current,
          [scope]: result,
          ...(scope === "all" ? { "ready-to-ship": readyList(result) } : {}),
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
    () => ({ lists, loading, errors, load }),
    [errors, lists, load, loading],
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
