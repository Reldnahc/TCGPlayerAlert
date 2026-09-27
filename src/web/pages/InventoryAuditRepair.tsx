import { useEffect, useState } from "preact/hooks";
import { uiApi } from "../api.js";
import { Button, Field, Notice, Spinner } from "../components/ui.js";
import { errorMessage, money } from "../utils.js";

export function InventoryAuditRepair({
  localId,
  connectionId,
  onClose,
  onQueued,
}: {
  readonly localId: string;
  readonly connectionId: string;
  readonly onClose: () => void;
  readonly onQueued: () => void;
}) {
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof uiApi.previewAuditRepair>
  > | null>(null);
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function review(chosenPrice?: number) {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const result = await uiApi.previewAuditRepair(
        localId,
        connectionId,
        chosenPrice,
      );
      setPreview(result);
      setPrice(result.price?.toFixed(2) ?? "");
    } catch (cause) {
      setError(errorMessage(cause, "The correction could not be reviewed."));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void review();
  }, []);
  async function queue() {
    if (preview === null || busy) return;
    setBusy(true);
    setError("");
    try {
      await uiApi.queueAuditRepair(localId, connectionId, preview.id);
      onQueued();
    } catch (cause) {
      setPreview(null);
      setError(
        errorMessage(
          cause,
          "The correction could not be queued. Refresh and review again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const reviewedPrice =
    preview?.price !== undefined &&
    price.trim() !== "" &&
    Number(price) === preview.price;
  return (
    <section aria-label="Review missing stock" class="notice">
      <h3>Review missing stock</h3>
      {busy ? <Spinner label="Checking correction" /> : null}
      {error === "" ? null : <Notice tone="danger">{error}</Notice>}
      {preview === null ? null : (
        <>
          <p>
            <strong>{preview.displayName}</strong>: {preview.listed} listed →{" "}
            {preview.target} listed. Add {preview.addQuantity}; local stock
            stays {preview.onHand}.
          </p>
          {preview.limited ? <p>Auto-relist public limit respected.</p> : null}
          {preview.reservedElsewhere > 0 ? (
            <p>
              {preview.reservedElsewhere} copies reserved on other marketplaces.
            </p>
          ) : null}
          {preview.fixedPrice ? (
            <p>Fixed price: {money(preview.price)}.</p>
          ) : (
            <Field label="Correction listing price">
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={price}
                disabled={busy}
                onInput={(event) => setPrice(event.currentTarget.value)}
              />
            </Field>
          )}
          {preview.price === undefined ? (
            <p>
              No existing listing price. Enter a price and review it before
              queueing.
            </p>
          ) : null}
          {reviewedPrice ? (
            <Button busy={busy} onClick={() => void queue()}>
              Queue +{preview.addQuantity} at {money(preview.price)}
            </Button>
          ) : (
            <Button
              busy={busy}
              disabled={!Number.isFinite(Number(price)) || Number(price) <= 0}
              onClick={() => void review(Number(price))}
            >
              Review price
            </Button>
          )}
        </>
      )}
      {preview === null && !busy ? (
        <Button onClick={() => void review()}>Review again</Button>
      ) : null}
      <Button disabled={busy} onClick={onClose}>
        Close correction
      </Button>
    </section>
  );
}
