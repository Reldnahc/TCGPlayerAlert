import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ShipmentScannerStatus,
  ShipmentScanResult,
} from "../contracts.js";
import { uiApi } from "../api.js";
import { OrderNumberLink } from "../components/OrderNumberLink.js";
import { useAprilTagImageScanner } from "../useAprilTagImageScanner.js";
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

const STATUS_REFRESH_MILLISECONDS = 1_000;

export function ShipmentScannerPage() {
  const { settings } = useSettings();
  const [status, setStatus] = useState<ShipmentScannerStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [manualResult, setManualResult] = useState<ShipmentScanResult | null>(
    null,
  );
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
    const timer = window.setInterval(
      () => void loadStatus(),
      STATUS_REFRESH_MILLISECONDS,
    );
    return () => window.clearInterval(timer);
  }, [settings?.revision]);

  async function resolveTag(tagId: number) {
    if (processingRef.current) {
      throw new Error("Wait for the current parcel to finish processing.");
    }
    processingRef.current = true;
    setProcessing(true);
    setManualResult(null);
    try {
      const next = await uiApi.scanShipmentTag(tagId);
      setManualResult(next);
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

  const imageScanner = useAprilTagImageScanner({ onConfirmed: resolveTag });

  async function markMatchedOrder(
    matched: Extract<ShipmentScanResult, { readonly state: "matched" }>,
  ) {
    if (processingRef.current) return;
    processingRef.current = true;
    setProcessing(true);
    imageScanner.setScanError("");
    try {
      const next = await uiApi.markScannedShipment(
        matched.tagId,
        matched.order.orderNumber,
      );
      setManualResult(next);
      playScanCue(next, status?.soundEnabled === true);
      await loadStatus();
    } catch (cause) {
      imageScanner.setScanError(
        errorMessage(cause, "The matched order could not be marked shipped."),
      );
      playFailureCue(status?.soundEnabled === true);
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  }

  const enabled = status?.enabled === true;
  const camera = status?.backgroundCamera;
  const result = manualResult ?? camera?.lastResult ?? null;
  const selectedCamera =
    settings?.installedCameras.find(
      (candidate) => candidate.id === camera?.deviceId,
    )?.label ?? (camera?.deviceId === "" ? "System default" : camera?.deviceId);
  const cameraMessage = backgroundCameraMessage(status);
  const previewFrameUrl =
    camera?.previewFrameAt === undefined
      ? undefined
      : `/api/shipment-scanner/camera-frame?frame=${encodeURIComponent(camera.previewFrameAt)}`;

  return (
    <main class="page scanner-page">
      <PageHeader
        title="Shipment scanner"
        description="The app service watches the basket even when this page is closed"
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
      <div class="page-body scanner-body">
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
              <span>Camera</span>
              <strong>{cameraStateLabel(status.backgroundCamera.state)}</strong>
            </div>
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

        <div class="scanner-grid">
          <section class="surface scanner-panel">
            <div class="surface__header">
              <div>
                <h2>Basket camera</h2>
                <p>
                  Owned by the app service; five matching reads are required.
                </p>
              </div>
            </div>
            <div class="surface__body scanner-panel__body">
              <div
                class={`camera-stage camera-stage--service${camera?.state === "running" ? " is-active" : ""}${previewFrameUrl === undefined ? "" : " has-preview"}`}
              >
                {previewFrameUrl === undefined ? null : (
                  <img
                    class="camera-stage__preview"
                    src={previewFrameUrl}
                    alt="Live basket camera preview"
                    draggable={false}
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                    onLoad={(event) => {
                      event.currentTarget.hidden = false;
                    }}
                  />
                )}
                <div class="camera-stage__status">
                  <strong>{cameraMessage.title}</strong>
                  <span>{cameraMessage.detail}</span>
                  {selectedCamera === undefined ? null : (
                    <span>{selectedCamera}</span>
                  )}
                </div>
              </div>
              {camera?.issue === undefined ? null : (
                <Notice tone="danger">{camera.issue}</Notice>
              )}
              <div class="scanner-actions">
                <a class="button button--secondary" href="#settings">
                  Camera settings
                </a>
                <Field
                  label="Scan an image"
                  hint="Manual fallback · PNG, JPEG, or WebP up to 10 MB"
                >
                  <input
                    type="file"
                    disabled={!enabled || imageScanner.scanningImage}
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file !== undefined) void imageScanner.scanFile(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </Field>
              </div>
              <canvas
                ref={imageScanner.workCanvasRef}
                class="scan-work-canvas"
              />
            </div>
          </section>

          <section class="surface scan-result scanner-result">
            <div class="surface__header">
              <div>
                <h2>Parcel result</h2>
                <p>A confirmed tag causes one authoritative order refresh.</p>
              </div>
            </div>
            <div class="surface__body">
              {imageScanner.scanError !== "" ? (
                <Notice tone="danger">{imageScanner.scanError}</Notice>
              ) : processing || camera?.state === "processing" ? (
                <Spinner label="Resolving parcel" />
              ) : result === null ? (
                <div class="scan-result__idle">
                  <strong>Waiting for a parcel</strong>
                  <span>Camera frames never make seller API requests.</span>
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

function backgroundCameraMessage(status: ShipmentScannerStatus | null): {
  readonly title: string;
  readonly detail: string;
} {
  const camera = status?.backgroundCamera;
  if (camera === undefined || camera.state === "unavailable") {
    return {
      title: "Background service unavailable",
      detail: "Run the application with npm start.",
    };
  }
  if (camera.state === "disabled") {
    return {
      title: "Background camera is off",
      detail: "Enable it under Settings → Scanning.",
    };
  }
  if (camera.state === "starting") {
    return { title: "Opening camera", detail: "Waiting for the first frame." };
  }
  if (camera.state === "error") {
    return {
      title: "Camera needs attention",
      detail: "Retrying automatically.",
    };
  }
  if (camera.state === "processing") {
    return {
      title: "Resolving parcel",
      detail: "Checking the authoritative ready-order queue.",
    };
  }
  if (camera.state === "waiting-for-review") {
    return {
      title: "Waiting for review",
      detail: "Approve the matched order before presenting another parcel.",
    };
  }
  if (camera.consensus.tagId !== null) {
    return {
      title: `Confirming tag ${String(camera.consensus.tagId)}`,
      detail: `${String(camera.consensus.matchingReads)}/${String(camera.consensus.requiredReads)} matching reads`,
    };
  }
  if (camera.latchedTagId !== undefined) {
    return {
      title: `Processed tag ${String(camera.latchedTagId)}`,
      detail: "Remove the parcel before presenting the next one.",
    };
  }
  return {
    title: "Watching the basket",
    detail: "No browser window is required.",
  };
}

function cameraStateLabel(
  state: ShipmentScannerStatus["backgroundCamera"]["state"],
): string {
  return {
    disabled: "Off",
    starting: "Starting",
    running: "Watching",
    processing: "Processing",
    "waiting-for-review": "Review",
    error: "Error",
    unavailable: "Unavailable",
  }[state];
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
          {result.order.buyerName} · order{" "}
          <OrderNumberLink orderNumber={result.order.orderNumber} />
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
          {result.order.buyerName} · order{" "}
          <OrderNumberLink orderNumber={result.order.orderNumber} />
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
        <span>
          Order <OrderNumberLink orderNumber={result.orderNumber} /> was not
          submitted again.
        </span>
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
          The result for order{" "}
          <OrderNumberLink orderNumber={result.orderNumber} /> was uncertain and
          will not be retried automatically.
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
