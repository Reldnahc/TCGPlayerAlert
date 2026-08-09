import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  ShipmentScannerStatus,
  ShipmentScanResult,
} from "../contracts.js";
import { uiApi } from "../api.js";
import { useAprilTagScanner } from "../useAprilTagScanner.js";
import {
  Button,
  Field,
  Notice,
  PageHeader,
  Spinner,
  StatusBadge,
} from "../components/ui.js";
import { errorMessage } from "../utils.js";
import { useSettings } from "../state/SettingsContext.js";

export function ShipmentScannerPage() {
  const { settings } = useSettings();
  const [status, setStatus] = useState<ShipmentScannerStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [result, setResult] = useState<ShipmentScanResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);

  async function loadStatus() {
    try {
      setStatus(await uiApi.shipmentScannerStatus());
      setStatusError("");
    } catch (cause) {
      setStatusError(
        errorMessage(cause, "Shipment scanner status could not be loaded."),
      );
    }
  }

  useEffect(() => {
    void loadStatus();
  }, [settings?.revision]);

  const knownTagIds = useMemo(
    () => new Set(status?.readyTagIds ?? []),
    [status],
  );

  async function resolveTag(tagId: number) {
    if (processingRef.current) {
      throw new Error("Wait for the current parcel to finish processing.");
    }
    processingRef.current = true;
    setProcessing(true);
    setResult(null);
    try {
      const next = await uiApi.scanShipmentTag(tagId);
      setResult(next);
      playScanCue(next, status?.soundEnabled === true);
      await loadStatus();
    } catch (cause) {
      playFailureCue(status?.soundEnabled === true);
      throw cause;
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  }

  const scanner = useAprilTagScanner({
    knownTagIds,
    onConfirmed: resolveTag,
  });

  async function markMatchedOrder(
    matched: Extract<ShipmentScanResult, { readonly state: "matched" }>,
  ) {
    if (processingRef.current) return;
    processingRef.current = true;
    setProcessing(true);
    scanner.setScanError("");
    try {
      const next = await uiApi.markScannedShipment(
        matched.tagId,
        matched.order.orderNumber,
      );
      setResult(next);
      playScanCue(next, status?.soundEnabled === true);
      await loadStatus();
    } catch (cause) {
      scanner.setScanError(
        errorMessage(cause, "The matched order could not be marked shipped."),
      );
      playFailureCue(status?.soundEnabled === true);
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  }

  const enabled = status?.enabled === true;
  const cameraStatus = processing
    ? "Checking the authoritative ready-order queue"
    : scanner.cameraConsensus.tagId !== null
      ? `Confirming tag ${String(scanner.cameraConsensus.tagId)} - ${String(scanner.cameraConsensus.matchingReads)}/${String(scanner.cameraConsensus.requiredReads)}`
      : scanner.cameraLatchedTagId !== null
        ? `Processed tag ${String(scanner.cameraLatchedTagId)} - remove parcel`
        : result === null
          ? "Looking for a shipment tag"
          : "Ready for the next parcel";

  return (
    <main class="page scan-lab-page">
      <PageHeader
        title="Shipment scanner"
        description="Match tagged parcels to the authoritative ready-to-ship queue"
        actions={
          status === null ? undefined : (
            <StatusBadge
              status={
                status.automaticallyMarkShipped
                  ? "Automatic shipping"
                  : status.enabled
                    ? "Review before shipping"
                    : "Disabled"
              }
            />
          )
        }
      />
      <div class="page-body scan-lab-body">
        {statusError === "" ? null : (
          <Notice tone="danger">
            <strong>Scanner unavailable</strong>
            <span>{statusError}</span>
          </Notice>
        )}
        {status === null && statusError === "" ? (
          <Spinner label="Loading scanner" />
        ) : null}
        {status !== null && !status.enabled ? (
          <Notice tone="warning">
            <strong>Shipment scanning is disabled</strong>
            <span>
              Enable shipment tags under Settings → Scanning, save, then print
              new order labels.
            </span>
          </Notice>
        ) : null}
        {status !== null ? (
          <div class="scanner-summary" aria-label="Shipment scanner status">
            <div>
              <span>Ready orders</span>
              <strong>{String(status.readyOrderCount)}</strong>
            </div>
            <div>
              <span>Known tags</span>
              <strong>{String(status.readyTagIds.length)}</strong>
            </div>
            <div>
              <span>Tag conflicts</span>
              <strong>{String(status.conflictingTagCount)}</strong>
            </div>
            <div>
              <span>Needs review</span>
              <strong>{String(status.reviewRequiredCount)}</strong>
            </div>
            <div>
              <span>Seller requests</span>
              <strong>On confirmed scan</strong>
            </div>
          </div>
        ) : null}
        {status?.conflictingTagCount === 0 ? null : (
          <Notice tone="warning">
            <strong>Some ready orders share a tag</strong>
            <span>
              Those parcels will stop for review instead of choosing an order.
            </span>
          </Notice>
        )}

        <div class="scan-lab-grid scanner-grid">
          <section class="surface scan-lab-panel">
            <div class="surface__header">
              <div>
                <h2>Basket camera</h2>
                <p>One parcel at a time; five matching reads are required.</p>
              </div>
            </div>
            <div class="surface__body scan-lab-panel__body">
              <div
                class={`camera-stage${scanner.cameraActive ? " is-active" : ""}`}
              >
                <video ref={scanner.videoRef} muted playsInline />
                {scanner.cameraActive ? (
                  <span>{cameraStatus}</span>
                ) : (
                  <div>
                    <strong>Camera is off</strong>
                    <span>It starts only when you request it.</span>
                  </div>
                )}
              </div>
              <div class="scan-lab-actions">
                {scanner.cameraActive ? (
                  <Button tone="danger" onClick={scanner.stopCamera}>
                    Stop camera
                  </Button>
                ) : (
                  <Button
                    tone="primary"
                    disabled={!enabled}
                    onClick={() => void scanner.startCamera()}
                  >
                    Start camera
                  </Button>
                )}
                <Field
                  label="Scan an image"
                  hint="PNG, JPEG, or WebP up to 10 MB"
                >
                  <input
                    type="file"
                    disabled={!enabled || scanner.scanningImage}
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file !== undefined) void scanner.scanFile(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </Field>
              </div>
              <canvas ref={scanner.workCanvasRef} class="scan-work-canvas" />
            </div>
          </section>

          <section class="surface scan-result scanner-result">
            <div class="surface__header">
              <div>
                <h2>Parcel result</h2>
                <p>
                  A confirmed tag causes one authoritative ready-order refresh.
                </p>
              </div>
            </div>
            <div class="surface__body">
              {scanner.scanError !== "" ? (
                <Notice tone="danger">{scanner.scanError}</Notice>
              ) : processing ? (
                <Spinner label="Resolving parcel" />
              ) : result === null ? (
                <div class="scan-result__idle">
                  <strong>Waiting for a parcel</strong>
                  <span>
                    The camera does not make seller requests per frame.
                  </span>
                </div>
              ) : (
                <ShipmentResolution
                  result={result}
                  automatic={status?.automaticallyMarkShipped === true}
                  busy={processing}
                  onMarkShipped={() => {
                    if (result.state === "matched") {
                      void markMatchedOrder(result);
                    }
                  }}
                />
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function ShipmentResolution({
  result,
  automatic,
  busy,
  onMarkShipped,
}: {
  readonly result: ShipmentScanResult;
  readonly automatic: boolean;
  readonly busy: boolean;
  readonly onMarkShipped: () => void;
}) {
  if (result.state === "matched") {
    return (
      <Notice tone="warning">
        <strong>Exact ready-order match</strong>
        <span>
          {result.order.buyerName} · order {result.order.orderNumber}
        </span>
        <span>{result.order.shippingType}</span>
        <Button tone="primary" busy={busy} onClick={onMarkShipped}>
          Mark shipped
        </Button>
      </Notice>
    );
  }
  if (result.state === "shipped") {
    return (
      <Notice tone="success">
        <strong>Order marked shipped</strong>
        <span>
          {result.order.buyerName} · order {result.order.orderNumber}
        </span>
        <span>
          {automatic ? "Automatic exact-match workflow" : "Operator approved"}
        </span>
      </Notice>
    );
  }
  if (result.state === "already-processed") {
    return (
      <Notice tone="success">
        <strong>Already processed</strong>
        <span>Order {result.orderNumber} was not submitted again.</span>
      </Notice>
    );
  }
  if (result.state === "ambiguous") {
    return (
      <Notice tone="danger">
        <strong>Multiple ready orders matched</strong>
        <span>
          {String(result.matchCount)} orders share tag {String(result.tagId)}.
          Mark this parcel manually.
        </span>
      </Notice>
    );
  }
  if (result.state === "review-required") {
    return (
      <Notice tone="danger">
        <strong>Shipment requires review</strong>
        <span>
          The result for order {result.orderNumber} was uncertain and will not
          be retried automatically.
        </span>
      </Notice>
    );
  }
  return (
    <Notice tone="danger">
      <strong>No ready order matched</strong>
      <span>Tag {String(result.tagId)} did not identify a ready order.</span>
    </Notice>
  );
}

function playScanCue(result: ShipmentScanResult, enabled: boolean): void {
  if (!enabled) return;
  if (
    result.state === "shipped" ||
    result.state === "already-processed" ||
    result.state === "matched"
  ) {
    playTone(880, 0.12);
  } else {
    playTone(190, 0.25);
  }
}

function playFailureCue(enabled: boolean): void {
  if (enabled) playTone(190, 0.25);
}

function playTone(frequency: number, durationSeconds: number): void {
  const Constructor = Reflect.get(window, "AudioContext");
  if (typeof Constructor !== "function") return;
  try {
    const context = new (Constructor as new () => AudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      context.currentTime + durationSeconds,
    );
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + durationSeconds);
    oscillator.addEventListener("ended", () => void context.close(), {
      once: true,
    });
  } catch {
    // Sound is a secondary cue; visual resolution remains authoritative.
  }
}
