import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { UiApiError, uiApi } from "../api.js";
import {
  orderActionAvailable,
  orderKey,
  type MarketplaceConnections,
  type Order,
  type OrderList,
} from "../contracts.js";
import { errorMessage } from "../utils.js";

type Scope = "all" | "ready-to-ship";

const AUTOMATIC_RECONCILIATION_RETRY_MILLISECONDS = 30_000;

interface OrdersContextValue {
  readonly lists: Readonly<Record<Scope, OrderList | null>>;
  readonly loading: Readonly<Record<Scope, boolean>>;
  readonly errors: Readonly<Record<Scope, string>>;
  readonly shipmentsPendingReconciliation: ReadonlySet<string>;
  readonly connections: MarketplaceConnections | null;
  readonly load: (
    scope: Scope,
    force?: boolean,
    refreshLoaded?: boolean,
  ) => Promise<void>;
  readonly synchronizeReadyOrders: () => Promise<void>;
  readonly completeShipment: (order: Order, scope: Scope) => Promise<void>;
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
        orderActionAvailable(order, "mark-shipped") &&
        !shipmentsPendingReconciliation.has(orderKey(order)),
    ),
  };
}

function allOrdersList(
  list: OrderList,
  shipmentsPendingReconciliation: ReadonlySet<string>,
): OrderList {
  return {
    ...list,
    orders: list.orders.map((order) =>
      shipmentsPendingReconciliation.has(orderKey(order)) &&
      orderActionAvailable(order, "mark-shipped")
        ? {
            ...order,
            actions: {
              ...order.actions,
              "mark-shipped": {
                state: "unavailable" as const,
                reason: "review-required" as const,
              },
            },
          }
        : order,
    ),
  };
}

function readyOrderNumbers(list: OrderList): ReadonlySet<string> {
  return new Set(list.orders.map(orderKey));
}

export function OrdersProvider({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  const [connections, setConnections] = useState<MarketplaceConnections | null>(
    null,
  );
  const connectionsRef = useRef(connections);
  const [lists, setLists] = useState<Readonly<Record<Scope, OrderList | null>>>(
    { all: null, "ready-to-ship": null },
  );
  const [loading, setLoading] = useState<Readonly<Record<Scope, boolean>>>({
    all: false,
    "ready-to-ship": false,
  });
  const listsRef = useRef(lists);
  const loadingRef = useRef(loading);
  const pendingForcedLoadsRef = useRef(new Set<Scope>());
  const loadRef = useRef<OrdersContextValue["load"]>();
  const readyOrderNumbersRef = useRef<ReadonlySet<string>>();
  const allOrderReconciliationsRef = useRef(new Set<string>());
  const automaticReconciliationRetryAtRef = useRef(0);
  const refreshAllOrdersRef = useRef<() => Promise<void>>();
  listsRef.current = lists;
  loadingRef.current = loading;
  connectionsRef.current = connections;
  const [errors, setErrors] = useState<Readonly<Record<Scope, string>>>({
    all: "",
    "ready-to-ship": "",
  });
  const shipmentReconciliationsRef = useRef(new Set<string>());
  const [shipmentsPendingReconciliation, setShipmentsPendingReconciliation] =
    useState<ReadonlySet<string>>(new Set());

  const acknowledgeShipment = useCallback((order: Order) => {
    const key = orderKey(order);
    shipmentReconciliationsRef.current.add(key);
    if (listsRef.current.all !== null) {
      allOrderReconciliationsRef.current.add(key);
      automaticReconciliationRetryAtRef.current = 0;
    }
    setShipmentsPendingReconciliation(
      new Set(shipmentReconciliationsRef.current),
    );
    setLists((current) => {
      const next = {
        ...current,
        all:
          current.all === null
            ? null
            : allOrdersList(current.all, shipmentReconciliationsRef.current),
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
    if (scope === "all") {
      for (const key of shipmentReconciliationsRef.current) {
        const order = result.orders.find(
          (candidate) => orderKey(candidate) === key,
        );
        if (
          order === undefined ||
          !orderActionAvailable(order, "mark-shipped")
        ) {
          shipmentReconciliationsRef.current.delete(key);
          allOrderReconciliationsRef.current.delete(key);
          reconciliationsChanged = true;
        }
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
            : allOrdersList(result, shipmentReconciliationsRef.current),
      };
      listsRef.current = next;
      return next;
    });
  }, []);

  const acceptReadyOrderList = useCallback(
    (result: OrderList) => {
      const previousOrderNumbers = readyOrderNumbersRef.current;
      const nextOrderNumbers = readyOrderNumbers(result);
      readyOrderNumbersRef.current = nextOrderNumbers;
      acceptOrderList("ready-to-ship", result);

      let changed = false;
      if (previousOrderNumbers !== undefined && listsRef.current.all !== null) {
        for (const key of previousOrderNumbers) {
          if (!nextOrderNumbers.has(key)) {
            allOrderReconciliationsRef.current.add(key);
            changed = true;
          }
        }
        for (const key of nextOrderNumbers) {
          if (!previousOrderNumbers.has(key)) {
            allOrderReconciliationsRef.current.add(key);
            changed = true;
          }
        }
      }
      if (changed) automaticReconciliationRetryAtRef.current = 0;
      if (allOrderReconciliationsRef.current.size > 0) {
        void refreshAllOrdersRef.current?.();
      }
    },
    [acceptOrderList],
  );

  const load = useCallback(
    async (scope: Scope, force = false, refreshLoaded = false) => {
      if (loadingRef.current[scope]) {
        if (force) pendingForcedLoadsRef.current.add(scope);
        return;
      }
      if (!force && !refreshLoaded && listsRef.current[scope] !== null) return;
      const started = { ...loadingRef.current, [scope]: true };
      loadingRef.current = started;
      setLoading(started);
      setErrors((current) => ({ ...current, [scope]: "" }));
      try {
        if (connectionsRef.current === null || force) {
          const nextConnections = await uiApi.marketplaceConnections(force);
          connectionsRef.current = nextConnections;
          setConnections(nextConnections);
        }
        const result =
          scope === "ready-to-ship"
            ? await uiApi.readyOrders()
            : await uiApi.orders(force);
        if (scope === "ready-to-ship") {
          acceptReadyOrderList(result);
        } else {
          acceptOrderList(scope, result);
          const readyOrderNumbers = readyOrderNumbersRef.current;
          for (const key of allOrderReconciliationsRef.current) {
            if (shipmentReconciliationsRef.current.has(key)) continue;
            const order = result.orders.find(
              (candidate) => orderKey(candidate) === key,
            );
            const expectedReady = readyOrderNumbers?.has(key) === true;
            if (
              (expectedReady &&
                order !== undefined &&
                orderActionAvailable(order, "mark-shipped")) ||
              (!expectedReady &&
                (order === undefined ||
                  !orderActionAvailable(order, "mark-shipped")))
            ) {
              allOrderReconciliationsRef.current.delete(key);
            }
          }
          if (allOrderReconciliationsRef.current.size === 0) {
            automaticReconciliationRetryAtRef.current = 0;
          }
        }
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
        if (pendingForcedLoadsRef.current.delete(scope)) {
          void loadRef.current?.(scope, true);
        }
      }
    },
    [acceptOrderList, acceptReadyOrderList],
  );
  loadRef.current = load;

  refreshAllOrdersRef.current = async () => {
    if (allOrderReconciliationsRef.current.size === 0) return;
    if (Date.now() < automaticReconciliationRetryAtRef.current) return;
    await load("all", true);
    if (allOrderReconciliationsRef.current.size > 0) {
      automaticReconciliationRetryAtRef.current =
        Date.now() + AUTOMATIC_RECONCILIATION_RETRY_MILLISECONDS;
    }
  };

  const completeShipment = useCallback(
    (order: Order, scope: Scope) => {
      acknowledgeShipment(order);
      if (scope === "all" || listsRef.current.all !== null) {
        void load("all", true);
      }
      return Promise.resolve();
    },
    [acknowledgeShipment, load],
  );

  const synchronizeReadyOrders = useCallback(async () => {
    if (loadingRef.current["ready-to-ship"]) return;
    const scope = "ready-to-ship" as const;
    const started = { ...loadingRef.current, [scope]: true };
    loadingRef.current = started;
    setLoading(started);
    setErrors((current) => ({ ...current, [scope]: "" }));
    try {
      const result = await uiApi.synchronizeReadyOrders();
      acceptReadyOrderList(result);
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
  }, [acceptReadyOrderList]);

  const value = useMemo(
    () => ({
      lists,
      loading,
      errors,
      shipmentsPendingReconciliation,
      connections,
      load,
      synchronizeReadyOrders,
      completeShipment,
    }),
    [
      completeShipment,
      connections,
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
