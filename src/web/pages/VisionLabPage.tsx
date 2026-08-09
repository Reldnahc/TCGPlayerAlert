import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createShipmentQrCode, decodeShipmentQrPixels } from "../../qr-code.js";
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
const MAXIMUM_CAMERA_FRAME_WIDTH = 1_280;
const MAXIMUM_UPLOAD_BYTES = 10 * 1024 * 1024;

function drawQrCode(canvas: HTMLCanvasElement, code: string): void {
  const qrCode = createShipmentQrCode(code);
  const pixelsPerModule = 6;
  const totalModules = qrCode.rows.length + qrCode.quietZoneModules * 2;
  const size = totalModules * pixelsPerModule;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas rendering is unavailable.");
  context.fillStyle = "white";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "black";
  for (const [row, modules] of qrCode.rows.entries()) {
    for (let column = 0; column < modules.length; column += 1) {
      if (modules[column] !== "1") continue;
      context.fillRect(
        (column + qrCode.quietZoneModules) * pixelsPerModule,
        (row + qrCode.quietZoneModules) * pixelsPerModule,
        pixelsPerModule,
        pixelsPerModule,
      );
    }
  }
}

function decodeCanvas(canvas: HTMLCanvasElement): string | undefined {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return undefined;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return decodeShipmentQrPixels(image.data, image.width, image.height);
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
  const [resolution, setResolution] = useState<VisionLabResolution | null>(
    null,
  );
  const [scanError, setScanError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [printing, setPrinting] = useState(false);
  const completedRef = useRef(new Set<string>());
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const workCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraTimerRef = useRef<number | undefined>(undefined);
  const selectedCase = useMemo(() => visionLabCase(caseId), [caseId]);

  function resolveCode(code: string) {
    const next = resolveVisionLabScan(
      code,
      selectedCase.candidates,
      completedRef.current,
    );
    if (next.state === "match") {
      completedRef.current.add(next.order.orderNumber);
    }
    setResolution(next);
    setScanError("");
  }

  function stopCamera() {
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
    const canvas = qrCanvasRef.current;
    if (canvas !== null) {
      drawQrCode(canvas, selectedCase.printedOrder.verificationCode);
    }
    setResolution(null);
    setScanError("");
    stopCamera();
  }, [selectedCase]);

  useEffect(() => () => stopCamera(), []);

  function scanPreview() {
    const canvas = qrCanvasRef.current;
    const code = canvas === null ? undefined : decodeCanvas(canvas);
    if (code === undefined) {
      setScanError("The generated QR code could not be decoded.");
      setResolution(null);
      return;
    }
    resolveCode(code);
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
        const code = decodeCanvas(canvas);
        if (code === undefined) {
          setScanError("No QR code was found in that image.");
          setResolution(null);
        } else {
          resolveCode(code);
        }
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
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1_920 },
          height: { ideal: 1_080 },
        },
      });
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
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        drawSourceToCanvas(video, video.videoWidth, video.videoHeight, canvas);
        const code = decodeCanvas(canvas);
        if (code === undefined) return;
        resolveCode(code);
        stopCamera();
      }, CAMERA_SCAN_INTERVAL_MILLISECONDS);
    } catch (cause) {
      stopCamera();
      setScanError(errorMessage(cause, "Camera access could not be started."));
    }
  }

  async function printLabel() {
    setPrinting(true);
    try {
      await uiApi.printVisionLabLabel(caseId);
      toast.show("Synthetic QR label sent to the printer.", "success");
    } catch (cause) {
      toast.show(
        errorMessage(cause, "The synthetic QR label could not be printed."),
        "danger",
      );
    } finally {
      setPrinting(false);
    }
  }

  return (
    <main class="page scan-lab-page">
      <PageHeader
        title="Scan lab"
        description="Exercise the QR workflow with synthetic orders and no seller mutations"
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
              <div class="synthetic-label" aria-label="Synthetic address label">
                <div class="synthetic-label__address">
                  {selectedCase.printedOrder.addressLines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
                <canvas
                  ref={qrCanvasRef}
                  class="synthetic-label__qr"
                  aria-label="Synthetic shipment QR code"
                />
              </div>
              <div class="scan-lab-actions">
                <Button tone="primary" onClick={scanPreview}>
                  Scan preview
                </Button>
                <Button
                  icon="printer"
                  busy={printing}
                  onClick={() => void printLabel()}
                >
                  Print synthetic label
                </Button>
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
                  <span>Looking for a QR code</span>
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
                <span>Start with Scan preview to verify the full QR loop.</span>
              </div>
            ) : resolution.state === "match" ? (
              <Notice tone="success">
                <strong>Would mark shipped</strong>
                <span>
                  {resolution.order.orderNumber} {" · "}
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
                  code.
                </span>
              </Notice>
            ) : (
              <Notice tone="danger">
                <strong>No matching order</strong>
                <span>
                  The fake ready-order pool does not contain this code.
                </span>
              </Notice>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
