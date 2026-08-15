import { useState } from "preact/hooks";
import { PageHeader, Field, Toggle } from "../components/ui.js";
import { useSettings } from "../state/SettingsContext.js";
import { MerchandiseProfiles } from "./settings/MerchandiseProfiles.js";
import { PricingProfiles } from "./settings/PricingProfiles.js";
import { PrintingSettings } from "./settings/PrintingSettings.js";
import { SellerConnectionCard } from "../components/SellerConnectionCard.js";
import { DiscordNotifications } from "./settings/DiscordNotifications.js";
import { PullListSettings } from "./settings/PullListSettings.js";

type SettingsSection =
  | "general"
  | "pull-list"
  | "pricing"
  | "merchandise"
  | "printing"
  | "notifications"
  | "scanning"
  | "processing";
const sections: readonly {
  readonly id: SettingsSection;
  readonly label: string;
}[] = [
  { id: "general", label: "General" },
  { id: "pull-list", label: "Pull list" },
  { id: "pricing", label: "Pricing" },
  { id: "merchandise", label: "Merchandise" },
  { id: "printing", label: "Printing" },
  { id: "notifications", label: "Notifications" },
  { id: "scanning", label: "Scanning" },
  { id: "processing", label: "Processing" },
];

export function SettingsPage() {
  const { settings, update } = useSettings();
  const [section, setSection] = useState<SettingsSection>("general");
  if (settings === null) return null;
  return (
    <main class="page">
      <PageHeader
        title="Settings"
        description="Configure local workflows, profiles, and output devices"
      />
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings sections">
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div class="settings-content">
          {section === "general" ? (
            <>
              <SellerConnectionCard />
              <section class="editor-section settings-editor settings-editor--single">
                <div class="editor-section__head">
                  <div>
                    <h2>General</h2>
                    <p>Application-wide order behavior.</p>
                  </div>
                </div>
                <div class="form-grid form-grid--2">
                  <Field label="Check for orders every" hint="Minutes">
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      value={settings.pollIntervalMinutes}
                      onInput={(event) =>
                        update((current) => ({
                          ...current,
                          pollIntervalMinutes: Number(
                            event.currentTarget.value,
                          ),
                        }))
                      }
                    />
                  </Field>
                  <Toggle
                    label="Confirm before marking shipped"
                    description="Require approval before changing an order to shipped"
                    checked={settings.confirmBeforeMarkingShipped}
                    onChange={(checked) =>
                      update((current) => ({
                        ...current,
                        confirmBeforeMarkingShipped: checked,
                      }))
                    }
                  />
                </div>
              </section>
            </>
          ) : section === "pull-list" ? (
            <PullListSettings
              settings={settings}
              onChange={(next) => update(() => next)}
            />
          ) : section === "pricing" ? (
            <PricingProfiles
              settings={settings}
              onChange={(next) => update(() => next)}
            />
          ) : section === "merchandise" ? (
            <MerchandiseProfiles
              settings={settings}
              onChange={(next) => update(() => next)}
            />
          ) : section === "printing" ? (
            <PrintingSettings
              settings={settings}
              onChange={(next) => update(() => next)}
            />
          ) : section === "notifications" ? (
            <DiscordNotifications
              settings={settings}
              onChange={(next) => update(() => next)}
            />
          ) : section === "scanning" ? (
            <section class="editor-section settings-editor settings-editor--single">
              <div class="editor-section__head">
                <div>
                  <h2>Shipment scanner</h2>
                  <p>Control AprilTag labels, shipment mutations, and cues.</p>
                </div>
              </div>
              <div class="processing-grid">
                <Toggle
                  label="Add shipment tags to order labels"
                  description="Enables the production Scanner workspace"
                  checked={settings.shipmentScanner.enabled}
                  onChange={(checked) =>
                    update((current) => ({
                      ...current,
                      shipmentScanner: {
                        ...current.shipmentScanner,
                        enabled: checked,
                        automaticallyMarkShipped: checked
                          ? current.shipmentScanner.automaticallyMarkShipped
                          : false,
                        camera: {
                          ...current.shipmentScanner.camera,
                          enabled: checked
                            ? current.shipmentScanner.camera.enabled
                            : false,
                        },
                      },
                    }))
                  }
                />
                <Toggle
                  label="Automatically mark exact matches shipped"
                  description="Changes TCGplayer after five confirmed reads and an authoritative order refresh"
                  checked={settings.shipmentScanner.automaticallyMarkShipped}
                  disabled={!settings.shipmentScanner.enabled}
                  onChange={(checked) =>
                    update((current) => ({
                      ...current,
                      shipmentScanner: {
                        ...current.shipmentScanner,
                        automaticallyMarkShipped: checked,
                      },
                    }))
                  }
                />
                <Toggle
                  label="Run the basket camera in the background"
                  description="Keeps scanning while this browser window is closed, as long as the app is running"
                  checked={settings.shipmentScanner.camera.enabled}
                  disabled={!settings.shipmentScanner.enabled}
                  onChange={(checked) =>
                    update((current) => ({
                      ...current,
                      shipmentScanner: {
                        ...current.shipmentScanner,
                        camera: {
                          ...current.shipmentScanner.camera,
                          enabled: checked,
                        },
                      },
                    }))
                  }
                />
                <Field
                  label="Basket camera"
                  hint={
                    settings.cameraDiscoveryIssue ??
                    "The system default is used when no camera is selected"
                  }
                >
                  <select
                    value={settings.shipmentScanner.camera.deviceId}
                    disabled={!settings.shipmentScanner.enabled}
                    onChange={(event) =>
                      update((current) => ({
                        ...current,
                        shipmentScanner: {
                          ...current.shipmentScanner,
                          camera: {
                            ...current.shipmentScanner.camera,
                            deviceId: event.currentTarget.value,
                          },
                        },
                      }))
                    }
                  >
                    <option value="">System default</option>
                    {settings.installedCameras.map((camera) => (
                      <option key={camera.id} value={camera.id}>
                        {camera.label}
                        {camera.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                    {settings.shipmentScanner.camera.deviceId === "" ||
                    settings.installedCameras.some(
                      (camera) =>
                        camera.id === settings.shipmentScanner.camera.deviceId,
                    ) ? null : (
                      <option value={settings.shipmentScanner.camera.deviceId}>
                        {settings.shipmentScanner.camera.deviceId} (unavailable)
                      </option>
                    )}
                  </select>
                </Field>
                <Toggle
                  label="Play scan sounds"
                  description="Play a host-system cue after a background scan"
                  checked={settings.shipmentScanner.soundEnabled}
                  onChange={(checked) =>
                    update((current) => ({
                      ...current,
                      shipmentScanner: {
                        ...current.shipmentScanner,
                        soundEnabled: checked,
                      },
                    }))
                  }
                />
              </div>
            </section>
          ) : (
            <section class="editor-section settings-editor settings-editor--single">
              <div class="editor-section__head">
                <div>
                  <h2>Processing</h2>
                  <p>Control durable queue workers and cooldowns.</p>
                </div>
              </div>
              <div class="processing-grid">
                <Toggle
                  label="Process inventory changes"
                  description="Adds and removals"
                  checked={settings.inventoryAdditionQueue.enabled}
                  onChange={(checked) =>
                    update((current) => ({
                      ...current,
                      inventoryAdditionQueue: {
                        ...current.inventoryAdditionQueue,
                        enabled: checked,
                      },
                    }))
                  }
                />
                <Field
                  label="Inventory cooldown"
                  hint="Seconds after accepted mutation"
                >
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    value={settings.inventoryAdditionQueue.delaySeconds}
                    onInput={(event) =>
                      update((current) => ({
                        ...current,
                        inventoryAdditionQueue: {
                          ...current.inventoryAdditionQueue,
                          delaySeconds: Number(event.currentTarget.value),
                        },
                      }))
                    }
                  />
                </Field>
                <Toggle
                  label="Process queued prices"
                  description="One update remains in flight at a time"
                  checked={settings.priceUpdateQueue.enabled}
                  onChange={(checked) =>
                    update((current) => ({
                      ...current,
                      priceUpdateQueue: {
                        ...current.priceUpdateQueue,
                        enabled: checked,
                      },
                    }))
                  }
                />
                <Field
                  label="Price cooldown"
                  hint="Seconds after accepted update"
                >
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    value={settings.priceUpdateQueue.delaySeconds}
                    onInput={(event) =>
                      update((current) => ({
                        ...current,
                        priceUpdateQueue: {
                          ...current.priceUpdateQueue,
                          delaySeconds: Number(event.currentTarget.value),
                        },
                      }))
                    }
                  />
                </Field>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
