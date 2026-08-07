import { useState } from "preact/hooks";
import { uiApi } from "../../api.js";
import type { Settings } from "../../contracts.js";
import { settingsUpdate } from "../../state/SettingsContext.js";
import { useToast } from "../../state/ToastContext.js";
import { errorMessage } from "../../utils.js";
import { Button, Field, Notice, Toggle } from "../../components/ui.js";
import type { Output } from "./model.js";

export function PrintingSettings({
  settings,
  onChange,
}: {
  readonly settings: Settings;
  readonly onChange: (settings: Settings) => void;
}) {
  return (
    <div class="settings-editor settings-editor--single">
      {settings.discoveryIssue === undefined ? null : (
        <Notice tone="warning">{settings.discoveryIssue}</Notice>
      )}
      <div class="printer-grid">
        {settings.outputs.map((output) => (
          <PrinterEditor
            key={output.actionId}
            output={output}
            settings={settings}
            onChange={(updated) =>
              onChange({
                ...settings,
                outputs: settings.outputs.map((candidate) =>
                  candidate.actionId === updated.actionId ? updated : candidate,
                ),
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function PrinterEditor({
  output,
  settings,
  onChange,
}: {
  readonly output: Output;
  readonly settings: Settings;
  readonly onChange: (output: Output) => void;
}) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const address = output.type === "print-address-label";
  const names = [
    ...new Set([
      ...settings.installedPrinters.map((printer) => printer.name),
      output.printerName,
    ]),
  ];
  async function test() {
    setTesting(true);
    try {
      await uiApi.printTest(output.actionId, settingsUpdate(settings));
      toast.show(
        `Synthetic test ${address ? "label" : "sheet"} sent to ${output.printerName}.`,
        "success",
      );
    } catch (cause) {
      toast.show(
        errorMessage(cause, "The test print could not be sent."),
        "danger",
      );
    } finally {
      setTesting(false);
    }
  }
  return (
    <section
      class={`editor-section printer-editor${output.enabled ? "" : " is-disabled"}`}
    >
      <div class="editor-section__head">
        <div>
          <h2>{address ? "Address label" : "Packing slip"}</h2>
          <p>{output.adapterLabel}</p>
        </div>
        <Toggle
          label="Enable"
          checked={output.enabled}
          onChange={(checked) => onChange({ ...output, enabled: checked })}
        />
      </div>
      <div class="form-grid form-grid--2">
        <Field label="Printer">
          <select
            value={output.printerName}
            onChange={(event) =>
              onChange({ ...output, printerName: event.currentTarget.value })
            }
          >
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
                {settings.installedPrinters.find(
                  (printer) => printer.name === name,
                )?.isDefault === true
                  ? " (Windows default)"
                  : ""}
              </option>
            ))}
          </select>
        </Field>
        {output.type === "print-address-label" ? (
          <>
            <Field label="Width (mm)">
              <input
                type="number"
                min="20"
                max="300"
                step="0.1"
                value={output.widthMm}
                onInput={(event) =>
                  onChange({
                    ...output,
                    widthMm: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
            <Field label="Height (mm)">
              <input
                type="number"
                min="20"
                max="300"
                step="0.1"
                value={output.heightMm}
                onInput={(event) =>
                  onChange({
                    ...output,
                    heightMm: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
            <Field label="Font size">
              <input
                type="number"
                min="6"
                max="72"
                step="0.5"
                value={output.fontSize}
                onInput={(event) =>
                  onChange({
                    ...output,
                    fontSize: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
            <Field label="Margin (mm)">
              <input
                type="number"
                min="0"
                max="50"
                step="0.1"
                value={output.marginMm}
                onInput={(event) =>
                  onChange({
                    ...output,
                    marginMm: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
          </>
        ) : output.adapter === "windows-pdf" ? (
          <>
            <Field label="Page scaling">
              <select
                value={output.scale}
                onChange={(event) =>
                  onChange({
                    ...output,
                    scale: event.currentTarget.value as NonNullable<
                      typeof output.scale
                    >,
                  })
                }
              >
                <option value="shrink">Shrink oversized pages</option>
                <option value="fit">Fit printable area</option>
                <option value="actual-size">Actual size</option>
              </select>
            </Field>
            <Field label="Print quality">
              <input
                type="number"
                min="72"
                max="600"
                value={output.dpi}
                onInput={(event) =>
                  onChange({
                    ...output,
                    dpi: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
          </>
        ) : null}
      </div>
      <div class="editor-actions">
        <span class="muted">Sends a real print job using synthetic data.</span>
        <Button
          tone="secondary"
          icon="printer"
          busy={testing}
          onClick={() => void test()}
        >
          {address ? "Print test label" : "Print test sheet"}
        </Button>
      </div>
    </section>
  );
}
