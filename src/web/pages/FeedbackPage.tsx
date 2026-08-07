import { useEffect, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import {
  Button,
  EmptyState,
  Field,
  Metric,
  Notice,
  PageHeader,
  Spinner,
  Toolbar,
} from "../components/ui.js";
import type { FeedbackPage as FeedbackPageData } from "../contracts.js";
import { compactDate, dateTime, errorMessage } from "../utils.js";

const RATINGS = [
  ["", "All ratings"],
  ["5", "5 stars"],
  ["4", "4 stars"],
  ["3", "3 stars"],
  ["2", "2 stars"],
  ["1", "1 star"],
] as const;

const AGE_WINDOWS = [
  ["", "All time"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["365", "Last 365 days"],
] as const;

type FeedbackEntry = FeedbackPageData["feedback"][number];

export function FeedbackPage() {
  const [page, setPage] = useState(1);
  const [rating, setRating] = useState("");
  const [commentsOnly, setCommentsOnly] = useState(false);
  const [days, setDays] = useState("");
  const [data, setData] = useState<FeedbackPageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(force = false, signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      setData(
        await uiApi.feedback(page, rating, commentsOnly, days, force, signal),
      );
    } catch (cause) {
      if (signal?.aborted !== true) {
        setError(errorMessage(cause, "Feedback could not be loaded."));
      }
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [page, rating, commentsOnly, days]);

  const aggregation = data?.aggregation;
  const average =
    aggregation === undefined || aggregation.totalRatings === 0
      ? "—"
      : `${(
          (aggregation.fiveStar * 5 +
            aggregation.fourStar * 4 +
            aggregation.threeStar * 3 +
            aggregation.twoStar * 2 +
            aggregation.oneStar) /
          aggregation.totalRatings
        ).toFixed(2)} / 5`;

  return (
    <main class="page">
      <PageHeader
        title="Feedback"
        description="Read-only seller ratings and buyer comments"
        actions={
          <>
            {data === null ? null : (
              <a
                class="button button--secondary"
                href={data.storefrontUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open TCGplayer
              </a>
            )}
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
      <div class="page-body feedback-layout">
        <div class="metric-strip feedback-metrics">
          <Metric label="Average rating" value={average} />
          <Metric
            label="Total ratings"
            value={
              aggregation === undefined ? "—" : String(aggregation.totalRatings)
            }
            detail={days === "" ? "All time" : `Last ${days} days`}
          />
          <Metric
            label="5-star share"
            value={percentage(aggregation?.fiveStar, aggregation?.totalRatings)}
            detail={
              aggregation === undefined
                ? undefined
                : `${String(aggregation.fiveStar)} five-star rating${aggregation.fiveStar === 1 ? "" : "s"}`
            }
          />
          <Metric
            label="Matching feedback"
            value={data === null ? "—" : String(data.totalFeedback)}
            detail={commentsOnly ? "Comments only" : "Current filters"}
          />
        </div>
        <Toolbar>
          <Field label="Rating" class="feedback-filter">
            <select
              value={rating}
              onChange={(event) => {
                setRating(event.currentTarget.value);
                setPage(1);
              }}
            >
              {RATINGS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Comment" class="feedback-filter">
            <select
              value={commentsOnly ? "comments" : "all"}
              onChange={(event) => {
                setCommentsOnly(event.currentTarget.value === "comments");
                setPage(1);
              }}
            >
              <option value="all">All feedback</option>
              <option value="comments">With comments</option>
            </select>
          </Field>
          <Field label="Period" class="feedback-filter">
            <select
              value={days}
              onChange={(event) => {
                setDays(event.currentTarget.value);
                setPage(1);
              }}
            >
              {AGE_WINDOWS.map(([value, label]) => (
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
              : `Page ${String(data.page)} of ${String(data.totalPages)} · updated ${dateTime(data.fetchedAt)}`}
          </span>
        </Toolbar>
        {error === "" ? null : <Notice tone="danger">{error}</Notice>}
        <div class="data-region feedback-table-region">
          {loading && data === null ? (
            <div class="empty-state">
              <Spinner label="Loading feedback" />
            </div>
          ) : data === null || data.feedback.length === 0 ? (
            <EmptyState
              title="No feedback found"
              detail="Try clearing one or more filters."
            />
          ) : (
            <table class="data-table feedback-table">
              <thead>
                <tr>
                  <th>Rating</th>
                  <th>Date</th>
                  <th>Buyer</th>
                  <th>Comment</th>
                  <th>Order experience</th>
                </tr>
              </thead>
              <tbody>
                {data.feedback.map((feedback, index) => (
                  <FeedbackRow
                    key={`${feedback.createdAt}:${feedback.buyerDisplayName ?? "buyer"}:${String(index)}`}
                    feedback={feedback}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div class="feedback-pagination">
          <Button
            icon="chevron-left"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <span>
            Page {String(data?.page ?? page)} of {String(data?.totalPages ?? 1)}
          </span>
          <Button
            icon="chevron-right"
            disabled={loading || data === null || data.page >= data.totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </main>
  );
}

function FeedbackRow({ feedback }: { readonly feedback: FeedbackEntry }) {
  return (
    <tr>
      <td>
        <span
          class="feedback-stars"
          aria-label={`${String(feedback.rating)} out of 5 stars`}
        >
          {"★".repeat(feedback.rating)}
          <i>{"★".repeat(5 - feedback.rating)}</i>
        </span>
      </td>
      <td class="feedback-date">{compactDate(feedback.createdAt)}</td>
      <td>{feedback.buyerDisplayName ?? "Anonymous buyer"}</td>
      <td class="feedback-comment">
        {feedback.comment ?? <span class="muted">No comment left</span>}
      </td>
      <td>
        <div class="feedback-signals">
          <FeedbackSignal
            label="Delivery"
            value={feedback.arrivedWhenExpected}
          />
          <FeedbackSignal label="Item" value={feedback.asDescribed} />
          <FeedbackSignal
            label="Communication"
            value={feedback.goodCommunication}
          />
        </div>
      </td>
    </tr>
  );
}

function FeedbackSignal({
  label,
  value,
}: {
  readonly label: string;
  readonly value: boolean | undefined;
}) {
  return (
    <span
      class={`feedback-signal ${value === true ? "is-positive" : value === false ? "is-negative" : "is-unanswered"}`}
      title={`${label}: ${value === true ? "positive" : value === false ? "negative" : "not answered"}`}
    >
      {label}
    </span>
  );
}

function percentage(
  numerator: number | undefined,
  denominator: number | undefined,
): string {
  if (numerator === undefined || denominator === undefined || denominator === 0)
    return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
