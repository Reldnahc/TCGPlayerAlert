import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "preact/hooks";
import { uiApi } from "../api.js";
import type {
  SellerConnectionStatus,
  SellerPairingChallenge,
} from "../contracts.js";
import { errorMessage } from "../utils.js";

interface AuthenticationContextValue {
  readonly status: SellerConnectionStatus | null;
  readonly pairing: SellerPairingChallenge | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly refresh: () => Promise<void>;
  readonly beginPairing: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(
  null,
);

export function AuthenticationProvider({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  const [status, setStatus] = useState<SellerConnectionStatus | null>(null);
  const [pairing, setPairing] = useState<SellerPairingChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await uiApi.sellerConnection();
      setStatus(next);
      if (next.state === "connected") setPairing(null);
      setError("");
    } catch (cause) {
      setError(
        errorMessage(cause, "Seller connection status could not be loaded."),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const beginPairing = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setPairing(await uiApi.startSellerPairing());
    } catch (cause) {
      setError(
        errorMessage(cause, "A seller connection could not be started."),
      );
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await uiApi.disconnectSeller());
      setPairing(null);
    } catch (cause) {
      setError(
        errorMessage(cause, "The seller connection could not be disconnected."),
      );
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<AuthenticationContextValue>(
    () => ({
      status,
      pairing,
      loading,
      busy,
      error,
      refresh,
      beginPairing,
      disconnect,
    }),
    [beginPairing, busy, disconnect, error, loading, pairing, refresh, status],
  );
  return (
    <AuthenticationContext.Provider value={value}>
      {children}
    </AuthenticationContext.Provider>
  );
}

export function useAuthentication(): AuthenticationContextValue {
  const value = useContext(AuthenticationContext);
  if (value === null) throw new Error("AuthenticationProvider is missing.");
  return value;
}
