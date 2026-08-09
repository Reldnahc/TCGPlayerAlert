import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createShipmentAprilTag } from "../../april-tag.js";
import {
  resolveVisionLabScan,
  visionLabCase,
  VISION_LAB_CASES,
  type VisionLabCaseId,
  type VisionLabResolution,
} from "../../vision-lab.js";
import { uiApi } from "../api.js";
import {
  Button,
  Field,
  Notice,
  PageHeader,
  StatusBadge,
} from "../components/ui.js";
import { useToast } from "../state/ToastContext.js";
import { errorMessage } from "../utils.js";
import { useAprilTagScanner } from "../useAprilTagScanner.js";

function drawAprilTag(canvas: HTMLCanvasElement, tagId: number): void {
  const marker = createShipmentAprilTag(tagId);
  const pixelsPerModule = 14;
  const totalModules = marker.rows.length + marker.quietZoneModules * 2;
  const size = totalModules * pixelsPerModule;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas rendering is unavailable.");
  context.fillStyle = "white";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "black";
  for (const [row, modules] of marker.rows.entries()) {
    for (let column = 0; column < modules.length; column += 1) {
      if (modules[column] !== "1") continue;
      context.fillRect(
        (column + marker.quietZoneModules) * pixelsPerModule,
        (row + marker.quietZoneModules) * pixelsPerModule,
        pixelsPerModule,
        pixelsPerModule,
      );
    }
  }
}

export function VisionLabPage() {
  const toast = useToast();
  const [caseId, setCaseId] = useState<VisionLabCaseId>("unique");
  const [labelIndex, setLabelIndex] = useState(0);
  const [resolution, setResolution] = useState<VisionLabResolution | null>(
    null,
  );
  const [scanningPreview, setScanningPreview] = useState(false);
  const [printingMode, setPrintingMode] = useState<"selected" | "all" | null>(
    null,
  );
  const completedRef = useRef(new Set<string>());
  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const selectedCase = useMemo(() => visionLabCase(caseId), [caseId]);
  const selectedPrintedOrder = useMemo(() => {
    const order =
      selectedCase.printedOrders[labelIndex] ?? selectedCase.printedOrders[0];
    if (order === undefined) throw new Error("The lab case has no labels.");
    return order;
  }, [labelIndex, selectedCase]);
  const knownTagIds = useMemo(
    () => new Set(selectedCase.candidates.map((candidate) => candidate.tagId)),
    [selectedCase],
  );
  const scanner = useAprilTagScanner({
    knownTagIds,
    onConfirmed: resolveTag,
  });

  function resolveTag(tagId: number) {
    const next = resolveVisionLabScan(
      tagId,
      selectedCase.candidates,
      completedRef.current,
    );
    if (next.state === "match") {
      completedRef.current.add(next.order.orderNumber);
    }
    setResolution(next);
    scanner.setScanError("");
  }

  useEffect(() => {
    setLabelIndex(0);
    setResolution(null);
    scanner.setScanError("");
    scanner.resetCameraCycle();
    scanner.stopCamera();
  }, [selectedCase]);

  useEffect(() => {
    const canvas = markerCanvasRef.current;
    if (canvas !== null) {
      drawAprilTag(canvas, selectedPrintedOrder.tagId);
    }
  }, [selectedPrintedOrder]);

  async function scanPreview() {
    const canvas = markerCanvasRef.current;
    setScanningPreview(true);
    try {
      const success = canvas !== null && (await scanner.scanCanvas(canvas));
      if (!success) setResolution(null);
    } catch (cause) {
      scanner.setScanError(
        errorMessage(cause, "The AprilTag scanner could not start."),
      );
      setResolution(null);
    } finally {
      setScanningPreview(false);
    }
  }

  async function scanFile(file: File) {
    if (!(await scanner.scanFile(file))) setResolution(null);
  }

  async function printLabel() {
    setPrintingMode("selected");
    try {
      await uiApi.printVisionLabLabel(caseId, labelIndex);
      toast.show("Synthetic AprilTag label sent to the printer.", "success");
    } catch (cause) {
      toast.show(
        errorMessage(
          cause,
          "The synthetic AprilTag label could not be printed.",
        ),
        "danger",
      );
    } finally {
      setPrintingMode(null);
    }
  }

  async function printAllLabels() {
    setPrintingMode("all");
    let printed = 0;
    try {
      for (const [index] of selectedCase.printedOrders.entries()) {
        await uiApi.printVisionLabLabel(caseId, index);
        printed += 1;
      }
      toast.show(
        `${String(printed)} synthetic labels sent to the printer.`,
        "success",
      );
    } catch (cause) {
      toast.show(
        `${String(printed)} of ${String(selectedCase.printedOrders.length)} labels were submitted. ${errorMessage(cause, "The remaining labels could not be printed.")}`,
        "danger",
      );
    } finally {
      setPrintingMode(null);
    }
  }

  return (
    <main class="page scan-lab-page">
      <PageHeader
        title="Scan lab"
        description="Exercise the AprilTag workflow with synthetic orders and no seller mutations"
        actions={<StatusBadge status="Simulation only" />}
      />
      <div class="page-body scan-lab-body">
        <div class="scan-lab-grid">
          <section class="surface scan-lab-panel">
            <div class="surface__header">
              <div>
                <h2>Synthetic label</h2>
                <p>Choose the resolution outcome you want to exercise.</p>
              </div>
            </div>
            <div class="surface__body scan-lab-panel__body">
              <div class="scan-lab-cases" role="group" aria-label="Lab case">
                {VISION_LAB_CASES.map((labCase) => (
                  <button
                    key={labCase.id}
                    type="button"
                    class={labCase.id === caseId ? "is-active" : ""}
                    aria-pressed={labCase.id === caseId}
                    onClick={() => setCaseId(labCase.id)}
                  >
                    <strong>{labCase.label}</strong>
                    <span>{labCase.detail}</span>
                  </button>
                ))}
              </div>
              {selectedCase.printedOrders.length > 1 ? (
                <div
                  class="scan-lab-label-picker"
                  role="group"
                  aria-label="Basket label"
                >
                  {selectedCase.printedOrders.map((order, index) => (
                    <button
                      key={order.orderNumber}
                      type="button"
                      class={index === labelIndex ? "is-active" : ""}
                      aria-label={`Label ${String(index + 1)}: ${order.buyerName}`}
                      aria-pressed={index === labelIndex}
                      onClick={() => {
                        setLabelIndex(index);
                        setResolution(null);
                        scanner.setScanError("");
                      }}
                    >
                      <strong>{String(index + 1)}</strong>
                      <span>{order.buyerName}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div class="synthetic-label" aria-label="Synthetic address label">
                <div class="synthetic-label__address">
                  {selectedPrintedOrder.addressLines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
                <canvas
                  ref={markerCanvasRef}
                  class="synthetic-label__marker"
                  aria-label="Synthetic shipment AprilTag"
                />
              </div>
              <div class="scan-lab-actions">
                <Button
                  tone="primary"
                  busy={scanningPreview}
                  onClick={() => void scanPreview()}
                >
                  Scan preview
                </Button>
                <Button
                  icon="printer"
                  busy={printingMode === "selected"}
                  disabled={printingMode !== null}
                  onClick={() => void printLabel()}
                >
                  {selectedCase.printedOrders.length > 1
                    ? "Print selected label"
                    : "Print synthetic label"}
                </Button>
                {selectedCase.printedOrders.length > 1 ? (
                  <Button
                    icon="printer"
                    busy={printingMode === "all"}
                    disabled={printingMode !== null}
                    onClick={() => void printAllLabels()}
                  >
                    Print all 5 labels
                  </Button>
                ) : null}
              </div>
            </div>
          </section>

          <section class="surface scan-lab-panel">
            <div class="surface__header">
              <div>
                <h2>Scanner</h2>
                <p>
                  Use a webcam or an image captured outside the application.
                </p>
              </div>
            </div>
            <div class="surface__body scan-lab-panel__body">
              <div
                class={`camera-stage${scanner.cameraActive ? " is-active" : ""}`}
              >
                <video ref={scanner.videoRef} muted playsInline />
                {scanner.cameraActive ? (
                  <span>
                    {scanner.cameraConsensus.tagId === null
                      ? scanner.cameraLatchedTagId === null
                        ? resolution === null
                          ? "Looking for an AprilTag"
                          : "Ready for the next parcel"
                        : `Processed tag ${String(scanner.cameraLatchedTagId)} - remove parcel`
                      : `Confirming tag ${String(scanner.cameraConsensus.tagId)} - ${String(scanner.cameraConsensus.matchingReads)}/${String(scanner.cameraConsensus.requiredReads)}`}
                  </span>
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
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file !== undefined) void scanFile(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </Field>
              </div>
              <canvas ref={scanner.workCanvasRef} class="scan-work-canvas" />
            </div>
          </section>
        </div>

        <section class="surface scan-result">
          <div class="surface__header">
            <div>
              <h2>Resolution</h2>
              <p>Only the in-memory fake shipment ledger can change here.</p>
            </div>
          </div>
          <div class="surface__body">
            {scanner.scanError !== "" ? (
              <Notice tone="danger">{scanner.scanError}</Notice>
            ) : resolution === null ? (
              <div class="scan-result__idle">
                <strong>Waiting for a scan</strong>
                <span>
                  Start with Scan preview to verify the full AprilTag loop.
                </span>
              </div>
            ) : resolution.state === "match" ? (
              <Notice tone="success">
                <strong>Would mark shipped</strong>
                <span>
                  {resolution.order.orderNumber} {" - "}
                  {resolution.order.buyerName}
                </span>
              </Notice>
            ) : resolution.state === "duplicate" ? (
              <Notice tone="info">
                <strong>Already simulated</strong>
                <span>
                  {resolution.order.orderNumber} will not be processed twice.
                </span>
              </Notice>
            ) : resolution.state === "ambiguous" ? (
              <Notice tone="warning">
                <strong>Review required</strong>
                <span>
                  {String(resolution.orders.length)} fake orders matched this
                  tag.
                </span>
              </Notice>
            ) : (
              <Notice tone="danger">
                <strong>No matching order</strong>
                <span>
                  The fake ready-order pool does not contain tag{" "}
                  {String(resolution.tagId)}.
                </span>
              </Notice>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
