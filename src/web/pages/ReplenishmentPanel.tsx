import { useEffect, useState } from "preact/hooks";
import type { ReplenishmentSnapshot } from "../../replenishment-contracts.js";
import type { LocalInventoryItem } from "../../local-inventory-contracts.js";
import { uiApi } from "../api.js";
import { Button, Field, Notice, Spinner } from "../components/ui.js";
import { errorMessage, compactDate } from "../utils.js";

export function ReplenishmentPanel({
  item,
  initialPrice = 1,
  listingPrices = {},
  onClose,
}: {
  readonly item?: LocalInventoryItem;
  readonly initialPrice?: number;
  readonly listingPrices?: Readonly<Record<string, number>>;
  readonly onClose?: () => void;
}) {
  const [data, setData] = useState<ReplenishmentSnapshot | null>(null);
  const [target, setTarget] = useState("1");
  const [price, setPrice] = useState(String(initialPrice));
  const [reconciled, setReconciled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const rule = data?.rules.find(
    (r) => r.localInventoryId === item?.localInventoryId,
  );
  async function load() {
    setBusy(true);
    try {
      const result = await uiApi.replenishment();
      setData(result);
      const current = result.rules.find(
        (r) => r.localInventoryId === item?.localInventoryId,
      );
      if (current !== undefined) {
        setTarget(String(current.targetQuantity));
        setPrice(String(current.price));
      } else if (
        result.connectionId !== undefined &&
        listingPrices[result.connectionId] !== undefined
      ) {
        setPrice(String(listingPrices[result.connectionId]));
      }
    } catch (cause) {
      setMessage(
        errorMessage(cause, "Auto-relist settings could not be loaded."),
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(enabled: boolean) {
    if (item === undefined || busy) return;
    setBusy(true);
    setMessage("");
    try {
      setData(
        await uiApi.configureReplenishment(item.localInventoryId, {
          enabled,
          targetQuantity: Number(target),
          price: Number(price),
          reconciled,
        }),
      );
      setReconciled(false);
      setMessage(
        enabled
          ? "Auto-relisting enabled for future sales. No listing was changed now."
          : "Auto-relisting paused.",
      );
    } catch (cause) {
      setMessage(
        errorMessage(cause, "Auto-relist settings could not be saved."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Auto-relisting">
      <h2>
        {item === undefined
          ? "Auto-relist jobs"
          : `Auto-relist: ${item.displayName}`}
      </h2>
      {message === "" ? null : <Notice tone="info">{message}</Notice>}
      {data === null ? (
        busy ? (
          <Spinner label="Loading auto-relisting" />
        ) : (
          <Button onClick={() => void load()}>Retry</Button>
        )
      ) : (
        <>
          {data.connectionId === undefined ? (
            <Notice tone="warning">
              Auto-relisting is unavailable for this connection.
            </Notice>
          ) : (
            <p>
              Connection: {data.connectionId}.{" "}
              {data.workerRunning
                ? "Runs while the inventory queue is enabled."
                : "Start the service and enable the inventory queue to process replacements."}
            </p>
          )}
          {item === undefined ? (
            <>
              <Button disabled={busy} onClick={() => void load()}>
                Refresh auto-relist jobs
              </Button>
              {data.rules.length === 0 ? (
                <p>
                  No auto-relist rules configured. Enable them on selected items
                  in Inventory.
                </p>
              ) : (
                data.rules.map((entry) => (
                  <div key={entry.localInventoryId}>
                    <p>
                      <strong>{entry.displayName}</strong> � {entry.status} �{" "}
                      {entry.message}
                    </p>
                    <p>
                      {entry.tickets.length} order(s) awaiting shipment
                      verification
                    </p>
                    {entry.jobs
                      .slice()
                      .reverse()
                      .map((job) => (
                        <p key={job.id}>
                          {compactDate(job.at)} � {job.status} � quantity{" "}
                          {job.quantity} � {job.message}
                        </p>
                      ))}
                  </div>
                ))
              )}
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(true);
              }}
            >
              <p>
                Local on hand: {item.onHand} (includes publicly listed units).
                Record all reserve stock here before enabling.
              </p>
              <p>
                Replace sold units only after the marketplace confirms shipment.
                Stops at zero local stock. This limits public quantity, not
                purchases per buyer.
              </p>
              {rule === undefined ? null : (
                <p>
                  <strong>{rule.status}</strong> � {rule.message} �{" "}
                  {rule.tickets.length} order(s) waiting
                </p>
              )}
              <Field label="Public quantity limit">
                <input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  required
                  value={target}
                  disabled={busy}
                  onInput={(e) => setTarget(e.currentTarget.value)}
                />
              </Field>
              <Field label="Relisting price ($)">
                <input
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="0.01"
                  required
                  value={price}
                  disabled={busy}
                  onInput={(e) => setPrice(e.currentTarget.value)}
                />
              </Field>
              <p>
                A saved fixed-price override takes precedence. Existing live
                listings remain subject to their normal pricing profile.
              </p>
              {rule?.status === "review-required" ||
              rule?.status === "running" ? (
                <label>
                  <input
                    type="checkbox"
                    checked={reconciled}
                    onChange={(e) => setReconciled(e.currentTarget.checked)}
                  />
                  I checked the live listing and reconciled the previous
                  attempt. Discard old sale tickets and watch future sales.
                </label>
              ) : null}
              <Button
                type="submit"
                disabled={
                  busy ||
                  data.connectionId === undefined ||
                  ((rule?.status === "review-required" ||
                    rule?.status === "running") &&
                    !reconciled)
                }
              >
                Enable for future sales
              </Button>
              {rule === undefined ? null : (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(false)}
                >
                  Pause auto-relisting
                </Button>
              )}
            </form>
          )}
        </>
      )}
      {onClose === undefined ? null : (
        <Button disabled={busy} onClick={onClose}>
          Close
        </Button>
      )}
    </section>
  );
}
