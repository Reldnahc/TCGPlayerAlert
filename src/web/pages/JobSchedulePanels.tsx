import { Fragment } from "preact";
import { useMemo, useState } from "preact/hooks";
import type {
  JobRun,
  JobSchedule,
  JobScheduleInput,
  Settings,
} from "../contracts.js";
import { uiApi } from "../api.js";
import {
  Button,
  EmptyState,
  Field,
  Notice,
  StatusBadge,
} from "../components/ui.js";
import { compactDate, errorMessage, money } from "../utils.js";

interface RepricingDraft {
  readonly name: string;
  readonly profileId: string;
  readonly mode: "review" | "automatic";
  readonly timingKind: "once" | "interval" | "daily" | "weekly";
  readonly runAt: string;
  readonly intervalHours: string;
  readonly intervalAnchor: string;
  readonly timeOfDay: string;
  readonly weekdays: readonly number[];
  readonly timeZone: string;
  readonly maximumUpdates: string;
  readonly maximumDecreasePercent: string;
  readonly maximumDecreaseAmount: string;
  readonly maximumIncreasePercent: string;
  readonly maximumBlockedPercent: string;
}

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;

export function JobSchedulesPanel({
  schedules,
  settings,
  runnerRunning,
  onChanged,
}: {
  readonly schedules: readonly JobSchedule[];
  readonly settings: Settings;
  readonly runnerRunning: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => defaultDraft(settings));
  const [editingRepricingId, setEditingRepricingId] = useState<string | null>(
    null,
  );
  const [editingListingId, setEditingListingId] = useState<string | null>(null);
  const [listingEdits, setListingEdits] = useState<
    Readonly<Record<string, string>>
  >({});
  const [listingRunAt, setListingRunAt] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  async function mutate(label: string, operation: () => Promise<unknown>) {
    if (busy !== "") return;
    setBusy(label);
    setError("");
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      setError(errorMessage(cause, "The schedule could not be updated."));
    } finally {
      setBusy("");
    }
  }

  async function saveRepricing() {
    let input: JobScheduleInput;
    try {
      const parsed = draftInput(draft);
      input = {
        ...parsed,
        enabled:
          editingRepricingId === null
            ? true
            : (schedules.find((schedule) => schedule.id === editingRepricingId)
                ?.enabled ?? true),
      };
    } catch (cause) {
      setError(errorMessage(cause, "The schedule is invalid."));
      return;
    }
    await mutate("save", async () => {
      if (editingRepricingId === null) await uiApi.createJobSchedule(input);
      else await uiApi.updateJobSchedule(editingRepricingId, input);
      setEditingRepricingId(null);
      setDraft(defaultDraft(settings));
    });
  }

  function editSchedule(schedule: JobSchedule) {
    setDeleteId(null);
    if (schedule.payload.type === "reprice-inventory") {
      setEditingRepricingId(schedule.id);
      setEditingListingId(null);
      setDraft(draftFromSchedule(schedule));
      setListingEdits({});
      return;
    }
    setEditingRepricingId(null);
    setEditingListingId(schedule.id);
    setListingRunAt(
      schedule.timing.kind === "once"
        ? localDateTimeValue(new Date(schedule.timing.runAt))
        : "",
    );
    setListingEdits(
      Object.fromEntries(
        schedule.payload.items.map((item) => [
          String(item.productConditionId),
          String(item.quantity),
        ]),
      ),
    );
  }

  async function saveListing(schedule: JobSchedule) {
    if (
      schedule.payload.type !== "list-inventory" ||
      schedule.timing.kind !== "once"
    ) {
      return;
    }
    const payload = schedule.payload;
    const runAt = new Date(listingRunAt);
    const items = payload.items.map((item) => ({
      ...item,
      quantity: Number(listingEdits[String(item.productConditionId)]),
    }));
    await mutate(schedule.id, async () => {
      await uiApi.updateJobSchedule(schedule.id, {
        name: `List ${String(items.reduce((total, item) => total + item.quantity, 0))} cards`,
        enabled: schedule.enabled,
        timing: { kind: "once", runAt: runAt.toISOString() },
        payload: { ...payload, items },
      });
      setEditingListingId(null);
      setListingEdits({});
    });
  }

  return (
    <div class="job-schedule-layout">
      {!runnerRunning ? (
        <Notice tone="warning">
          Schedules can be edited here, but they execute only while the service
          is running.
        </Notice>
      ) : null}
      {error === "" ? null : <Notice tone="danger">{error}</Notice>}
      <section class="surface job-schedule-editor">
        <header class="surface__header">
          <div>
            <strong>
              {editingRepricingId === null
                ? "New repricing schedule"
                : "Edit repricing schedule"}
            </strong>
            <p>Review first or explicitly enable guarded automatic updates.</p>
          </div>
        </header>
        <div class="job-schedule-form">
          <Field label="Name">
            <input
              value={draft.name}
              onInput={(event) =>
                setDraft({ ...draft, name: event.currentTarget.value })
              }
            />
          </Field>
          <Field label="Pricing profile">
            <select
              value={draft.profileId}
              onChange={(event) =>
                setDraft({ ...draft, profileId: event.currentTarget.value })
              }
            >
              {settings.repricingProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mode">
            <select
              value={draft.mode}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  mode: event.currentTarget.value as "review" | "automatic",
                })
              }
            >
              <option value="review">Review only</option>
              <option value="automatic">Automatic</option>
            </select>
          </Field>
          <Field label="Timing">
            <select
              value={draft.timingKind}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  timingKind: event.currentTarget
                    .value as RepricingDraft["timingKind"],
                })
              }
            >
              <option value="once">Once</option>
              <option value="interval">Every N hours</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
          {draft.timingKind === "once" ? (
            <Field label="Run at">
              <input
                type="datetime-local"
                value={draft.runAt}
                onInput={(event) =>
                  setDraft({ ...draft, runAt: event.currentTarget.value })
                }
              />
            </Field>
          ) : draft.timingKind === "interval" ? (
            <Field label="Every hours">
              <input
                type="number"
                min="1"
                max="720"
                value={draft.intervalHours}
                onInput={(event) =>
                  setDraft({
                    ...draft,
                    intervalHours: event.currentTarget.value,
                  })
                }
              />
            </Field>
          ) : (
            <Field label="Local time">
              <input
                type="time"
                value={draft.timeOfDay}
                onInput={(event) =>
                  setDraft({ ...draft, timeOfDay: event.currentTarget.value })
                }
              />
            </Field>
          )}
          {draft.timingKind === "weekly" ? (
            <fieldset class="weekday-picker">
              <legend>Days</legend>
              {WEEKDAYS.map((weekday) => (
                <label key={weekday.value}>
                  <input
                    type="checkbox"
                    checked={draft.weekdays.includes(weekday.value)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        weekdays: event.currentTarget.checked
                          ? [...draft.weekdays, weekday.value]
                          : draft.weekdays.filter(
                              (value) => value !== weekday.value,
                            ),
                      })
                    }
                  />
                  {weekday.label}
                </label>
              ))}
            </fieldset>
          ) : null}
          {draft.timingKind === "daily" || draft.timingKind === "weekly" ? (
            <Field label="Timezone">
              <input
                value={draft.timeZone}
                onInput={(event) =>
                  setDraft({ ...draft, timeZone: event.currentTarget.value })
                }
              />
            </Field>
          ) : null}
        </div>
        {draft.mode === "automatic" ? (
          <div class="job-limit-grid">
            <Field label="Max updates">
              <input
                type="number"
                min="1"
                value={draft.maximumUpdates}
                onInput={(event) =>
                  setDraft({
                    ...draft,
                    maximumUpdates: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <Field label="Max decrease %">
              <input
                type="number"
                min="0"
                max="100"
                value={draft.maximumDecreasePercent}
                onInput={(event) =>
                  setDraft({
                    ...draft,
                    maximumDecreasePercent: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <Field label="Max decrease $">
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={draft.maximumDecreaseAmount}
                onInput={(event) =>
                  setDraft({
                    ...draft,
                    maximumDecreaseAmount: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <Field label="Max increase %">
              <input
                type="number"
                min="0"
                value={draft.maximumIncreasePercent}
                onInput={(event) =>
                  setDraft({
                    ...draft,
                    maximumIncreasePercent: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <Field label="Stop if blocked %">
              <input
                type="number"
                min="0"
                max="100"
                value={draft.maximumBlockedPercent}
                onInput={(event) =>
                  setDraft({
                    ...draft,
                    maximumBlockedPercent: event.currentTarget.value,
                  })
                }
              />
            </Field>
          </div>
        ) : null}
        <footer class="surface__footer job-editor-actions">
          {editingRepricingId === null ? null : (
            <Button
              tone="quiet"
              onClick={() => {
                setEditingRepricingId(null);
                setDraft(defaultDraft(settings));
              }}
            >
              Cancel edit
            </Button>
          )}
          <Button
            tone="primary"
            busy={busy === "save"}
            onClick={() => void saveRepricing()}
          >
            {editingRepricingId === null ? "Create schedule" : "Save schedule"}
          </Button>
        </footer>
      </section>
      <section class="surface job-schedule-list">
        <header class="surface__header">
          <div>
            <strong>Schedules</strong>
            <p>{schedules.length} configured</p>
          </div>
        </header>
        {schedules.length === 0 ? (
          <EmptyState title="No schedules" />
        ) : (
          <div class="job-schedule-rows">
            {schedules.map((schedule) => {
              const editing = editingListingId === schedule.id;
              return (
                <article key={schedule.id} class="job-schedule-row">
                  <div class="job-schedule-row__main">
                    <span
                      class={`schedule-state${schedule.enabled ? " is-enabled" : ""}`}
                    >
                      <i /> {schedule.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <strong>{schedule.name}</strong>
                    <small>{scheduleDescription(schedule, settings)}</small>
                  </div>
                  <div class="job-schedule-row__time">
                    <span>Next</span>
                    <strong>
                      {schedule.nextRunAt === undefined
                        ? "Not scheduled"
                        : compactDate(schedule.nextRunAt)}
                    </strong>
                  </div>
                  <div class="cell-actions">
                    <Button
                      tone="quiet"
                      busy={busy === `${schedule.id}:run`}
                      onClick={() =>
                        void mutate(`${schedule.id}:run`, () =>
                          uiApi.runJobSchedule(schedule.id),
                        )
                      }
                    >
                      Run now
                    </Button>
                    <Button tone="quiet" onClick={() => editSchedule(schedule)}>
                      Edit
                    </Button>
                    <Button
                      tone="quiet"
                      busy={busy === `${schedule.id}:toggle`}
                      onClick={() =>
                        void mutate(`${schedule.id}:toggle`, () =>
                          uiApi.updateJobSchedule(schedule.id, {
                            name: schedule.name,
                            enabled: !schedule.enabled,
                            timing: schedule.timing,
                            payload: schedule.payload,
                          }),
                        )
                      }
                    >
                      {schedule.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      tone={deleteId === schedule.id ? "danger" : "quiet"}
                      busy={busy === `${schedule.id}:delete`}
                      onClick={() => {
                        if (deleteId !== schedule.id) {
                          setDeleteId(schedule.id);
                          return;
                        }
                        void mutate(`${schedule.id}:delete`, () =>
                          uiApi.deleteJobSchedule(schedule.id),
                        );
                      }}
                    >
                      {deleteId === schedule.id ? "Confirm delete" : "Delete"}
                    </Button>
                  </div>
                  {editing && schedule.payload.type === "list-inventory" ? (
                    <div class="listing-batch-editor">
                      <Field label="Release at">
                        <input
                          type="datetime-local"
                          value={listingRunAt}
                          onInput={(event) =>
                            setListingRunAt(event.currentTarget.value)
                          }
                        />
                      </Field>
                      <div class="listing-batch-items">
                        {schedule.payload.items.map((item) => (
                          <label key={item.productConditionId}>
                            <span>{item.productName}</span>
                            <input
                              aria-label={`Quantity for ${item.productName}`}
                              type="number"
                              min="1"
                              value={
                                listingEdits[String(item.productConditionId)] ??
                                String(item.quantity)
                              }
                              onInput={(event) =>
                                setListingEdits({
                                  ...listingEdits,
                                  [String(item.productConditionId)]:
                                    event.currentTarget.value,
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <div class="job-editor-actions">
                        <Button
                          tone="quiet"
                          onClick={() => {
                            setEditingListingId(null);
                            setListingEdits({});
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          tone="primary"
                          busy={busy === schedule.id}
                          onClick={() => void saveListing(schedule)}
                        >
                          Save batch
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export function JobRunsPanel({
  runs,
  onChanged,
}: {
  readonly runs: readonly JobRun[];
  readonly onChanged: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(runs.length / 20));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRuns = useMemo(
    () => runs.slice(currentPage * 20, (currentPage + 1) * 20),
    [currentPage, runs],
  );

  async function cancel(run: JobRun) {
    setBusy(run.id);
    setError("");
    try {
      await uiApi.cancelJobRun(run.id);
      await onChanged();
    } catch (cause) {
      setError(errorMessage(cause, "The run could not be canceled."));
    } finally {
      setBusy("");
    }
  }

  return (
    <div class="job-runs-layout">
      {error === "" ? null : <Notice tone="danger">{error}</Notice>}
      {pageRuns.length === 0 ? (
        <EmptyState title="No internal runs" />
      ) : (
        <>
          <div class="data-region jobs-table-region">
            <table class="data-table jobs-table job-runs-table">
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Scheduled</th>
                  <th>Result</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRuns.map((run) => (
                  <Fragment key={run.id}>
                    <tr>
                      <td>
                        <span class="cell-stack">
                          <strong>{run.scheduleName}</strong>
                          <small>{run.trigger}</small>
                        </span>
                      </td>
                      <td>
                        {run.payload.type === "reprice-inventory"
                          ? "Repricing"
                          : "Listing"}
                      </td>
                      <td>
                        <StatusBadge status={run.status} />
                      </td>
                      <td>{compactDate(run.scheduledFor)}</td>
                      <td>{runSummary(run)}</td>
                      <td class="cell-actions">
                        {run.status === "queued" ? (
                          <Button
                            tone="quiet"
                            busy={busy === run.id}
                            onClick={() => void cancel(run)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                        {run.report === undefined ? null : (
                          <Button
                            tone="quiet"
                            onClick={() =>
                              setExpanded(expanded === run.id ? null : run.id)
                            }
                          >
                            {expanded === run.id ? "Hide" : "Details"}
                          </Button>
                        )}
                        {run.payload.type === "reprice-inventory" &&
                        run.payload.mode === "review" ? (
                          <Button
                            tone="secondary"
                            onClick={() => {
                              window.localStorage.setItem(
                                "tcgplayer-alert.repricing-profile",
                                run.payload.type === "reprice-inventory"
                                  ? run.payload.pricingProfileId
                                  : "",
                              );
                              window.location.hash = "inventory";
                            }}
                          >
                            Review in Inventory
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                    {expanded === run.id && run.report !== undefined ? (
                      <tr class="job-run-details-row">
                        <td colSpan={6}>
                          <div class="job-run-details">
                            {run.report.items.map((item) => (
                              <div key={item.key}>
                                <span>
                                  <strong>{item.productName}</strong> ·{" "}
                                  {item.outcome}
                                </span>
                                <span>
                                  {item.currentPrice === undefined
                                    ? ""
                                    : money(item.currentPrice)}
                                  {item.proposedPrice === undefined
                                    ? ""
                                    : ` → ${money(item.proposedPrice)}`}
                                  {item.reason === undefined
                                    ? ""
                                    : ` · ${item.reason}`}
                                </span>
                              </div>
                            ))}
                            {run.report.truncatedItems > 0 ? (
                              <small>
                                {run.report.truncatedItems} additional rows
                                omitted from retained history.
                              </small>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount <= 1 ? null : (
            <div class="pagination">
              <Button
                tone="quiet"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <span>
                Page {currentPage + 1} of {pageCount} · {runs.length} runs
              </span>
              <Button
                tone="quiet"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function defaultDraft(settings: Settings): RepricingDraft {
  const now = new Date();
  now.setHours(now.getHours() + 1, 0, 0, 0);
  return {
    name: "Scheduled repricing",
    profileId: settings.defaultRepricingProfileId,
    mode: "review",
    timingKind: "daily",
    runAt: localDateTimeValue(now),
    intervalHours: "24",
    intervalAnchor: now.toISOString(),
    timeOfDay: "03:00",
    weekdays: [1],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    maximumUpdates: "200",
    maximumDecreasePercent: "20",
    maximumDecreaseAmount: "20.00",
    maximumIncreasePercent: "100",
    maximumBlockedPercent: "20",
  };
}

function draftFromSchedule(schedule: JobSchedule): RepricingDraft {
  if (schedule.payload.type !== "reprice-inventory") {
    throw new Error("The selected schedule is not a repricing schedule.");
  }
  const timing = schedule.timing;
  return {
    name: schedule.name,
    profileId: schedule.payload.pricingProfileId,
    mode: schedule.payload.mode,
    timingKind: timing.kind,
    runAt:
      timing.kind === "once"
        ? localDateTimeValue(new Date(timing.runAt))
        : localDateTimeValue(new Date()),
    intervalHours:
      timing.kind === "interval" ? String(timing.everyMinutes / 60) : "24",
    intervalAnchor:
      timing.kind === "interval" ? timing.anchorAt : new Date().toISOString(),
    timeOfDay:
      timing.kind === "daily" || timing.kind === "weekly"
        ? timing.timeOfDay
        : "03:00",
    weekdays: timing.kind === "weekly" ? timing.weekdays : [1],
    timeZone:
      timing.kind === "daily" || timing.kind === "weekly"
        ? timing.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    maximumUpdates: String(schedule.payload.limits.maximumUpdates),
    maximumDecreasePercent: String(
      schedule.payload.limits.maximumDecreasePercent,
    ),
    maximumDecreaseAmount: String(
      schedule.payload.limits.maximumDecreaseAmount,
    ),
    maximumIncreasePercent: String(
      schedule.payload.limits.maximumIncreasePercent,
    ),
    maximumBlockedPercent: String(
      schedule.payload.limits.maximumBlockedPercent,
    ),
  };
}

function draftInput(draft: RepricingDraft): JobScheduleInput {
  const timing: JobScheduleInput["timing"] =
    draft.timingKind === "once"
      ? { kind: "once", runAt: new Date(draft.runAt).toISOString() }
      : draft.timingKind === "interval"
        ? {
            kind: "interval",
            everyMinutes: Number(draft.intervalHours) * 60,
            anchorAt: draft.intervalAnchor,
          }
        : draft.timingKind === "daily"
          ? {
              kind: "daily",
              timeOfDay: draft.timeOfDay,
              timeZone: draft.timeZone,
            }
          : {
              kind: "weekly",
              weekdays: draft.weekdays,
              timeOfDay: draft.timeOfDay,
              timeZone: draft.timeZone,
            };
  return {
    name: draft.name,
    enabled: true,
    timing,
    payload: {
      type: "reprice-inventory",
      pricingProfileId: draft.profileId,
      mode: draft.mode,
      scope: "all",
      limits: {
        maximumUpdates: Number(draft.maximumUpdates),
        maximumDecreasePercent: Number(draft.maximumDecreasePercent),
        maximumDecreaseAmount: Number(draft.maximumDecreaseAmount),
        maximumIncreasePercent: Number(draft.maximumIncreasePercent),
        maximumBlockedPercent: Number(draft.maximumBlockedPercent),
      },
    },
  };
}

function scheduleDescription(
  schedule: JobSchedule,
  settings: Settings,
): string {
  const timing = timingDescription(schedule);
  if (schedule.payload.type === "list-inventory") {
    const payload = schedule.payload;
    const profile = settings.merchandiseProfiles.find(
      (candidate) => candidate.id === payload.merchandiseProfileId,
    );
    return `${String(payload.items.length)} exact SKU${payload.items.length === 1 ? "" : "s"} · ${profile?.name ?? "Missing profile"} · ${timing}`;
  }
  const payload = schedule.payload;
  const profile = settings.repricingProfiles.find(
    (candidate) => candidate.id === payload.pricingProfileId,
  );
  return `${profile?.name ?? "Missing profile"} · ${payload.mode === "automatic" ? "Automatic" : "Review only"} · ${timing}`;
}

function timingDescription(schedule: JobSchedule): string {
  const timing = schedule.timing;
  if (timing.kind === "once") return `once ${compactDate(timing.runAt)}`;
  if (timing.kind === "interval") {
    return `every ${String(timing.everyMinutes / 60)} hours`;
  }
  if (timing.kind === "daily") {
    return `daily ${timing.timeOfDay} ${timing.timeZone}`;
  }
  return `${timing.weekdays.map((day) => WEEKDAYS.find((item) => item.value === day)?.label ?? day).join(", ")} ${timing.timeOfDay} ${timing.timeZone}`;
}

function runSummary(run: JobRun): string {
  const report = run.report;
  if (report === undefined) return run.errorCode?.replaceAll("_", " ") ?? "—";
  const queued = report.queuedPriceJobs + report.queuedInventoryJobs;
  return `${String(queued)} queued · ${String(report.reviewRequired)} review · ${String(report.skipped)} skipped`;
}

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
