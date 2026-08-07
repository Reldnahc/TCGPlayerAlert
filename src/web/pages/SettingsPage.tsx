import { useState } from "preact/hooks";
import { PageHeader, Field, Toggle } from "../components/ui.js";
import { useSettings } from "../state/SettingsContext.js";
import { MerchandiseProfiles } from "./settings/MerchandiseProfiles.js";
import { PricingProfiles } from "./settings/PricingProfiles.js";
import { PrintingSettings } from "./settings/PrintingSettings.js";

type SettingsSection =
  "general" | "pricing" | "merchandise" | "printing" | "processing";
const sections: readonly {
  readonly id: SettingsSection;
  readonly label: string;
}[] = [
  { id: "general", label: "General" },
  { id: "pricing", label: "Pricing" },
  { id: "merchandise", label: "Merchandise" },
  { id: "printing", label: "Printing" },
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
            <section class="editor-section settings-editor settings-editor--single">
              <div class="editor-section__head">
                <div>
                  <h2>General</h2>
                  <p>Application-wide polling behavior.</p>
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
                        pollIntervalMinutes: Number(event.currentTarget.value),
                      }))
                    }
                  />
                </Field>
              </div>
            </section>
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
