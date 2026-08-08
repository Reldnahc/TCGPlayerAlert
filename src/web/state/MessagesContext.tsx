import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "preact/hooks";
import { uiApi } from "../api.js";

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
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnreadCount = useCallback(
    async (force = false, signal?: AbortSignal) => {
      try {
        const result = await uiApi.messageCount(force, signal);
        if (signal?.aborted !== true) setUnreadCount(result.unreadCount);
      } catch {
        // The Messages page reports actionable failures. A badge read must not
        // disrupt unrelated operator workflows.
      }
    },
    [],
  );

  useEffect(() => {
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
  }, [refreshUnreadCount]);

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
