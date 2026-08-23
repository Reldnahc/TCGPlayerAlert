import { useMemo, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import {
  addressLines,
  parseAddressList,
  validateAddressLabels,
} from "../address-list.js";
import { Button, Field, Notice, PageHeader } from "../components/ui.js";
import { useSettings } from "../state/SettingsContext.js";
import { useToast } from "../state/ToastContext.js";
import { errorMessage } from "../utils.js";

type LabelStatus = "ready" | "printing" | "printed" | "failed";

interface LabelDraft {
  readonly id: number;
  readonly text: string;
  readonly status: LabelStatus;
}

export function BulkLabelsPage() {
  const { settings } = useSettings();
  const toast = useToast();
  const [source, setSource] = useState("");
  const [drafts, setDrafts] = useState<readonly LabelDraft[]>([]);
  const [batchIssues, setBatchIssues] = useState<readonly string[]>([]);
  const [printing, setPrinting] = useState(false);
  const labels = useMemo(
    () => drafts.map((draft) => ({ lines: addressLines(draft.text) })),
    [drafts],
  );
  const issues = useMemo(
    () =>
      drafts.length === 0
        ? batchIssues
        : [...new Set([...batchIssues, ...validateAddressLabels(labels)])],
    [batchIssues, drafts.length, labels],
  );
  const addressOutput = settings?.outputs.find(
    (output) => output.type === "print-address-label",
  );
  const readyCount = drafts.filter((draft) => draft.status === "ready").length;
  const printedCount = drafts.filter(
    (draft) => draft.status === "printed",
  ).length;

  function formatAddresses() {
    const result = parseAddressList(source);
    setDrafts(
      result.labels.map((label, index) => ({
        id: index + 1,
        text: label.lines.join("\n"),
        status: "ready",
      })),
    );
    setBatchIssues(
      result.issues.filter((issue) => issue.includes("at most 100 labels")),
    );
  }

  function updateDraft(id: number, text: string) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.id === id ? { ...draft, text, status: "ready" } : draft,
      ),
    );
  }

  function removeDraft(id: number) {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
    setBatchIssues([]);
  }

  function addDraft() {
    const id = Math.max(0, ...drafts.map((draft) => draft.id)) + 1;
    setDrafts((current) => [...current, { id, text: "", status: "ready" }]);
    setBatchIssues([]);
  }

  async function printReadyLabels() {
    if (printing || issues.length > 0 || addressOutput === undefined) return;
    const candidates = drafts.filter((draft) => draft.status === "ready");
    if (candidates.length === 0) return;
    setPrinting(true);
    let sent = 0;
    try {
      for (const draft of candidates) {
        setDrafts((current) =>
          current.map((candidate) =>
            candidate.id === draft.id
              ? { ...candidate, status: "printing" }
              : candidate,
          ),
        );
        try {
          await uiApi.printAddressLabel(addressLines(draft.text).join("\n"));
          sent += 1;
          setDrafts((current) =>
            current.map((candidate) =>
              candidate.id === draft.id
                ? { ...candidate, status: "printed" }
                : candidate,
            ),
          );
        } catch (cause) {
          setDrafts((current) =>
            current.map((candidate) =>
              candidate.id === draft.id
                ? { ...candidate, status: "failed" }
                : candidate,
            ),
          );
          toast.show(
            `Printing stopped after ${String(sent)} of ${String(candidates.length)} labels. ${errorMessage(cause, "Review the printer before continuing.")}`,
            "danger",
          );
          return;
        }
      }
      toast.show(
        `${String(sent)} address ${sent === 1 ? "label" : "labels"} sent to the printer.`,
        "success",
      );
    } finally {
      setPrinting(false);
    }
  }

  return (
    <main class="page bulk-labels-page">
      <PageHeader
        title="Bulk labels"
        description="Format and print addresses from any selling platform"
        actions={
          <Button
            tone="primary"
            icon="printer"
            busy={printing}
            disabled={
              addressOutput === undefined ||
              issues.length > 0 ||
              readyCount === 0
            }
            onClick={() => void printReadyLabels()}
          >
            {printedCount > 0
              ? `Print remaining ${String(readyCount)}`
              : `Print ${String(readyCount)} ${readyCount === 1 ? "label" : "labels"}`}
          </Button>
        }
      />
      <div class="page-body">
        <div class="bulk-labels-layout">
          <section class="surface bulk-labels-source">
            <div class="surface__header">
              <div>
                <h2>1. Paste addresses</h2>
                <p>
                  Separate address blocks with a blank line, paste one complete
                  address per line, or paste CSV/tab-separated columns.
                </p>
              </div>
            </div>
            <div class="surface__body bulk-labels-source__body">
              <Field
                label="Address list"
                hint="Pasted data stays in this browser tab and is not saved"
              >
                <textarea
                  rows={12}
                  maxLength={65_536}
                  autoComplete="off"
                  spellcheck={false}
                  placeholder={
                    "Recipient name\nStreet address\nCity, State ZIP\n\nNext recipient\nStreet address\nCity, State ZIP"
                  }
                  value={source}
                  disabled={printing}
                  onInput={(event) => setSource(event.currentTarget.value)}
                />
              </Field>
              <div class="bulk-labels-source__actions">
                <Button
                  tone="primary"
                  disabled={source.trim() === "" || printing}
                  onClick={formatAddresses}
                >
                  Format and preview
                </Button>
                <Button
                  tone="quiet"
                  disabled={(source === "" && drafts.length === 0) || printing}
                  onClick={() => {
                    setSource("");
                    setDrafts([]);
                    setBatchIssues([]);
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
          </section>

          <section class="surface bulk-labels-preview">
            <div class="surface__header">
              <div>
                <h2>2. Review label lines</h2>
                <p>
                  {drafts.length === 0
                    ? "Formatted labels will appear here."
                    : `${String(drafts.length)} ${drafts.length === 1 ? "label" : "labels"} · ${String(printedCount)} printed`}
                </p>
              </div>
              <Button tone="secondary" disabled={printing} onClick={addDraft}>
                Add label
              </Button>
            </div>
            {addressOutput === undefined ? (
              <div class="surface__body">
                <Notice tone="warning">
                  Configure an address-label printer in Settings before
                  printing.
                </Notice>
              </div>
            ) : (
              <div class="bulk-labels-printer">
                Printing with <strong>{addressOutput.printerName}</strong> using
                its saved label layout.
              </div>
            )}
            {issues.length === 0 ? null : (
              <div class="surface__body bulk-labels-issues">
                <Notice tone="danger">{issues.join(" ")}</Notice>
              </div>
            )}
            <div class="bulk-labels-list">
              {drafts.map((draft, index) => (
                <article
                  key={draft.id}
                  class={`label-preview label-preview--${draft.status}`}
                >
                  <div class="label-preview__header">
                    <strong>Label {String(index + 1)}</strong>
                    <span>{labelStatus(draft.status)}</span>
                  </div>
                  <textarea
                    rows={Math.max(4, addressLines(draft.text).length)}
                    maxLength={1_024}
                    aria-label={`Label ${String(index + 1)} lines`}
                    value={draft.text}
                    disabled={printing}
                    onInput={(event) =>
                      updateDraft(draft.id, event.currentTarget.value)
                    }
                  />
                  <div class="label-preview__actions">
                    {draft.status === "failed" ? (
                      <Button
                        tone="secondary"
                        disabled={printing}
                        onClick={() => updateDraft(draft.id, draft.text)}
                      >
                        Mark for retry
                      </Button>
                    ) : null}
                    <Button
                      tone="quiet"
                      disabled={printing}
                      onClick={() => removeDraft(draft.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function labelStatus(status: LabelStatus): string {
  if (status === "printing") return "Printing…";
  if (status === "printed") return "Printed";
  if (status === "failed") return "Needs review";
  return "Ready";
}
