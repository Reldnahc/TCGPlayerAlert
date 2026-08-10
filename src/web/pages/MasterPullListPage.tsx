import { useCallback, useEffect, useState } from "preact/hooks";
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

export function MasterPullListPage() {
  const [pullList, setPullList] = useState<MasterPullList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
                        <th class="align-right pull-list-col-quantity">Qty</th>
                        <th class="pull-list-col-product">Product</th>
                        <th class="pull-list-col-set">Set / #</th>
                        <th class="pull-list-col-condition">Condition</th>
                        <th class="pull-list-col-rarity">Rarity</th>
                        <th class="pull-list-col-metadata">Color</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pullList.rows.map((row) => (
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
                            {row.metadata.length === 0 ? (
                              <span class="pull-list-metadata-empty">—</span>
                            ) : (
                              <strong class="pull-list-metadata">
                                {row.metadata
                                  .flatMap((item) => item.values)
                                  .join(" / ")}
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
