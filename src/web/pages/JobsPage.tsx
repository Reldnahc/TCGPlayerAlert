import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  InternalJobsResponse,
  InventoryJob,
  PriceJob,
} from "../contracts.js";
import { uiApi } from "../api.js";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from "../components/ui.js";
import { useSettings } from "../state/SettingsContext.js";
import { useToast } from "../state/ToastContext.js";
import { compactDate, errorMessage, money } from "../utils.js";
import { JobRunsPanel, JobSchedulesPanel } from "./JobSchedulePanels.js";

const PAGE_SIZE = 10;
type JobsView = "schedules" | "runs" | "inventory" | "price";
type MutationQueue = "inventory" | "price";

const EMPTY_INTERNAL_JOBS: InternalJobsResponse = {
  schedules: [],
  runs: [],
  runnerRunning: false,
};

export function JobsPage() {
  const toast = useToast();
  const { settings } = useSettings();
  const [view, setView] = useState<JobsView>("schedules");
  const [internalJobs, setInternalJobs] =
    useState<InternalJobsResponse>(EMPTY_INTERNAL_JOBS);
  const [inventoryJobs, setInventoryJobs] = useState<readonly InventoryJob[]>(
    [],
  );
  const [priceJobs, setPriceJobs] = useState<readonly PriceJob[]>([]);
  const [workers, setWorkers] = useState({ inventory: false, price: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [internal, inventory, price] = await Promise.all([
        uiApi.internalJobs(),
        uiApi.inventoryJobs(),
        uiApi.priceJobs(),
      ]);
      setInternalJobs(internal);
      setInventoryJobs(inventory.jobs);
      setPriceJobs(price.jobs);
      setWorkers({
        inventory: inventory.workerRunning,
        price: price.workerRunning,
      });
    } catch (cause) {
      setError(errorMessage(cause, "Jobs could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const unfinishedRuns = internalJobs.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  ).length;

  return (
    <main class="page page--fixed">
      <PageHeader
        title="Jobs"
        description="Schedule internal work and inspect every handoff to the mutation queues."
        actions={
          <Button icon="refresh" busy={loading} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      <div class="page-body jobs-layout">
        <div class="queue-tabs">
          <div class="segmented jobs-tabs">
            <JobsTab
              active={view === "schedules"}
              count={internalJobs.schedules.length}
              label="Schedules"
              onClick={() => setView("schedules")}
            />
            <JobsTab
              active={view === "runs"}
              count={unfinishedRuns}
              label="Runs"
              onClick={() => setView("runs")}
            />
            <JobsTab
              active={view === "inventory"}
              count={inventoryJobs.length}
              label="Inventory queue"
              onClick={() => {
                setView("inventory");
                setPage(0);
              }}
            />
            <JobsTab
              active={view === "price"}
              count={priceJobs.length}
              label="Price queue"
              onClick={() => {
                setView("price");
                setPage(0);
              }}
            />
          </div>
          {view === "schedules" || view === "runs" ? (
            <WorkerState
              running={internalJobs.runnerRunning}
              runningLabel="Scheduler processing"
            />
          ) : (
            <WorkerState
              running={workers[view]}
              runningLabel="Worker processing"
            />
          )}
        </div>
        {error === "" ? null : <Notice tone="danger">{error}</Notice>}
        {loading && settings === null ? (
          <div class="empty-state">
            <Spinner label="Loading jobs" />
          </div>
        ) : view === "schedules" ? (
          settings === null ? (
            <EmptyState title="Settings are unavailable" />
          ) : (
            <JobSchedulesPanel
              schedules={internalJobs.schedules}
              settings={settings}
              runnerRunning={internalJobs.runnerRunning}
              onChanged={load}
            />
          )
        ) : view === "runs" ? (
          <JobRunsPanel runs={internalJobs.runs} onChanged={load} />
        ) : (
          <MutationQueuePanel
            queue={view}
            inventoryJobs={inventoryJobs}
            priceJobs={priceJobs}
            loading={loading}
            busy={busy}
            page={page}
            onPage={setPage}
            onMutate={async (job, action) => {
              if (busy !== "") return;
              setBusy(job.id);
              setError("");
              try {
                await uiApi.mutateJob(view, job.id, action);
                toast.show(
                  action === "resubmit"
                    ? "Failed job queued as a new attempt."
                    : "Pending job canceled.",
                  "success",
                );
                if (action === "resubmit") setPage(0);
                await load();
              } catch (cause) {
                setError(errorMessage(cause, "The job could not be updated."));
              } finally {
                setBusy("");
              }
            }}
          />
        )}
      </div>
    </main>
  );
}

function JobsTab({
  active,
  count,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly count: number;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}>
      {label} <span>{count}</span>
    </button>
  );
}

function WorkerState({
  running,
  runningLabel,
}: {
  readonly running: boolean;
  readonly runningLabel: string;
}) {
  return (
    <span class={`worker-state${running ? " is-running" : ""}`}>
      <i />
      {running ? runningLabel : "Idle"}
    </span>
  );
}

function MutationQueuePanel({
  queue,
  inventoryJobs,
  priceJobs,
  loading,
  busy,
  page,
  onPage,
  onMutate,
}: {
  readonly queue: MutationQueue;
  readonly inventoryJobs: readonly InventoryJob[];
  readonly priceJobs: readonly PriceJob[];
  readonly loading: boolean;
  readonly busy: string;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly onMutate: (
    job: InventoryJob | PriceJob,
    action: "cancel" | "resubmit",
  ) => Promise<void>;
}) {
  const jobs = queue === "inventory" ? inventoryJobs : priceJobs;
  const pageCount = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = useMemo(
    () => jobs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [currentPage, jobs],
  );

  return (
    <>
      <div class="data-region jobs-table-region">
        {loading && jobs.length === 0 ? (
          <div class="empty-state">
            <Spinner label="Loading jobs" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            title={
              queue === "inventory"
                ? "No inventory changes"
                : "No price updates"
            }
          />
        ) : (
          <table class="data-table jobs-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Operation</th>
                <th>Status</th>
                <th>Created</th>
                <th>Attempts</th>
                <th>Error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((job) => {
                const inventory = "operation" in job;
                const change = inventory
                  ? job.operation === "add"
                    ? job.addition
                    : job.removal
                  : job.update;
                const operation = inventory ? job.operation : "price update";
                const detail =
                  inventory && job.operation === "add"
                    ? `+${String(job.addition.addQuantity)} · ${money(job.addition.price)}`
                    : inventory
                      ? `Remove qty ${String(job.removal.currentQuantity)} · ${money(job.removal.price)}`
                      : `${money(job.update.price)} · qty ${String(job.update.quantity)}`;
                return (
                  <tr key={job.id}>
                    <td>
                      <span class="cell-stack">
                        <strong>{change.productName}</strong>
                        <small>{detail}</small>
                      </span>
                    </td>
                    <td>{operation}</td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td>{compactDate(job.createdAt)}</td>
                    <td class="numeric">{job.attempts}</td>
                    <td>
                      <span class="job-error">
                        {job.errorCode
                          ?.replaceAll("_", " ")
                          .toLocaleLowerCase() ?? "—"}
                      </span>
                    </td>
                    <td class="cell-actions">
                      {job.status === "pending" ? (
                        <Button
                          tone="quiet"
                          busy={busy === job.id}
                          onClick={() => void onMutate(job, "cancel")}
                        >
                          Cancel
                        </Button>
                      ) : job.status === "failed" ? (
                        <Button
                          tone="secondary"
                          busy={busy === job.id}
                          onClick={() => void onMutate(job, "resubmit")}
                        >
                          Retry
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {pageCount <= 1 ? null : (
        <div class="pagination">
          <Button
            tone="quiet"
            disabled={currentPage === 0}
            onClick={() => onPage(currentPage - 1)}
          >
            Previous
          </Button>
          <span>
            Page {currentPage + 1} of {pageCount} · {jobs.length} jobs
          </span>
          <Button
            tone="quiet"
            disabled={currentPage >= pageCount - 1}
            onClick={() => onPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
