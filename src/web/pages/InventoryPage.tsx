import { useMemo, useState } from "preact/hooks";
import type { PricingPreview, PricingProgress } from "../contracts.js";
import { uiApi } from "../api.js";
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
import { useSettings } from "../state/SettingsContext.js";
import { useToast } from "../state/ToastContext.js";
import { errorMessage, money, normalizedTokens } from "../utils.js";

const PROFILE_KEY = "tcgplayer-alert.repricing-profile";

type PreviewRow = PricingPreview["rows"][number];
type ChangeSort = "none" | "ascending" | "descending";

interface PriceChange {
  readonly amount: number;
  readonly percent?: number;
  readonly direction: "increase" | "decrease" | "unchanged";
  readonly large: boolean;
}

function priceChange(row: PreviewRow): PriceChange {
  const amount = Math.round((row.proposedPrice - row.currentPrice) * 100) / 100;
  const percent =
    row.currentPrice === 0 ? undefined : (amount / row.currentPrice) * 100;
  return {
    amount,
    ...(percent === undefined ? {} : { percent }),
    direction: amount > 0 ? "increase" : amount < 0 ? "decrease" : "unchanged",
    large: percent !== undefined && Math.abs(percent) > 10,
  };
}

function signedMoney(value: number): string {
  if (value === 0) return money(0);
  return `${value > 0 ? "+" : "-"}${money(Math.abs(value))}`;
}

function signedPercent(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value === 0) return "0.0%";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function InventoryLoading({
  refreshing,
  profileName,
  progress,
}: {
  readonly refreshing: boolean;
  readonly profileName: string;
  readonly progress: PricingProgress | null;
}) {
  const title = refreshing
    ? "Refreshing inventory preview"
    : "Building inventory preview";
  const determinate = progress?.total !== undefined;
  const percent =
    progress?.total === undefined
      ? 0
      : progress.total === 0
        ? 100
        : Math.min(100, (progress.completed / progress.total) * 100);
  return (
    <div class="inventory-loading">
      <Spinner label={title} />
      <div
        class={`inventory-loading__progress${determinate ? " is-determinate" : ""}`}
        role="progressbar"
        aria-label={title}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={progress?.total}
        aria-valuenow={determinate ? progress.completed : undefined}
      >
        <span style={determinate ? { width: `${String(percent)}%` } : {}} />
      </div>
      <p>
        {progress?.detail ??
          `Starting the inventory reads required by ${profileName}.`}
      </p>
      <small>
        {progress === null
          ? `Profile: ${profileName}`
          : progress.total === undefined
            ? `${String(progress.completed)} ${progress.unit} loaded`
            : `${String(progress.completed)} / ${String(progress.total)} ${progress.unit}`}
      </small>
    </div>
  );
}

function searchText(row: PreviewRow): string {
  return [
    row.productName,
    row.productLineName,
    row.setName,
    row.condition,
    row.printing,
    row.language,
    row.productId,
    row.productConditionId,
  ]
    .join(" ")
    .toLocaleLowerCase();
}

function competitorText(row: PreviewRow): string {
  if (row.lowestPrice === undefined) return "—";
  const displayedShipping =
    (row.lowestShipping ?? 0) > 0
      ? ` + ${money(row.lowestShipping)} shipping`
      : "";
  const pricingShipping =
    row.competitorPricingShipping === undefined
      ? ""
      : ` · pricing uses ${money(row.competitorPricingShipping)} shipping`;
  const gap =
    row.gapPercent === undefined || row.gapPercent === 0
      ? ""
      : ` · ${row.gapPercent.toFixed(1)}% to reference`;
  const support =
    row.supportMode !== "cluster"
      ? ""
      : row.supportedClusterPrice === undefined
        ? ` · ${String(row.lowestSellerSupport ?? 0)} seller(s) near low · no supported band`
        : ` · ${String(row.lowestSellerSupport ?? 0)} seller(s) near low · band ${money(row.supportedClusterPrice)}${(row.supportedClusterShipping ?? 0) > 0 ? ` + ${money(row.supportedClusterShipping)} shipping` : ""} (${String(row.supportedClusterSellerCount)} sellers)`;
  const sample =
    row.qualifyingListings === undefined
      ? ""
      : ` · ${String(row.qualifyingListings)} comparable${row.qualifyingListings === 1 ? "" : "s"}`;
  const exact =
    row.comparisonSource === "exact" ? " · exact listing check" : "";
  return `${money(row.lowestPrice)}${displayedShipping}${pricingShipping}${gap}${support}${sample}${exact}`;
}

export function InventoryPage() {
  const { settings } = useSettings();
  const toast = useToast();
  const profiles = settings?.repricingProfiles ?? [];
  const [profileId, setProfileId] = useState(
    () => window.localStorage.getItem(PROFILE_KEY) ?? "",
  );
  const activeProfile =
    profiles.find((profile) => profile.id === profileId) ??
    profiles.find(
      (profile) => profile.id === settings?.defaultRepricingProfileId,
    ) ??
    profiles[0];
  const [preview, setPreview] = useState<PricingPreview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [proposedOnly, setProposedOnly] = useState(false);
  const [changeSort, setChangeSort] = useState<ChangeSort>("none");
  const [progress, setProgress] = useState<PricingProgress | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{
    readonly tone: "success" | "danger" | "warning";
    readonly text: string;
  } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [removals, setRemovals] = useState<ReadonlySet<string>>(new Set());

  const visibleRows = useMemo(() => {
    const tokens = normalizedTokens(query);
    const filtered =
      preview?.rows.filter(
        (row) =>
          (!proposedOnly || row.queueable) &&
          tokens.every((token) => searchText(row).includes(token)),
      ) ?? [];
    if (changeSort === "none") return filtered;
    return filtered
      .map((row, index) => ({ row, index, change: priceChange(row) }))
      .sort((left, right) => {
        const leftValue = left.change.percent ?? left.change.amount;
        const rightValue = right.change.percent ?? right.change.amount;
        const difference =
          changeSort === "ascending"
            ? leftValue - rightValue
            : rightValue - leftValue;
        return difference || left.index - right.index;
      })
      .map(({ row }) => row);
  }, [changeSort, preview, proposedOnly, query]);
  const visibleReady = visibleRows.filter(
    (row) => row.queueable && !removals.has(row.id),
  );
  const selectedVisible = visibleReady.filter((row) => selected.has(row.id));

  function chooseProfile(id: string) {
    setProfileId(id);
    window.localStorage.setItem(PROFILE_KEY, id);
    setPreview(null);
    setSelected(new Set());
    setMessage(null);
  }

  async function loadPreview(force: boolean) {
    if (activeProfile === undefined || busy !== "") return;
    setBusy(force ? "refresh" : "preview");
    setProgress(null);
    setMessage(null);
    try {
      const result = await uiApi.repricingPreview(
        {
          minimumPrice: activeProfile.minimumPrice,
          conditionPolicy: activeProfile.conditionPolicy,
          priceBasis: activeProfile.priceBasis,
          adjustmentCents: activeProfile.adjustmentCents,
          allowPriceIncreases: activeProfile.allowPriceIncreases,
          sparseMarketFallback: activeProfile.sparseMarketFallback,
          gamePricingModules: activeProfile.gamePricingModules,
          ranges: activeProfile.ranges,
        },
        force,
        setProgress,
      );
      setPreview(result);
      setSelected(
        new Set(
          result.rows.filter((row) => row.queueable).map((row) => row.id),
        ),
      );
      setRemovals(new Set());
      setRemoveConfirm(null);
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(
          cause,
          "The inventory preview could not be created.",
        ),
      });
    } finally {
      setBusy("");
    }
  }

  async function queueSelected() {
    if (preview === null || selectedVisible.length === 0 || busy !== "") return;
    setBusy("queue");
    setMessage(null);
    try {
      const result = await uiApi.queuePrices(
        preview.id,
        selectedVisible.map((row) => row.id),
      );
      setMessage({
        tone: "success",
        text: `${String(result.jobs.length)} price update${result.jobs.length === 1 ? "" : "s"} queued. Jobs are submitted one at a time.`,
      });
      toast.show(
        `${String(result.jobs.length)} price updates queued.`,
        "success",
      );
      setSelected(new Set());
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(cause, "The price changes were not queued."),
      });
    } finally {
      setBusy("");
    }
  }

  async function remove(row: PreviewRow) {
    if (preview === null || busy !== "") return;
    setBusy(`remove:${row.id}`);
    setMessage(null);
    try {
      await uiApi.queueRemoval(preview.id, row.id);
      setRemovals((current) => new Set(current).add(row.id));
      setSelected((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      setRemoveConfirm(null);
      setMessage({
        tone: "success",
        text: `${row.productName} was queued for removal. Live quantity will be checked before submission.`,
      });
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(cause, "The removal was not queued."),
      });
    } finally {
      setBusy("");
    }
  }

  const allVisibleSelected =
    visibleReady.length > 0 && selectedVisible.length === visibleReady.length;
  const snapshot =
    preview === null
      ? ""
      : `${preview.marketplaceSnapshot.source === "fresh" ? "Marketplace refreshed" : "Marketplace snapshot"} ${new Date(preview.marketplaceSnapshot.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
  return (
    <main class="page page--fixed">
      <PageHeader
        title="Inventory"
        description="Review your live listings and stage price or quantity changes."
        actions={
          <>
            <Button
              icon="refresh"
              busy={busy === "preview"}
              disabled={activeProfile === undefined || busy !== ""}
              onClick={() => void loadPreview(false)}
            >
              Update preview
            </Button>
            <Button
              tone="quiet"
              busy={busy === "refresh"}
              disabled={activeProfile === undefined || busy !== ""}
              onClick={() => void loadPreview(true)}
            >
              Refresh marketplace
            </Button>
          </>
        }
      />
      <div class="page-body inventory-layout">
        <Toolbar>
          <Field label="Pricing profile" class="profile-field">
            <select
              value={activeProfile?.id ?? ""}
              onChange={(event) => chooseProfile(event.currentTarget.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <span class="profile-summary">
            {activeProfile === undefined
              ? "No profile configured"
              : `${String(activeProfile.ranges.length)} price range${activeProfile.ranges.length === 1 ? "" : "s"} · ${activeProfile.priceBasis} pricing · ${activeProfile.allowPriceIncreases ? "increases allowed" : "decreases only"}`}
          </span>
          <span class="toolbar__spacer" />
          <span class="muted">{snapshot}</span>
        </Toolbar>
        {message === null ? null : (
          <Notice tone={message.tone}>{message.text}</Notice>
        )}
        {preview === null ? (
          <div class="data-region">
            <EmptyState
              title="Load your inventory"
              detail="Update preview reads the current inventory and prepares changes using the selected pricing profile."
            />
          </div>
        ) : (
          <>
            <div class="inventory-summary">
              <Metric
                label="Listing value"
                value={money(preview.totals.currentListingValue)}
              />
              <Metric
                label="Cards"
                value={String(preview.totals.totalQuantity)}
              />
              <Metric
                label="Listings"
                value={String(preview.totals.listingCount)}
              />
              <Metric
                label="Proposed changes"
                value={String(preview.counts.ready)}
              />
            </div>
            <Toolbar>
              <Field label="Search inventory" class="toolbar-search">
                <input
                  type="search"
                  placeholder="Card, set, condition, ID"
                  value={query}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </Field>
              <div
                class="segmented inventory-view-filter"
                role="group"
                aria-label="Inventory rows"
              >
                <button
                  type="button"
                  aria-pressed={!proposedOnly}
                  onClick={() => setProposedOnly(false)}
                >
                  All listings
                </button>
                <button
                  type="button"
                  aria-pressed={proposedOnly}
                  onClick={() => setProposedOnly(true)}
                >
                  Proposed changes ({String(preview.counts.ready)})
                </button>
              </div>
              <span class="muted">
                {visibleRows.length} of {preview.rows.length} listings
              </span>
              <span class="toolbar__spacer" />
              <Button
                tone="primary"
                busy={busy === "queue"}
                disabled={selectedVisible.length === 0 || busy !== ""}
                onClick={() => void queueSelected()}
              >
                Queue {selectedVisible.length} selected
              </Button>
            </Toolbar>
            <div class="data-region inventory-table-region">
              {visibleRows.length === 0 ? (
                <EmptyState
                  title={
                    proposedOnly && query === ""
                      ? "No price changes are proposed"
                      : "No inventory matches these filters"
                  }
                />
              ) : (
                <table class="data-table inventory-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label="Select all visible price changes"
                          checked={allVisibleSelected}
                          onChange={(event) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              for (const row of visibleReady) {
                                if (event.currentTarget.checked)
                                  next.add(row.id);
                                else next.delete(row.id);
                              }
                              return next;
                            })
                          }
                        />
                      </th>
                      <th>Card / printing</th>
                      <th>Condition</th>
                      <th class="align-right">Current</th>
                      <th class="align-right">Market</th>
                      <th class="align-right">Proposed</th>
                      <th class="align-right" aria-sort={changeSort}>
                        <button
                          type="button"
                          class="inventory-change-sort"
                          aria-label={`Sort by price change${changeSort === "none" ? "" : `, currently ${changeSort}`}`}
                          title="Sort by percentage price change"
                          onClick={() =>
                            setChangeSort((current) =>
                              current === "none"
                                ? "descending"
                                : current === "descending"
                                  ? "ascending"
                                  : "none",
                            )
                          }
                        >
                          Change
                          <span aria-hidden="true">
                            {changeSort === "descending"
                              ? "\u2193"
                              : changeSort === "ascending"
                                ? "\u2191"
                                : "\u2195"}
                          </span>
                        </button>
                      </th>
                      <th>Marketplace reference</th>
                      <th>Result</th>
                      <th>Inventory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => {
                      const change = priceChange(row);
                      return (
                        <tr
                          key={row.id}
                          class={change.large ? "is-large-price-change" : ""}
                          title={
                            change.large
                              ? "Proposed price differs from the current price by more than 10%."
                              : undefined
                          }
                        >
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.productName}`}
                              checked={selected.has(row.id)}
                              disabled={!row.queueable || removals.has(row.id)}
                              onChange={(event) =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (event.currentTarget.checked)
                                    next.add(row.id);
                                  else next.delete(row.id);
                                  return next;
                                })
                              }
                            />
                          </td>
                          <td>
                            <span class="cell-stack">
                              <strong>{row.productName}</strong>
                              <small>
                                {row.productLineName} · {row.setName}
                              </small>
                              <small>
                                {row.printing} · {row.language} · qty{" "}
                                {row.quantity}
                              </small>
                            </span>
                          </td>
                          <td>{row.condition}</td>
                          <td class="align-right numeric">
                            {money(row.currentPrice)}
                          </td>
                          <td class="align-right numeric">
                            {row.marketPrice === undefined
                              ? "—"
                              : money(row.marketPrice)}
                          </td>
                          <td class="align-right">
                            <strong
                              class={
                                row.queueable
                                  ? `price-proposed price-change--${change.direction}`
                                  : "muted"
                              }
                            >
                              {money(row.proposedPrice)}
                            </strong>
                            {row.minimumApplied ? (
                              <small class="minimum-note">
                                {row.minimumPriceSource ?? "minimum"}{" "}
                                {money(row.effectiveMinimumPrice)}
                              </small>
                            ) : null}
                          </td>
                          <td class="align-right">
                            <span
                              class={`price-change price-change--${change.direction}`}
                            >
                              <strong>{signedMoney(change.amount)}</strong>
                              <small>{signedPercent(change.percent)}</small>
                            </span>
                          </td>
                          <td class="market-reference">
                            {competitorText(row)}
                          </td>
                          <td>
                            <StatusBadge status={row.status} />
                            <p class="result-copy">{row.reason}</p>
                          </td>
                          <td>
                            {removals.has(row.id) ? (
                              <StatusBadge status="pending" />
                            ) : removeConfirm === row.id ? (
                              <div class="remove-confirm">
                                <span>Remove qty {row.quantity}?</span>
                                <Button
                                  tone="danger"
                                  busy={busy === `remove:${row.id}`}
                                  onClick={() => void remove(row)}
                                >
                                  Confirm
                                </Button>
                                <Button
                                  tone="quiet"
                                  onClick={() => setRemoveConfirm(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : row.removable ? (
                              <Button
                                tone="danger"
                                disabled={busy !== ""}
                                onClick={() => setRemoveConfirm(row.id)}
                              >
                                Remove
                              </Button>
                            ) : (
                              <span class="muted" title={row.removalReason}>
                                Unavailable
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
        {busy === "preview" || busy === "refresh" ? (
          <div class="page-overlay">
            <InventoryLoading
              refreshing={busy === "refresh"}
              profileName={activeProfile?.name ?? "the selected profile"}
              progress={progress}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}
