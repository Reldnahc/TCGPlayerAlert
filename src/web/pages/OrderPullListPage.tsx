import { useCallback, useEffect, useState } from "preact/hooks";
import { orderDetailUrl, uiApi } from "../api.js";
import { Icon } from "../components/Icon.js";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
} from "../components/ui.js";
import type { OrderPullList } from "../contracts.js";
import { dateTime, errorMessage } from "../utils.js";

export function OrderPullListPage({
  orderNumber,
}: {
  readonly orderNumber: string;
}) {
  const [pullList, setPullList] = useState<OrderPullList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (force = false, signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        setPullList(await uiApi.pullList(orderNumber, force, signal));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setError(errorMessage(cause, "The pull list could not be loaded."));
      } finally {
        if (signal?.aborted !== true) setLoading(false);
      }
    },
    [orderNumber],
  );

  useEffect(() => {
    const controller = new AbortController();
    setPullList(null);
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main class="page pull-list-page">
      <PageHeader
        title="Pull list"
        description={`Order ${orderNumber}`}
        actions={
          <>
            <a class="button button--quiet" href={orderDetailUrl(orderNumber)}>
              <Icon name="chevron-left" size={16} />
              <span>Order details</span>
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
            <strong>Pull list could not be loaded</strong>
            <span>{error}</span>
            <Button tone="secondary" onClick={() => void load(true)}>
              Try again
            </Button>
          </Notice>
        )}
        {loading && pullList === null ? (
          <div class="pull-list-loading">
            <Spinner label="Loading pull list" />
          </div>
        ) : pullList === null ? null : (
          <>
            {pullList.metadataIssue === undefined ? null : (
              <Notice tone="warning">{pullList.metadataIssue}</Notice>
            )}
            <section class="surface pull-list-summary">
              <div>
                <span>Order</span>
                <strong>{pullList.orderNumber}</strong>
              </div>
              <div>
                <span>Cards to pull</span>
                <strong>{String(pullList.totalQuantity)}</strong>
              </div>
              <div>
                <span>Product lines</span>
                <strong>{String(pullList.rows.length)}</strong>
              </div>
              <div>
                <span>Loaded</span>
                <strong>{dateTime(pullList.fetchedAt)}</strong>
              </div>
            </section>
            <section class="surface pull-list-sheet">
              <header class="surface__header pull-list-sheet__header">
                <div>
                  <strong>Items</strong>
                  <p>Pull the order quantity shown for each exact printing.</p>
                </div>
              </header>
              {pullList.rows.length === 0 ? (
                <EmptyState title="No products were returned for this order" />
              ) : (
                <div class="data-region data-region--embedded pull-list-region">
                  <table class="data-table pull-list-table">
                    <thead>
                      <tr>
                        <th class="pull-list-col-check">
                          <span class="visually-hidden">Pulled</span>
                        </th>
                        <th class="align-right pull-list-col-quantity">Qty</th>
                        <th>Product</th>
                        <th>Set / number</th>
                        <th>Condition</th>
                        <th>Rarity</th>
                        <th>Metadata</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pullList.rows.map((row, index) => (
                        <tr key={`${row.skuId}:${String(index)}`}>
                          <td class="pull-list-col-check">
                            <span class="pull-list-check" aria-hidden="true" />
                          </td>
                          <td class="align-right numeric pull-list-quantity">
                            {String(row.orderQuantity)}
                          </td>
                          <td>
                            <div class="cell-stack pull-list-product">
                              <strong>{row.productName}</strong>
                              <small>{row.productLine}</small>
                            </div>
                          </td>
                          <td>
                            <div class="cell-stack">
                              <strong>{row.setName}</strong>
                              {row.number === "" ? null : (
                                <small>#{row.number}</small>
                              )}
                            </div>
                          </td>
                          <td>{row.condition}</td>
                          <td>{row.rarity === "" ? "—" : row.rarity}</td>
                          <td>
                            {row.metadata.length === 0 ? (
                              <span class="pull-list-metadata-empty">—</span>
                            ) : (
                              <div class="pull-list-metadata">
                                {row.metadata.map((item) => (
                                  <span key={item.label}>
                                    <small>{item.label}</small>
                                    <strong>{item.values.join(" / ")}</strong>
                                  </span>
                                ))}
                              </div>
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
