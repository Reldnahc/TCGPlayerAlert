import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "preact/hooks";
import { uiApi } from "../api.js";
import type { Settings, SettingsUpdate } from "../contracts.js";
import { cloneValue, errorMessage } from "../utils.js";

interface SettingsContextValue {
  readonly settings: Settings | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly error: string;
  readonly update: (updater: (settings: Settings) => Settings) => void;
  readonly save: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function settingsUpdate(settings: Settings): SettingsUpdate {
  return {
    revision: settings.revision,
    pollIntervalMinutes: settings.pollIntervalMinutes,
    confirmBeforeMarkingShipped: settings.confirmBeforeMarkingShipped,
    notifications: settings.notifications,
    shipmentScanner: settings.shipmentScanner,
    priceUpdateQueue: settings.priceUpdateQueue,
    inventoryAdditionQueue: settings.inventoryAdditionQueue,
    merchandiseProfiles: settings.merchandiseProfiles,
    defaultMerchandiseProfileId: settings.defaultMerchandiseProfileId,
    repricingProfiles: settings.repricingProfiles,
    defaultRepricingProfileId: settings.defaultRepricingProfileId,
    outputs: settings.outputs.map((output) => ({
      actionId: output.actionId,
      enabled: output.enabled,
      printerName: output.printerName,
      ...(output.type === "print-address-label"
        ? {
            widthMm: output.widthMm,
            heightMm: output.heightMm,
            marginMm: output.marginMm,
            fontSize: output.fontSize,
          }
        : output.adapter === "windows-pdf"
          ? {
              ...(output.dpi === undefined ? {} : { dpi: output.dpi }),
              ...(output.scale === undefined ? {} : { scale: output.scale }),
            }
          : {}),
    })),
  };
}

function fingerprint(settings: Settings | null): string {
  return settings === null ? "" : JSON.stringify(settingsUpdate(settings));
}

export function SettingsProvider({
  children,
}: {
  readonly children: ComponentChildren;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await uiApi.settings();
      setSettings(cloneValue(next));
      setSavedFingerprint(fingerprint(next));
    } catch (cause) {
      setError(errorMessage(cause, "Settings could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback((updater: (current: Settings) => Settings) => {
    setSettings((current) => (current === null ? null : updater(current)));
  }, []);

  const save = useCallback(async () => {
    if (settings === null || saving) return;
    setSaving(true);
    setError("");
    try {
      const next = await uiApi.saveSettings(settingsUpdate(settings));
      setSettings(cloneValue(next));
      setSavedFingerprint(fingerprint(next));
    } catch (cause) {
      setError(errorMessage(cause, "Settings could not be saved."));
      throw cause;
    } finally {
      setSaving(false);
    }
  }, [saving, settings]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      loading,
      saving,
      dirty: settings !== null && fingerprint(settings) !== savedFingerprint,
      error,
      update,
      save,
      reload,
    }),
    [error, loading, reload, save, savedFingerprint, saving, settings, update],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("SettingsProvider is missing.");
  return value;
}
