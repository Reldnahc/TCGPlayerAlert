import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { AUTHENTICATION_REQUIRED_EVENT, uiApi } from "../api.js";
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
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current !== null) return refreshInFlight.current;
    const operation = (async () => {
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
        refreshInFlight.current = null;
      }
    })();
    refreshInFlight.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const onAuthenticationRequired = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener(
      AUTHENTICATION_REQUIRED_EVENT,
      onAuthenticationRequired,
    );
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(
        AUTHENTICATION_REQUIRED_EVENT,
        onAuthenticationRequired,
      );
    };
  }, [refresh]);

  useEffect(() => {
    if (pairing === null) return;
    const interval = window.setInterval(() => void refresh(), 2_000);
    const expiresIn = Math.max(0, Date.parse(pairing.expiresAt) - Date.now());
    const expiration = window.setTimeout(
      () =>
        setPairing((current) =>
          current?.expiresAt === pairing.expiresAt ? null : current,
        ),
      expiresIn,
    );
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(expiration);
    };
  }, [pairing, refresh]);

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
