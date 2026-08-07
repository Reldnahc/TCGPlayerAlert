import { useEffect, useMemo, useState } from "preact/hooks";
import type { InventoryJob, PriceJob } from "../contracts.js";
import { uiApi } from "../api.js";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from "../components/ui.js";
import { useToast } from "../state/ToastContext.js";
import { compactDate, errorMessage, money } from "../utils.js";

const PAGE_SIZE = 10;
type QueueName = "inventory" | "price";

export function JobsPage() {
  const toast = useToast();
  const [queue, setQueue] = useState<QueueName>("inventory");
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
      const [inventory, price] = await Promise.all([
        uiApi.inventoryJobs(),
        uiApi.priceJobs(),
      ]);
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
  const jobs = queue === "inventory" ? inventoryJobs : priceJobs;
  const pageCount = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = useMemo(
    () => jobs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [currentPage, jobs],
  );

  async function mutate(
    job: InventoryJob | PriceJob,
    action: "cancel" | "resubmit",
  ) {
    if (busy !== "") return;
    setBusy(job.id);
    setError("");
    try {
      await uiApi.mutateJob(queue, job.id, action);
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
  }

  return (
    <main class="page page--fixed">
      <PageHeader
        title="Jobs"
        description="Track queued inventory and price changes."
        actions={
          <Button icon="refresh" busy={loading} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      <div class="page-body jobs-layout">
        <div class="queue-tabs">
          <div class="segmented">
            <button
              type="button"
              aria-pressed={queue === "inventory"}
              onClick={() => {
                setQueue("inventory");
                setPage(0);
              }}
            >
              Inventory changes <span>{inventoryJobs.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={queue === "price"}
              onClick={() => {
                setQueue("price");
                setPage(0);
              }}
            >
              Price updates <span>{priceJobs.length}</span>
            </button>
          </div>
          <span class={`worker-state${workers[queue] ? " is-running" : ""}`}>
            <i />
            {workers[queue] ? "Worker processing" : "Worker idle"}
          </span>
        </div>
        {error === "" ? null : <Notice tone="danger">{error}</Notice>}
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
                            onClick={() => void mutate(job, "cancel")}
                          >
                            Cancel
                          </Button>
                        ) : job.status === "failed" ? (
                          <Button
                            tone="secondary"
                            busy={busy === job.id}
                            onClick={() => void mutate(job, "resubmit")}
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
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <span>
              Page {currentPage + 1} of {pageCount} · {jobs.length} jobs
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
      </div>
    </main>
  );
}
