import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import { Icon } from "../components/Icon.js";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
} from "../components/ui.js";
import type { MasterPullList } from "../contracts.js";
import { dateTime, errorMessage } from "../utils.js";

type PullListRow = MasterPullList["rows"][number];
type PullListSortField =
  "quantity" | "product" | "set" | "condition" | "rarity" | "color";
type PullListSortDirection = "ascending" | "descending";

interface PullListSort {
  readonly field: PullListSortField;
  readonly direction: PullListSortDirection;
}

interface SortableHeaderProps {
  readonly field: PullListSortField;
  readonly label: string;
  readonly className: string;
  readonly sort: PullListSort | null;
  readonly onSort: (field: PullListSortField) => void;
}

const PULL_LIST_SORT_STORAGE_KEY = "tcgplayer-alert.master-pull-list-sort.v1";
const PULL_LIST_SORT_FIELDS = new Set<PullListSortField>([
  "quantity",
  "product",
  "set",
  "condition",
  "rarity",
  "color",
]);
const PULL_LIST_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function isPullListSort(value: unknown): value is PullListSort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.field === "string" &&
    PULL_LIST_SORT_FIELDS.has(candidate.field as PullListSortField) &&
    (candidate.direction === "ascending" ||
      candidate.direction === "descending")
  );
}

function readPullListSort(): PullListSort | null {
  try {
    const stored = window.localStorage.getItem(PULL_LIST_SORT_STORAGE_KEY);
    if (stored === null) return null;
    const parsed: unknown = JSON.parse(stored);
    return isPullListSort(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePullListSort(sort: PullListSort) {
  try {
    window.localStorage.setItem(
      PULL_LIST_SORT_STORAGE_KEY,
      JSON.stringify(sort),
    );
  } catch {
    // Sorting must still work when browser storage is unavailable.
  }
}

function rowColor(row: PullListRow): string {
  return row.metadata.flatMap((item) => item.values).join(" / ");
}

function compareRows(
  left: PullListRow,
  right: PullListRow,
  field: PullListSortField,
): number {
  switch (field) {
    case "quantity":
      return left.orderQuantity - right.orderQuantity;
    case "product":
      return PULL_LIST_COLLATOR.compare(left.productName, right.productName);
    case "set":
      return PULL_LIST_COLLATOR.compare(left.setName, right.setName);
    case "condition":
      return PULL_LIST_COLLATOR.compare(left.condition, right.condition);
    case "rarity":
      return PULL_LIST_COLLATOR.compare(left.rarity, right.rarity);
    case "color":
      return PULL_LIST_COLLATOR.compare(rowColor(left), rowColor(right));
  }
}

function SortableHeader({
  field,
  label,
  className,
  sort,
  onSort,
}: SortableHeaderProps) {
  const active = sort?.field === field;
  const ariaSort = active ? sort.direction : undefined;
  const directionLabel = active ? `, currently ${sort.direction}` : "";
  const indicator = active ? (sort.direction === "ascending" ? "↑" : "↓") : "↕";

  return (
    <th class={className} aria-sort={ariaSort}>
      <button
        type="button"
        class="pull-list-sort"
        aria-label={`Sort by ${label.toLowerCase()}${directionLabel}`}
        onClick={() => onSort(field)}
      >
        <span>{label}</span>
        <span class="pull-list-sort__indicator" aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}

export function MasterPullListPage() {
  const [pullList, setPullList] = useState<MasterPullList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<PullListSort | null>(readPullListSort);

  const sortedRows = useMemo(() => {
    if (pullList === null || sort === null) return pullList?.rows ?? [];

    return pullList.rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const comparison = compareRows(left.row, right.row, sort.field);
        if (comparison === 0) return left.index - right.index;
        return sort.direction === "ascending" ? comparison : -comparison;
      })
      .map(({ row }) => row);
  }, [pullList, sort]);

  const updateSort = useCallback((field: PullListSortField) => {
    setSort((current) => {
      const next: PullListSort = {
        field,
        direction:
          current?.field === field
            ? current.direction === "ascending"
              ? "descending"
              : "ascending"
            : field === "quantity"
              ? "descending"
              : "ascending",
      };
      writePullListSort(next);
      return next;
    });
  }, []);

  const load = useCallback(async (force = false, signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      setPullList(await uiApi.masterPullList(force, signal));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(
        errorMessage(cause, "The master pull list could not be loaded."),
      );
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPullList(null);
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main class="page pull-list-page">
      <PageHeader
        title="Master pull list"
        description="All orders ready to ship"
        actions={
          <>
            <a class="button button--quiet" href="#orders">
              <Icon name="chevron-left" size={16} />
              <span>All orders</span>
            </a>
            <Button
              icon="refresh"
              busy={loading && pullList !== null}
              onClick={() => void load(true)}
            >
              Refresh
            </Button>
            <Button
              tone="primary"
              icon="printer"
              disabled={pullList === null || pullList.rows.length === 0}
              onClick={() => window.print()}
            >
              Print
            </Button>
          </>
        }
      />
      <div class="page-body pull-list-layout">
        {error === "" ? null : (
          <Notice tone="danger">
            <strong>Master pull list could not be loaded</strong>
            <span>{error}</span>
            <Button tone="secondary" onClick={() => void load(true)}>
              Try again
            </Button>
          </Notice>
        )}
        {loading && pullList === null ? (
          <div class="pull-list-loading">
            <Spinner label="Loading master pull list" />
          </div>
        ) : pullList === null ? null : (
          <>
            {pullList.metadataIssue === undefined ? null : (
              <Notice tone="warning">{pullList.metadataIssue}</Notice>
            )}
            <section class="surface pull-list-summary">
              <div>
                <span>Ready orders</span>
                <strong>{String(pullList.orderCount)}</strong>
              </div>
              <div>
                <span>Cards to pull</span>
                <strong>{String(pullList.totalQuantity)}</strong>
              </div>
              <div>
                <span>Unique SKUs</span>
                <strong>{String(pullList.rows.length)}</strong>
              </div>
              <div>
                <span>Loaded</span>
                <strong>{dateTime(pullList.fetchedAt)}</strong>
              </div>
            </section>
            <p class="pull-list-print-meta">
              {String(pullList.orderCount)} ready orders ·{" "}
              {String(pullList.totalQuantity)} cards ·{" "}
              {String(pullList.rows.length)} unique SKUs
            </p>
            <section class="surface pull-list-sheet">
              <header class="surface__header pull-list-sheet__header">
                <div>
                  <strong>Combined items</strong>
                  <p>
                    Pull the combined quantity shown for each exact printing.
                  </p>
                </div>
              </header>
              {pullList.rows.length === 0 ? (
                <EmptyState title="There are no cards to pull" />
              ) : (
                <div class="data-region data-region--embedded pull-list-region">
                  <table class="data-table pull-list-table">
                    <colgroup>
                      <col class="pull-list-col-check" />
                      <col class="pull-list-col-quantity" />
                      <col class="pull-list-col-product" />
                      <col class="pull-list-col-set" />
                      <col class="pull-list-col-condition" />
                      <col class="pull-list-col-rarity" />
                      <col class="pull-list-col-metadata" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th class="pull-list-col-check">
                          <span class="visually-hidden">Pulled</span>
                        </th>
                        <SortableHeader
                          field="quantity"
                          label="Qty"
                          className="align-right pull-list-col-quantity"
                          sort={sort}
                          onSort={updateSort}
                        />
                        <SortableHeader
                          field="product"
                          label="Product"
                          className="pull-list-col-product"
                          sort={sort}
                          onSort={updateSort}
                        />
                        <SortableHeader
                          field="set"
                          label="Set / #"
                          className="pull-list-col-set"
                          sort={sort}
                          onSort={updateSort}
                        />
                        <SortableHeader
                          field="condition"
                          label="Condition"
                          className="pull-list-col-condition"
                          sort={sort}
                          onSort={updateSort}
                        />
                        <SortableHeader
                          field="rarity"
                          label="Rarity"
                          className="pull-list-col-rarity"
                          sort={sort}
                          onSort={updateSort}
                        />
                        <SortableHeader
                          field="color"
                          label="Color"
                          className="pull-list-col-metadata"
                          sort={sort}
                          onSort={updateSort}
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row) => (
                        <tr key={row.skuId}>
                          <td class="pull-list-col-check">
                            <span class="pull-list-check" aria-hidden="true" />
                          </td>
                          <td class="align-right numeric pull-list-quantity">
                            {String(row.orderQuantity)}
                          </td>
                          <td class="pull-list-col-product">
                            <div class="cell-stack pull-list-product">
                              <strong>{row.productName}</strong>
                              <small>{row.productLine}</small>
                            </div>
                          </td>
                          <td class="pull-list-col-set">
                            <div class="cell-stack">
                              <strong>{row.setName}</strong>
                              {row.number === "" ? null : (
                                <small>#{row.number}</small>
                              )}
                            </div>
                          </td>
                          <td class="pull-list-col-condition">
                            {row.condition}
                          </td>
                          <td class="pull-list-col-rarity">
                            {row.rarity === "" ? "—" : row.rarity}
                          </td>
                          <td class="pull-list-col-metadata">
                            {rowColor(row) === "" ? (
                              <span class="pull-list-metadata-empty">—</span>
                            ) : (
                              <strong class="pull-list-metadata">
                                {rowColor(row)}
                              </strong>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
