import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "preact/hooks";
import { uiApi } from "../api.js";
import { useAuthentication } from "./AuthenticationContext.js";

interface MessagesContextValue {
  readonly unreadCount: number;
  readonly setUnreadCount: (count: number) => void;
  readonly refreshUnreadCount: (
    force?: boolean,
    signal?: AbortSignal,
  ) => Promise<void>;
}

const MessagesContext = createContext<MessagesContextValue | null>(null);

export function MessagesProvider({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  const { status: sellerConnection } = useAuthentication();
  const connected = sellerConnection?.state === "connected";
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnreadCount = useCallback(
    async (force = false, signal?: AbortSignal) => {
      if (!connected) return;
      try {
        const result = await uiApi.messageCount(force, signal);
        if (signal?.aborted !== true) setUnreadCount(result.unreadCount);
      } catch {
        // The Messages page reports actionable failures. A badge read must not
        // disrupt unrelated operator workflows.
      }
    },
    [connected],
  );

  useEffect(() => {
    if (!connected) {
      setUnreadCount(0);
      return;
    }
    const controller = new AbortController();
    void refreshUnreadCount(false, controller.signal);
    const timer = window.setInterval(
      () => void refreshUnreadCount(false),
      60_000,
    );
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [connected, refreshUnreadCount]);

  const value = useMemo(
    () => ({ unreadCount, setUnreadCount, refreshUnreadCount }),
    [refreshUnreadCount, unreadCount],
  );
  return (
    <MessagesContext.Provider value={value}>
      {children}
    </MessagesContext.Provider>
  );
}

export function useMessages(): MessagesContextValue {
  const value = useContext(MessagesContext);
  if (value === null) throw new Error("MessagesProvider is missing.");
  return value;
}
