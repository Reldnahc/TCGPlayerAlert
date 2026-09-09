import { useEffect, useMemo, useState } from "preact/hooks";
import type { LocalInventoryItem } from "../../local-inventory-contracts.js";
import type { MarketplaceInventoryObservation } from "../../local-inventory-workspace.js";
import type { InventoryItem } from "../../marketplaces/contracts.js";
import type {
  InventoryList,
  LocalInventoryImportPreview,
} from "../contracts.js";
import { uiApi } from "../api.js";
import {
  Button,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Spinner,
} from "../components/ui.js";
import { errorMessage, money, normalizedTokens } from "../utils.js";

export function LocalInventoryPage() {
  const [view, setView] = useState<"local" | "marketplace">("local");
  const [data, setData] = useState<InventoryList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [importPreview, setImportPreview] =
    useState<LocalInventoryImportPreview | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [search, setSearch] = useState("");
  const [listingFilter, setListingFilter] = useState<
    "all" | "unlisted" | "listed"
  >("all");

  async function load() {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      setData(await uiApi.inventory());
    } catch (cause) {
      setError(errorMessage(cause, "Inventory could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function reviewImport() {
    if (importBusy) return;
    setImportBusy(true);
    setImportMessage("");
    try {
      setImportPreview(await uiApi.localInventoryImportPreview());
    } catch (cause) {
      setImportMessage(
        errorMessage(cause, "Marketplace stock could not be reviewed."),
      );
    } finally {
      setImportBusy(false);
    }
  }

  function openImport() {
    setImportOpen(true);
    setImportPreview(null);
    setImportMessage("");
    void reviewImport();
  }

  async function confirmImport() {
    if (importBusy || importPreview?.candidates.length === 0) return;
    setImportBusy(true);
    setImportMessage("");
    try {
      const result = await uiApi.importMarketplaceInventory();
      setImportMessage(
        `Imported ${String(result.createdCount)} local stock item${result.createdCount === 1 ? "" : "s"}. No marketplace was changed.`,
      );
      setImportPreview(null);
      setImportOpen(false);
      await load();
    } catch (cause) {
      setImportMessage(
        errorMessage(cause, "Marketplace stock could not be imported."),
      );
    } finally {
      setImportBusy(false);
    }
  }

  const listingsByLocalId = useMemo(() => {
    const grouped = new Map<string, MarketplaceInventoryObservation[]>();
    for (const listing of data?.listings ?? []) {
      if (listing.localInventoryId === undefined) continue;
      const current = grouped.get(listing.localInventoryId) ?? [];
      current.push(listing);
      grouped.set(listing.localInventoryId, current);
    }
    return grouped;
  }, [data]);

  const localItems = useMemo(() => {
    const tokens = normalizedTokens(search);
    return (data?.items ?? []).filter((item) => {
      const listings = listingsByLocalId.get(item.localInventoryId) ?? [];
      if (listingFilter === "listed" && listings.length === 0) return false;
      if (listingFilter === "unlisted" && listings.length > 0) return false;
      return matchesSearch(
        [item.displayName, ...Object.values(item.attributes)],
        tokens,
      );
    });
  }, [data, listingFilter, listingsByLocalId, search]);

  const observedListings = useMemo(() => {
    const tokens = normalizedTokens(search);
    return (data?.listings ?? []).filter((listing) =>
      matchesSearch(
        [
          listing.descriptor.connectionLabel,
          listing.item.displayName,
          ...Object.values(listing.item.attributes),
        ],
        tokens,
      ),
    );
  }, [data, search]);

  return (
    <main class="page">
      <PageHeader
        title="Inventory"
        description="Local stock is authoritative; marketplace listings are read-only observations"
        actions={
          <Button busy={loading} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      <div class="page-body inventory-layout">
        <Notice tone="info">
          Changes here update local on-hand stock only. They do not list,
          cross-post, or change quantities on any marketplace.
        </Notice>
        <div class="inventory-tabs-bar">
          <div
            class="segmented inventory-tabs"
            role="tablist"
            aria-label="Inventory lists"
          >
            <button
              type="button"
              id="inventory-tab-local"
              role="tab"
              aria-selected={view === "local"}
              aria-controls="local-stock-panel"
              onClick={() => setView("local")}
            >
              Local stock <span>{data?.items.length ?? 0}</span>
            </button>
            <button
              type="button"
              id="inventory-tab-marketplace"
              role="tab"
              aria-selected={view === "marketplace"}
              aria-controls="marketplace-listings-panel"
              onClick={() => setView("marketplace")}
            >
              Marketplace listings <span>{data?.listings.length ?? 0}</span>
            </button>
          </div>
        </div>
        {error === "" ? null : <Notice tone="danger">{error}</Notice>}
        {data?.issues.map((issue) => (
          <Notice key={`${issue.connectionId}:${issue.code}`} tone="warning">
            {issue.connectionId} inventory is unavailable ({issue.code}). Local
            stock is still available.
          </Notice>
        ))}
        <div class="toolbar">
          {view === "local" ? (
            <Field label="Listing status">
              <select
                value={listingFilter}
                onChange={(event) =>
                  setListingFilter(
                    event.currentTarget.value as "all" | "unlisted" | "listed",
                  )
                }
              >
                <option value="all">All local stock</option>
                <option value="unlisted">No matched listing</option>
                <option value="listed">Matched listing</option>
              </select>
            </Field>
          ) : null}
          <Field label="Search inventory">
            <input
              type="search"
              value={search}
              placeholder="Name, set, condition, language…"
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </Field>
          {view === "marketplace" ? (
            <Button tone="quiet" busy={importBusy} onClick={openImport}>
              Import marketplace stock
            </Button>
          ) : null}
        </div>
        {importOpen || importMessage === "" ? null : (
          <Notice>{importMessage}</Notice>
        )}
        {view === "local" ? (
          <section
            id="local-stock-panel"
            role="tabpanel"
            aria-labelledby="inventory-tab-local"
            class="inventory-list-panel"
          >
            <h2>Local stock</h2>
            {loading && data === null ? (
              <Spinner label="Loading local inventory" />
            ) : data !== null && localItems.length === 0 ? (
              <EmptyState
                title={
                  search.trim() === "" && listingFilter === "all"
                    ? "No local inventory yet"
                    : "No local inventory matches these filters"
                }
                detail="Use Add cards to record stock. A marketplace listing is not required."
              />
            ) : (
              <div class="data-region inventory-table-region local-inventory-table-region">
                <table class="data-table local-inventory-table local-stock-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Variant</th>
                      <th>On hand</th>
                      <th>Observed listings</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {localItems.map((item) => (
                      <LocalInventoryRow
                        key={item.localInventoryId}
                        item={item}
                        listings={
                          listingsByLocalId.get(item.localInventoryId) ?? []
                        }
                        onSaved={load}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
        {view === "marketplace" ? (
          <section
            id="marketplace-listings-panel"
            role="tabpanel"
            aria-labelledby="inventory-tab-marketplace"
            class="inventory-list-panel"
          >
            <h2>Marketplace observations</h2>
            <p>
              These quantities are reported by providers and do not overwrite
              local stock.
            </p>
            {loading && data === null ? (
              <Spinner label="Loading marketplace listings" />
            ) : data !== null && observedListings.length === 0 ? (
              <EmptyState
                title="No marketplace listings observed"
                detail="Unlisted local stock remains fully usable."
              />
            ) : (
              <div class="data-region inventory-table-region local-inventory-table-region">
                <table class="data-table local-inventory-table marketplace-listings-table">
                  <thead>
                    <tr>
                      <th>Connection</th>
                      <th>Item</th>
                      <th>Variant</th>
                      <th>Listed quantity</th>
                      <th>Price</th>
                      <th>Local match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observedListings.map((listing) => (
                      <tr
                        key={`${listing.descriptor.connectionId}/${listing.item.inventoryKey}`}
                      >
                        <td>
                          <strong>{listing.descriptor.connectionLabel}</strong>
                          <small>{listing.descriptor.connectionId}</small>
                        </td>
                        <td>
                          <strong>{listing.item.displayName}</strong>
                        </td>
                        <td>{variantLabel(listing.item)}</td>
                        <td>{listing.item.quantity}</td>
                        <td>{money(listing.item.price)}</td>
                        <td>
                          {listing.localInventoryId === undefined
                            ? "Unmatched"
                            : "Matched"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </div>
      {importOpen ? (
        <div class="dialog-backdrop" role="presentation">
          <div
            class="dialog inventory-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="inventory-import-title"
          >
            <div class="dialog__header">
              <div>
                <h2 id="inventory-import-title">Import marketplace stock</h2>
                <small>One-time setup tool</small>
              </div>
              <Button
                tone="quiet"
                disabled={importBusy}
                onClick={() => setImportOpen(false)}
              >
                Close
              </Button>
            </div>
            <div class="dialog__body inventory-import-dialog__body">
              <p>
                Review unlinked marketplace listings before initializing local
                stock. Cross-listed quantities use the highest observed value;
                existing local quantities are preserved.
              </p>
              {importPreview === null ? (
                importBusy ? (
                  <Spinner label="Reviewing marketplace stock" />
                ) : (
                  <>
                    {importMessage === "" ? null : (
                      <Notice tone="danger">{importMessage}</Notice>
                    )}
                    <Button onClick={() => void reviewImport()}>
                      Try again
                    </Button>
                  </>
                )
              ) : (
                <>
                  <p>
                    {importPreview.candidates.length} item
                    {importPreview.candidates.length === 1 ? "" : "s"} ready to
                    import; {importPreview.alreadyLinkedCount} already linked.
                  </p>
                  {importPreview.issues.map((issue) => (
                    <Notice
                      key={`import:${issue.connectionId}:${issue.code}`}
                      tone="warning"
                    >
                      {issue.connectionId} could not be included ({issue.code}).
                    </Notice>
                  ))}
                  {importPreview.skippedWithoutExactIdentityCount ===
                  0 ? null : (
                    <Notice tone="warning">
                      {importPreview.skippedWithoutExactIdentityCount} positive
                      listing
                      {importPreview.skippedWithoutExactIdentityCount === 1
                        ? " was"
                        : "s were"}{" "}
                      skipped because no exact variant identity was available.
                    </Notice>
                  )}
                  {importPreview.conflictingIdentityCount === 0 ? null : (
                    <Notice tone="warning">
                      {importPreview.conflictingIdentityCount} identity group
                      {importPreview.conflictingIdentityCount === 1
                        ? " was"
                        : "s were"}{" "}
                      skipped because it mapped to conflicting local items.
                    </Notice>
                  )}
                  {importPreview.candidates.length === 0 ? (
                    <EmptyState
                      title="No missing marketplace stock"
                      detail="Every eligible exact listing is already linked or has zero quantity."
                    />
                  ) : (
                    <div class="data-region inventory-import-table-region">
                      <table class="data-table local-inventory-table inventory-import-table">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th>Import quantity</th>
                            <th>Observed quantities</th>
                            <th>Safety</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importPreview.candidates.map((candidate) => (
                            <tr key={candidate.candidateKey}>
                              <td>
                                <strong>{candidate.displayName}</strong>
                                <small>
                                  {attributeVariantLabel(candidate.attributes)}
                                </small>
                              </td>
                              <td>{candidate.suggestedOnHand}</td>
                              <td>
                                {candidate.observations
                                  .map(
                                    (observation) =>
                                      `${observation.connectionLabel}: ${String(observation.quantity)}`,
                                  )
                                  .join(" · ")}
                              </td>
                              <td>
                                {candidate.crossListed
                                  ? "Cross-listed; using highest quantity"
                                  : "Single connection"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
            <div class="dialog__footer">
              <Button
                disabled={importBusy}
                onClick={() => setImportOpen(false)}
              >
                Cancel
              </Button>
              {importPreview === null ? null : (
                <Button
                  tone="primary"
                  busy={importBusy}
                  disabled={importPreview.candidates.length === 0}
                  onClick={() => void confirmImport()}
                >
                  Import missing stock
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function LocalInventoryRow({
  item,
  listings,
  onSaved,
}: {
  readonly item: LocalInventoryItem;
  readonly listings: readonly MarketplaceInventoryObservation[];
  readonly onSaved: () => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(item.onHand));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const connectionCount = new Set(
    listings.map((listing) => listing.descriptor.connectionId),
  ).size;

  async function save(event: Event) {
    event.preventDefault();
    const parsed = Number(quantity);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      setMessage("Enter a non-negative whole-number quantity.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await uiApi.setLocalInventoryQuantity(item.localInventoryId, parsed);
      setMessage("Local stock saved.");
      await onSaved();
    } catch (cause) {
      setMessage(errorMessage(cause, "Local stock could not be updated."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <strong>{item.displayName}</strong>
        <small>{item.attributes.productLine}</small>
      </td>
      <td>{localVariantLabel(item)}</td>
      <td>
        <input
          aria-label={`Local on-hand quantity for ${item.displayName}`}
          type="number"
          min="0"
          step="1"
          disabled={busy}
          value={quantity}
          onInput={(event) => setQuantity(event.currentTarget.value)}
        />
      </td>
      <td>
        {listings.length === 0
          ? "Not listed"
          : listings
              .map(
                (listing) =>
                  `${listing.descriptor.connectionLabel}: ${String(listing.item.quantity)}`,
              )
              .join(" · ")}
        {connectionCount > 1 ? (
          <small class="text-warning">
            Cross-listed on {connectionCount} connections; overselling is
            possible.
          </small>
        ) : null}
      </td>
      <td>
        <form onSubmit={(event) => void save(event)}>
          <Button type="submit" busy={busy}>
            Save local
          </Button>
          {message === "" ? null : <small>{message}</small>}
        </form>
      </td>
    </tr>
  );
}

function matchesSearch(
  values: readonly string[],
  tokens: readonly string[],
): boolean {
  const haystack = values.join(" ").toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function localVariantLabel(item: LocalInventoryItem): string {
  return attributeVariantLabel(item.attributes);
}

function variantLabel(item: InventoryItem): string {
  return attributeVariantLabel(item.attributes);
}

function attributeVariantLabel(
  attributes: Readonly<Record<string, string>>,
): string {
  return [
    attributes.set,
    attributes.number,
    attributes.condition,
    attributes.printing ?? attributes.finish,
    attributes.language,
    attributes.channel,
  ]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" · ");
}
