import { useEffect, useMemo, useState } from "preact/hooks";
import {
  sellerPortalOrderUrl,
  sellerPortalPaymentsUrl,
  uiApi,
} from "../api.js";
import {
  Button,
  EmptyState,
  Field,
  Metric,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
  Toolbar,
} from "../components/ui.js";
import type {
  PaymentDetail,
  PaymentsPage as PaymentsData,
} from "../contracts.js";
import {
  compactDate,
  dateTime,
  errorMessage,
  moneyFromCents,
} from "../utils.js";

const PAYOUT_STATUSES = [
  ["", "All statuses"],
  ["Staged", "Preparing payout"],
  ["InReview", "Flagged"],
  ["Committed", "Ready to send"],
  ["InTransit", "Sent to processor"],
  ["Retrying", "Retrying"],
  ["Succeeded", "Funds sent"],
  ["Failed", "Failed"],
  ["Rejected", "Rejected"],
] as const;

const CURRENT_PAYOUT_STATUSES = new Set([
  "InTransit",
  "Committed",
  "InReview",
  "Staged",
]);
const PREVIOUS_PAYOUT_STATUSES = new Set(["Succeeded", "Failed"]);

type PaymentPanelSelection =
  | { readonly kind: "payout"; readonly referenceId: string }
  | { readonly kind: "upcoming" }
  | null;
type PaymentTransaction = PaymentsData["unpaidBalance"]["transactions"][number];

export function PaymentsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [data, setData] = useState<PaymentsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<PaymentPanelSelection>(null);
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  async function load(force = false) {
    setLoading(true);
    setError("");
    try {
      setData(await uiApi.payments(page, status, force));
    } catch (cause) {
      setError(errorMessage(cause, "Payments could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [page, status]);

  async function selectPayout(referenceId: string, force = false) {
    if (selection?.kind !== "payout" || selection.referenceId !== referenceId)
      setDetail(null);
    setSelection({ kind: "payout", referenceId });
    setDetailLoading(true);
    setDetailError("");
    try {
      setDetail(await uiApi.payment(referenceId, force));
    } catch (cause) {
      setDetail(null);
      setDetailError(
        errorMessage(cause, "Payout details could not be loaded."),
      );
    } finally {
      setDetailLoading(false);
    }
  }

  const nextPayout = useMemo(
    () =>
      data?.payouts
        .filter((payout) => CURRENT_PAYOUT_STATUSES.has(payout.status))
        .sort((left, right) =>
          (left.holdUntil ?? left.createdAt).localeCompare(
            right.holdUntil ?? right.createdAt,
          ),
        )[0],
    [data],
  );
  const previousPayout = useMemo(
    () =>
      data?.payouts
        .filter((payout) => PREVIOUS_PAYOUT_STATUSES.has(payout.status))
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )[0],
    [data],
  );
  const selectedReference =
    selection?.kind === "payout" ? selection.referenceId : "";
  const previousReference = previousPayout?.referenceId ?? undefined;
  const nextReference = nextPayout?.referenceId ?? undefined;
  const unpaidTransactions = data?.unpaidBalance.transactions ?? [];
  const unpaidAsOf = newestTransactionDate(unpaidTransactions);
  const totalPages =
    data === null
      ? 1
      : Math.max(1, Math.ceil(data.totalPayouts / data.pageSize));

  return (
    <main class="page">
      <PageHeader
        title="Payments"
        description="Read-only upcoming and completed payouts"
        actions={
          <>
            <a
              class="button button--secondary"
              href={sellerPortalPaymentsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Seller Portal
            </a>
            <Button
              icon="refresh"
              busy={loading}
              onClick={() => void load(true)}
            >
              Refresh
            </Button>
          </>
        }
      />
      <div class="page-body payments-layout">
        <div class="metric-strip payments-metrics">
          <Metric
            label="Previous payout"
            value={moneyFromCents(previousPayout?.amount)}
            detail={
              previousPayout === undefined
                ? "No previous payouts"
                : `${previousPayout.status} · ${previousPayout.lastSentAt === undefined ? compactDate(previousPayout.createdAt) : `Sent ${compactDate(previousPayout.lastSentAt)}`}`
            }
            actionLabel={
              previousReference === undefined
                ? undefined
                : `View previous payout ${previousReference}`
            }
            onClick={
              previousReference === undefined
                ? undefined
                : () => void selectPayout(previousReference)
            }
          />
          <Metric
            label="Next payout"
            value={moneyFromCents(nextPayout?.amount)}
            detail={
              nextPayout === undefined
                ? "No payouts scheduled"
                : `${nextPayout.status} · ${nextPayout.holdUntil === undefined ? compactDate(nextPayout.createdAt) : `Scheduled ${compactDate(nextPayout.holdUntil)}`}`
            }
            actionLabel={
              nextReference === undefined
                ? undefined
                : `View next payout ${nextReference}`
            }
            onClick={
              nextReference === undefined
                ? undefined
                : () => void selectPayout(nextReference)
            }
          />
          <Metric
            label="Unpaid balance"
            value={moneyFromCents(data?.unpaidBalance.totalBalance)}
            detail={
              unpaidTransactions.length === 0
                ? "No upcoming transactions"
                : `${String(unpaidTransactions.length)} transaction${unpaidTransactions.length === 1 ? "" : "s"}${unpaidAsOf === undefined ? "" : ` · As of ${compactDate(unpaidAsOf)}`}`
            }
            actionLabel={
              unpaidTransactions.length === 0
                ? undefined
                : "View upcoming payment transactions"
            }
            onClick={
              unpaidTransactions.length === 0
                ? undefined
                : () => {
                    setSelection({ kind: "upcoming" });
                    setDetail(null);
                    setDetailError("");
                  }
            }
          />
          <Metric
            label="Payout records"
            value={data === null ? "—" : String(data.totalPayouts)}
          />
        </div>
        <Toolbar>
          <Field label="Payout status" class="payment-status-filter">
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value);
                setPage(1);
                setSelection(null);
                setDetail(null);
              }}
            >
              {PAYOUT_STATUSES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <span class="toolbar__spacer" />
          <span class="muted">
            {data === null
              ? ""
              : `Page ${String(data.page)} of ${String(totalPages)} · updated ${dateTime(data.fetchedAt)}`}
          </span>
        </Toolbar>
        {error === "" ? null : <Notice tone="danger">{error}</Notice>}
        <section class="payments-workspace">
          <div class="data-region payments-table-region">
            {loading && data === null ? (
              <div class="empty-state">
                <Spinner label="Loading payments" />
              </div>
            ) : data === null || data.payouts.length === 0 ? (
              <EmptyState title="No payouts found" />
            ) : (
              <table class="data-table payments-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Payout ID</th>
                    <th class="align-right">Orders</th>
                    <th>Status</th>
                    <th class="align-right">Amount</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payouts.map((payout) => (
                    <tr
                      key={payout.payoutId}
                      class={
                        selectedReference === payout.referenceId
                          ? "is-selected"
                          : ""
                      }
                    >
                      <td>{compactDate(payout.createdAt)}</td>
                      <td class="numeric">{payout.referenceId ?? "—"}</td>
                      <td class="align-right numeric">{payout.ordersCount}</td>
                      <td>
                        <StatusBadge status={payout.status} />
                      </td>
                      <td class="align-right numeric">
                        <strong>{moneyFromCents(payout.amount)}</strong>
                      </td>
                      <td class="cell-actions">
                        <Button
                          tone="quiet"
                          disabled={payout.referenceId === null}
                          onClick={() => {
                            if (payout.referenceId !== null)
                              void selectPayout(payout.referenceId);
                          }}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {selection?.kind === "upcoming" ? (
            <UpcomingPaymentsPanel
              transactions={unpaidTransactions}
              totalBalance={data?.unpaidBalance.totalBalance}
              onClose={() => setSelection(null)}
            />
          ) : (
            <PayoutDetailPanel
              detail={detail}
              loading={detailLoading}
              error={detailError}
              selectedReference={selectedReference}
              onRefresh={() => {
                if (selectedReference !== "")
                  void selectPayout(selectedReference, true);
              }}
              onClose={() => {
                setSelection(null);
                setDetail(null);
                setDetailError("");
              }}
            />
          )}
        </section>
        <div class="payment-pagination">
          <Button
            icon="chevron-left"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button
            icon="chevron-right"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </main>
  );
}

function UpcomingPaymentsPanel({
  transactions,
  totalBalance,
  onClose,
}: {
  readonly transactions: readonly PaymentTransaction[];
  readonly totalBalance: number | undefined;
  readonly onClose: () => void;
}) {
  const [type, setType] = useState("All");
  const [orderQuery, setOrderQuery] = useState("");
  const normalizedQuery = orderQuery.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      transactions
        .filter(
          (transaction) =>
            (type === "All" || transaction.type === type) &&
            (normalizedQuery === "" ||
              transaction.orderNumber
                ?.toLocaleLowerCase()
                .includes(normalizedQuery) === true),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [normalizedQuery, transactions, type],
  );
  const asOf = newestTransactionDate(transactions);

  return (
    <aside class="payment-detail surface">
      <header class="surface__header">
        <div>
          <strong>Upcoming payments</strong>
          <p>
            New orders, refunds, and adjustments not yet included in a committed
            payout
            {asOf === undefined ? "" : ` · As of ${dateTime(asOf)}`}
          </p>
        </div>
        <Button tone="quiet" onClick={onClose}>
          Close
        </Button>
      </header>
      <div class="upcoming-payment-controls">
        <Metric label="Unpaid balance" value={moneyFromCents(totalBalance)} />
        <Field label="Search by order">
          <input
            type="search"
            value={orderQuery}
            placeholder="Order number"
            onInput={(event) => setOrderQuery(event.currentTarget.value)}
          />
        </Field>
        <Field label="Transaction type">
          <select
            value={type}
            onChange={(event) => setType(event.currentTarget.value)}
          >
            <option value="All">All</option>
            <option value="SettleOrder">Order</option>
            <option value="ApplyRefund">Refund</option>
            <option value="ApplyAdjustment">Adjustment</option>
          </select>
        </Field>
      </div>
      <div class="payment-transactions">
        {filtered.length === 0 ? (
          <EmptyState
            title={
              transactions.length === 0
                ? "No upcoming transactions"
                : "No matching transactions"
            }
          />
        ) : (
          <PaymentTransactionsTable transactions={filtered} />
        )}
      </div>
    </aside>
  );
}

function PayoutDetailPanel({
  detail,
  loading,
  error,
  selectedReference,
  onRefresh,
  onClose,
}: {
  readonly detail: PaymentDetail | null;
  readonly loading: boolean;
  readonly error: string;
  readonly selectedReference: string;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}) {
  if (selectedReference === "") {
    return (
      <aside class="payment-detail surface">
        <EmptyState
          title="Select a payout"
          detail="Payout transactions and totals will appear here."
        />
      </aside>
    );
  }
  return (
    <aside class="payment-detail surface">
      <header class="surface__header">
        <div>
          <strong>Payout {selectedReference}</strong>
          {detail === null ? null : (
            <p>
              {compactDate(detail.createdAt)} · {detail.status}
            </p>
          )}
        </div>
        <div class="row-actions">
          <Button
            tone="quiet"
            icon="refresh"
            busy={loading}
            onClick={onRefresh}
          >
            Refresh
          </Button>
          <Button tone="quiet" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>
      {loading && detail === null ? (
        <div class="empty-state">
          <Spinner label="Loading payout" />
        </div>
      ) : error !== "" ? (
        <div class="surface__body">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : detail === null ? null : (
        <>
          <div class="payment-detail-summary">
            <Metric label="Orders" value={moneyFromCents(detail.totalSales)} />
            <Metric
              label="Refunded"
              value={moneyFromCents(detail.totalRefunds)}
            />
            <Metric label="Fees" value={moneyFromCents(detail.totalFees)} />
            <Metric
              label="Adjustments"
              value={moneyFromCents(detail.totalAdjustments)}
            />
            <Metric
              label="Total payout"
              value={moneyFromCents(detail.amount)}
            />
          </div>
          <div class="payment-transactions">
            {detail.transactions.length === 0 ? (
              <EmptyState title="No displayed transactions" />
            ) : (
              <PaymentTransactionsTable transactions={detail.transactions} />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function PaymentTransactionsTable({
  transactions,
}: {
  readonly transactions: readonly PaymentTransaction[];
}) {
  return (
    <table class="data-table payment-transactions-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Order</th>
          <th class="align-right">Amount</th>
          <th class="align-right">Fee</th>
          <th class="align-right">Net</th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((transaction, index) => (
          <tr
            key={`${transaction.createdAt}:${transaction.type}:${String(index)}`}
          >
            <td>{compactDate(transaction.createdAt)}</td>
            <td>{transactionLabel(transaction.type)}</td>
            <td>
              {transaction.orderNumber === undefined ? (
                "—"
              ) : (
                <a
                  href={sellerPortalOrderUrl(transaction.orderNumber)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {transaction.orderNumber}
                </a>
              )}
            </td>
            <td class="align-right numeric">
              {moneyFromCents(transaction.amount)}
            </td>
            <td class="align-right numeric">
              {moneyFromCents(transaction.feeAmount)}
            </td>
            <td class="align-right numeric">
              <strong>{moneyFromCents(transaction.netAmount)}</strong>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function transactionLabel(value: string): string {
  if (value === "SettleOrder") return "Order";
  if (value === "ApplyRefund") return "Refund";
  if (value === "ApplyAdjustment") return "Adjustment";
  return value;
}

function newestTransactionDate(
  transactions: readonly PaymentTransaction[],
): string | undefined {
  return transactions.reduce<string | undefined>(
    (newest, transaction) =>
      newest === undefined || transaction.createdAt > newest
        ? transaction.createdAt
        : newest,
    undefined,
  );
}
