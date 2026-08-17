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

const AUTOMATIC_RECONCILIATION_RETRY_MILLISECONDS = 30_000;

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
  readonly completeShipment: (
    orderNumber: string,
    scope: Scope,
  ) => Promise<void>;
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

function allOrdersList(
  list: OrderList,
  shipmentsPendingReconciliation: ReadonlySet<string>,
): OrderList {
  return {
    ...list,
    orders: list.orders.map((order) =>
      shipmentsPendingReconciliation.has(order.orderNumber) &&
      order.canMarkShipped
        ? { ...order, canMarkShipped: false }
        : order,
    ),
  };
}

function readyOrderNumbers(list: OrderList): ReadonlySet<string> {
  return new Set(list.orders.map((order) => order.orderNumber));
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
  const readyOrderNumbersRef = useRef<ReadonlySet<string>>();
  const allOrderReconciliationsRef = useRef(new Set<string>());
  const automaticReconciliationRetryAtRef = useRef(0);
  const refreshAllOrdersRef = useRef<() => Promise<void>>();
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
    readyOrderNumbersRef.current = undefined;
    allOrderReconciliationsRef.current.clear();
    automaticReconciliationRetryAtRef.current = 0;
    listsRef.current = emptyLists;
    loadingRef.current = idle;
    setLists(emptyLists);
    setLoading(idle);
    setErrors({ all: "", "ready-to-ship": "" });
    setShipmentsPendingReconciliation(new Set());
  }, [connected]);

  const acknowledgeShipment = useCallback((orderNumber: string) => {
    shipmentReconciliationsRef.current.add(orderNumber);
    if (listsRef.current.all !== null) {
      allOrderReconciliationsRef.current.add(orderNumber);
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
      for (const orderNumber of shipmentReconciliationsRef.current) {
        const order = result.orders.find(
          (candidate) => candidate.orderNumber === orderNumber,
        );
        if (order?.canMarkShipped !== true) {
          shipmentReconciliationsRef.current.delete(orderNumber);
          allOrderReconciliationsRef.current.delete(orderNumber);
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
        for (const orderNumber of previousOrderNumbers) {
          if (!nextOrderNumbers.has(orderNumber)) {
            allOrderReconciliationsRef.current.add(orderNumber);
            changed = true;
          }
        }
        for (const orderNumber of nextOrderNumbers) {
          if (!previousOrderNumbers.has(orderNumber)) {
            allOrderReconciliationsRef.current.add(orderNumber);
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
        if (scope === "ready-to-ship") {
          acceptReadyOrderList(result);
        } else {
          acceptOrderList(scope, result);
          const readyOrderNumbers = readyOrderNumbersRef.current;
          for (const orderNumber of allOrderReconciliationsRef.current) {
            if (shipmentReconciliationsRef.current.has(orderNumber)) continue;
            const order = result.orders.find(
              (candidate) => candidate.orderNumber === orderNumber,
            );
            const expectedReady = readyOrderNumbers?.has(orderNumber) === true;
            if (
              (expectedReady && order?.canMarkShipped === true) ||
              (!expectedReady && order?.canMarkShipped !== true)
            ) {
              allOrderReconciliationsRef.current.delete(orderNumber);
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
      }
    },
    [acceptOrderList, acceptReadyOrderList, connected],
  );

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
    (orderNumber: string, scope: Scope) => {
      acknowledgeShipment(orderNumber);
      if (scope === "all" || listsRef.current.all !== null) {
        void load("all", true);
      }
      return Promise.resolve();
    },
    [acknowledgeShipment, load],
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
  }, [acceptReadyOrderList, connected]);

  const value = useMemo(
    () => ({
      lists,
      loading,
      errors,
      shipmentsPendingReconciliation,
      load,
      synchronizeReadyOrders,
      completeShipment,
    }),
    [
      completeShipment,
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
