import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

export interface ToastMessage {
  readonly id: number;
  readonly tone: "success" | "warning" | "danger" | "info";
  readonly text: string;
}

interface ToastContextValue {
  readonly messages: readonly ToastMessage[];
  readonly show: (text: string, tone?: ToastMessage["tone"]) => void;
  readonly dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  const [messages, setMessages] = useState<readonly ToastMessage[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);
  const show = useCallback(
    (text: string, tone: ToastMessage["tone"] = "info") => {
      const id = nextId.current;
      nextId.current += 1;
      setMessages((current) => [...current, { id, text, tone }]);
      window.setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const value = useMemo(
    () => ({ messages, show, dismiss }),
    [dismiss, messages, show],
  );
  return (
    <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) throw new Error("ToastProvider is missing.");
  return value;
}
