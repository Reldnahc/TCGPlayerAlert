import { useEffect, useState } from "preact/hooks";
import type { InventoryList } from "../contracts.js";
import type { ReplenishmentSnapshot } from "../../replenishment-contracts.js";
import { uiApi } from "../api.js";
import { Button, Field, Notice, Spinner } from "../components/ui.js";
import { useMarketplaceConnections } from "../state/MarketplaceConnectionsContext.js";
import { compactDate, errorMessage, normalizedTokens } from "../utils.js";

export function InventoryAudit({ onClose }: { readonly onClose: () => void }) {
  const { snapshot } = useMarketplaceConnections();
  const connections =
    snapshot?.connections.filter(
      (connection) =>
        connection.enabled &&
        connection.supportedFacets.includes("inventory-reader"),
    ) ?? [];
  const [selected, setSelected] = useState("");
  const connectionId = selected || connections[0]?.descriptor.connectionId;
  const [data, setData] = useState<InventoryList | null>(null);
  const [replenishment, setReplenishment] =
    useState<ReplenishmentSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  async function run() {
    setBusy(true);
    setData(null);
    setError("");
    try {
      const [inventory, rules] = await Promise.all([
        uiApi.inventory(),
        uiApi.replenishment(),
      ]);
      setData(inventory);
      setReplenishment(rules);
    } catch (cause) {
      setError(
        errorMessage(cause, "The inventory audit could not be completed."),
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run();
  }, []);

  const unavailable =
    data?.issues.some((issue) => issue.connectionId === connectionId) === true;
  const tokens = normalizedTokens(search);
  const rows =
    connectionId === undefined || unavailable
      ? []
      : (data?.items ?? []).flatMap((item) => {
          const listings =
            data?.listings.filter(
              (listing) =>
                listing.localInventoryId === item.localInventoryId &&
                listing.descriptor.connectionId === connectionId,
            ) ?? [];
          const listed = listings.reduce(
            (total, listing) => total + listing.item.quantity,
            0,
          );
          const missing = Math.max(0, item.onHand - listed);
          const haystack = [item.displayName, ...Object.values(item.attributes)]
            .join(" ")
            .toLocaleLowerCase();
          if (
            missing === 0 ||
            !tokens.every((token) => haystack.includes(token))
          )
            return [];
          const rule = replenishment?.rules.find(
            (candidate) =>
              candidate.enabled &&
              candidate.connectionId === connectionId &&
              candidate.localInventoryId === item.localInventoryId,
          );
          return [
            { item, listed, missing, matched: listings.length > 0, rule },
          ];
        });

  return (
    <div class="dialog-backdrop">
      <div
        class="dialog inventory-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inventory-audit-title"
      >
        <div class="dialog__header">
          <h2 id="inventory-audit-title">Audit listing quantities</h2>
          <Button onClick={onClose}>Close</Button>
        </div>
        <div class="dialog__body inventory-import-dialog__body">
          <p>
            Compare local on-hand stock with fresh marketplace observations.
            This audit does not change stock or listings. Differences can
            reflect pending jobs, sales, intentional reserves, or unmatched
            variants.
          </p>
          <Field label="Audit marketplace">
            <select
              value={connectionId ?? ""}
              onChange={(event) => setSelected(event.currentTarget.value)}
            >
              {connections.map((connection) => (
                <option
                  key={connection.descriptor.connectionId}
                  value={connection.descriptor.connectionId}
                >
                  {connection.descriptor.connectionLabel}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search audit">
            <input
              type="search"
              value={search}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </Field>
          {error === "" ? null : <Notice tone="danger">{error}</Notice>}
          {busy ? <Spinner label="Auditing listing quantities" /> : null}
          {connectionId === undefined ? (
            <Notice tone="warning">
              No enabled inventory connection is available.
            </Notice>
          ) : null}
          {unavailable ? (
            <Notice tone="warning">
              This marketplace could not be read. Its listing quantities are
              unknown; refresh to try again.
            </Notice>
          ) : null}
          {data === null || unavailable || connectionId === undefined ? null : (
            <>
              <p>
                {rows.length} item{rows.length === 1 ? "" : "s"} below local
                stock{search === "" ? "" : " matching search"}. Observed{" "}
                {compactDate(data.completedAt)}.
              </p>
              <div class="data-region inventory-import-table-region">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Item / variant</th>
                      <th>Local</th>
                      <th>Listed</th>
                      <th>Difference</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ item, listed, missing, matched, rule }) => (
                      <tr key={item.localInventoryId}>
                        <td>
                          <strong>{item.displayName}</strong>
                          <small>
                            {Object.values(item.attributes).join(" · ")}
                          </small>
                        </td>
                        <td>{item.onHand}</td>
                        <td>{listed}</td>
                        <td>{missing}</td>
                        <td>
                          {rule === undefined
                            ? matched
                              ? "Partially listed"
                              : "No exact matched listing; verify variant"
                            : `Auto-relist enabled: public target ${String(rule.targetQuantity)}; reserve may be intentional`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div class="dialog__footer">
          <Button busy={busy} onClick={() => void run()}>
            Refresh audit
          </Button>
        </div>
      </div>
    </div>
  );
}
