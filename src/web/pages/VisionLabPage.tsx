import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createShipmentAprilTag,
  type ShipmentTagDetection,
} from "../../april-tag.js";
import { detectShipmentAprilTags } from "../april-tag-detector.js";
import {
  emptyShipmentTagConsensus,
  observeShipmentTagDetection,
  type ShipmentTagConsensus,
} from "../../shipment-tag-consensus.js";
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

const CAMERA_SCAN_INTERVAL_MILLISECONDS = 250;
const CAMERA_REARM_EMPTY_FRAMES = 5;
const MAXIMUM_CAMERA_FRAME_WIDTH = 1_280;
const MAXIMUM_UPLOAD_BYTES = 10 * 1024 * 1024;

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

async function detectCanvas(
  canvas: HTMLCanvasElement,
): Promise<readonly ShipmentTagDetection[]> {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return [];
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return detectShipmentAprilTags(image.data, image.width, image.height);
}

function drawSourceToCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
): void {
  const scale = Math.min(1, MAXIMUM_CAMERA_FRAME_WIDTH / sourceWidth);
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("Canvas rendering is unavailable.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
}

export function VisionLabPage() {
  const toast = useToast();
  const [caseId, setCaseId] = useState<VisionLabCaseId>("unique");
  const [labelIndex, setLabelIndex] = useState(0);
  const [resolution, setResolution] = useState<VisionLabResolution | null>(
    null,
  );
  const [scanError, setScanError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [scanningPreview, setScanningPreview] = useState(false);
  const [printingMode, setPrintingMode] = useState<"selected" | "all" | null>(
    null,
  );
  const completedRef = useRef(new Set<string>());
  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const workCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraTimerRef = useRef<number | undefined>(undefined);
  const cameraScanBusyRef = useRef(false);
  const cameraSessionRef = useRef(0);
  const cameraEmptyFramesRef = useRef(0);
  const cameraLatchedTagIdRef = useRef<number | null>(null);
  const [cameraLatchedTagId, setCameraLatchedTagId] = useState<number | null>(
    null,
  );
  const cameraConsensusRef = useRef(emptyShipmentTagConsensus());
  const [cameraConsensus, setCameraConsensus] = useState<ShipmentTagConsensus>(
    cameraConsensusRef.current,
  );
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
    setScanError("");
  }

  function singleDetection(
    detections: readonly ShipmentTagDetection[],
    clearResolutionOnError = true,
  ): ShipmentTagDetection | undefined {
    if (detections.length === 0) {
      return undefined;
    }
    if (detections.length > 1) {
      setScanError(
        "Multiple AprilTags were found. Present one parcel at a time.",
      );
      if (clearResolutionOnError) setResolution(null);
      return undefined;
    }
    return detections[0];
  }

  function resolveStaticDetections(
    detections: readonly ShipmentTagDetection[],
  ) {
    const detection = singleDetection(detections);
    if (detection === undefined) {
      if (detections.length === 0) {
        setScanError("No AprilTag was found in that image.");
        setResolution(null);
      }
      return false;
    }
    if (detection.hammingDistance !== 0) {
      setScanError(
        "The tag read was uncertain. Move closer or use a sharper image and try again.",
      );
      setResolution(null);
      return false;
    }
    resolveTag(detection.tagId);
    return true;
  }

  function observeCameraDetections(
    detections: readonly ShipmentTagDetection[],
  ): void {
    cameraEmptyFramesRef.current = 0;
    const detection = singleDetection(detections, false);
    if (detection === undefined) return;
    if (detection.tagId === cameraLatchedTagIdRef.current) {
      if (cameraConsensusRef.current.tagId !== null) resetCameraConsensus();
      setScanError("");
      return;
    }
    const observation = observeShipmentTagDetection(
      cameraConsensusRef.current,
      detection,
      knownTagIds,
    );
    if (!observation.accepted) return;
    cameraConsensusRef.current = observation.consensus;
    setCameraConsensus(observation.consensus);
    setScanError("");
    if (observation.confirmedTagId === undefined) return;
    resolveTag(observation.confirmedTagId);
    cameraLatchedTagIdRef.current = observation.confirmedTagId;
    setCameraLatchedTagId(observation.confirmedTagId);
    resetCameraConsensus();
  }

  function observeEmptyCameraFrame() {
    cameraEmptyFramesRef.current += 1;
    if (cameraEmptyFramesRef.current < CAMERA_REARM_EMPTY_FRAMES) return;
    cameraEmptyFramesRef.current = 0;
    cameraLatchedTagIdRef.current = null;
    setCameraLatchedTagId(null);
    if (cameraConsensusRef.current.tagId !== null) resetCameraConsensus();
    setScanError("");
  }

  function resetCameraConsensus() {
    const empty = emptyShipmentTagConsensus();
    cameraConsensusRef.current = empty;
    setCameraConsensus(empty);
  }

  function resetCameraCycle() {
    cameraEmptyFramesRef.current = 0;
    cameraLatchedTagIdRef.current = null;
    setCameraLatchedTagId(null);
    resetCameraConsensus();
  }

  function stopCamera() {
    cameraSessionRef.current += 1;
    if (cameraTimerRef.current !== undefined) {
      window.clearInterval(cameraTimerRef.current);
      cameraTimerRef.current = undefined;
    }
    const video = videoRef.current;
    const stream = video?.srcObject;
    if (
      stream !== null &&
      stream !== undefined &&
      "getTracks" in stream &&
      typeof stream.getTracks === "function"
    ) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (video !== null) video.srcObject = null;
    setCameraActive(false);
  }

  useEffect(() => {
    setLabelIndex(0);
    setResolution(null);
    setScanError("");
    resetCameraCycle();
    stopCamera();
  }, [selectedCase]);

  useEffect(() => {
    const canvas = markerCanvasRef.current;
    if (canvas !== null) {
      drawAprilTag(canvas, selectedPrintedOrder.tagId);
    }
  }, [selectedPrintedOrder]);

  useEffect(() => () => stopCamera(), []);

  async function scanPreview() {
    const canvas = markerCanvasRef.current;
    setScanningPreview(true);
    try {
      const detections = canvas === null ? [] : await detectCanvas(canvas);
      if (detections.length === 0) {
        setScanError("The generated AprilTag could not be detected.");
        setResolution(null);
        return;
      }
      resolveStaticDetections(detections);
    } catch (cause) {
      setScanError(
        errorMessage(cause, "The AprilTag scanner could not start."),
      );
      setResolution(null);
    } finally {
      setScanningPreview(false);
    }
  }

  async function scanFile(file: File) {
    if (file.size < 1 || file.size > MAXIMUM_UPLOAD_BYTES) {
      setScanError("Choose an image smaller than 10 MB.");
      setResolution(null);
      return;
    }
    try {
      const image = await createImageBitmap(file);
      try {
        const canvas = workCanvasRef.current;
        if (canvas === null) throw new Error("Scanner canvas is unavailable.");
        drawSourceToCanvas(image, image.width, image.height, canvas);
        resolveStaticDetections(await detectCanvas(canvas));
      } finally {
        image.close();
      }
    } catch (cause) {
      setScanError(errorMessage(cause, "The image could not be scanned."));
      setResolution(null);
    }
  }

  async function startCamera() {
    const mediaDevices = Reflect.get(navigator, "mediaDevices") as
      MediaDevices | undefined;
    if (mediaDevices?.getUserMedia === undefined) {
      setScanError("This browser cannot access a camera.");
      return;
    }
    stopCamera();
    setScanError("");
    setResolution(null);
    resetCameraCycle();
    const cameraSession = cameraSessionRef.current;
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1_920 },
          height: { ideal: 1_080 },
        },
      });
      if (cameraSession !== cameraSessionRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const video = videoRef.current;
      const canvas = workCanvasRef.current;
      if (video === null || canvas === null) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("The camera workspace is unavailable.");
      }
      video.srcObject = stream;
      await video.play();
      setCameraActive(true);
      cameraTimerRef.current = window.setInterval(() => {
        if (
          cameraSession !== cameraSessionRef.current ||
          cameraScanBusyRef.current ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        )
          return;
        cameraScanBusyRef.current = true;
        void (async () => {
          try {
            drawSourceToCanvas(
              video,
              video.videoWidth,
              video.videoHeight,
              canvas,
            );
            const detections = await detectCanvas(canvas);
            if (cameraSession !== cameraSessionRef.current) return;
            if (detections.length === 0) {
              observeEmptyCameraFrame();
              return;
            }
            observeCameraDetections(detections);
          } catch (cause) {
            setScanError(
              errorMessage(cause, "The camera frame could not be scanned."),
            );
            stopCamera();
          } finally {
            cameraScanBusyRef.current = false;
          }
        })();
      }, CAMERA_SCAN_INTERVAL_MILLISECONDS);
    } catch (cause) {
      stopCamera();
      setScanError(errorMessage(cause, "Camera access could not be started."));
    }
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
                        setScanError("");
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
              <div class={`camera-stage${cameraActive ? " is-active" : ""}`}>
                <video ref={videoRef} muted playsInline />
                {cameraActive ? (
                  <span>
                    {cameraConsensus.tagId === null
                      ? cameraLatchedTagId === null
                        ? resolution === null
                          ? "Looking for an AprilTag"
                          : "Ready for the next parcel"
                        : `Processed tag ${String(cameraLatchedTagId)} - remove parcel`
                      : `Confirming tag ${String(cameraConsensus.tagId)} - ${String(cameraConsensus.matchingReads)}/${String(cameraConsensus.requiredReads)}`}
                  </span>
                ) : (
                  <div>
                    <strong>Camera is off</strong>
                    <span>It starts only when you request it.</span>
                  </div>
                )}
              </div>
              <div class="scan-lab-actions">
                {cameraActive ? (
                  <Button tone="danger" onClick={stopCamera}>
                    Stop camera
                  </Button>
                ) : (
                  <Button tone="primary" onClick={() => void startCamera()}>
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
              <canvas ref={workCanvasRef} class="scan-work-canvas" />
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
            {scanError !== "" ? (
              <Notice tone="danger">{scanError}</Notice>
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
