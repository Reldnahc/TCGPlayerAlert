import { useEffect, useRef, useState } from "preact/hooks";
import type { ShipmentTagDetection } from "../april-tag.js";
import {
  emptyShipmentTagConsensus,
  observeShipmentTagDetection,
  type ShipmentTagConsensus,
} from "../shipment-tag-consensus.js";
import { detectShipmentAprilTags } from "./april-tag-detector.js";
import { errorMessage } from "./utils.js";

const CAMERA_SCAN_INTERVAL_MILLISECONDS = 250;
const CAMERA_REARM_EMPTY_FRAMES = 5;
const MAXIMUM_CAMERA_FRAME_WIDTH = 1_280;
const MAXIMUM_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface AprilTagScannerOptions {
  readonly knownTagIds: ReadonlySet<number>;
  readonly onConfirmed: (tagId: number) => void | Promise<void>;
}

export function useAprilTagScanner(options: AprilTagScannerOptions) {
  const [scanError, setScanError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [scanningImage, setScanningImage] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const workCanvasRef = useRef<HTMLCanvasElement>(null);
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
  const knownTagIdsRef = useRef(options.knownTagIds);
  const onConfirmedRef = useRef(options.onConfirmed);
  knownTagIdsRef.current = options.knownTagIds;
  onConfirmedRef.current = options.onConfirmed;

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

  useEffect(() => () => stopCamera(), []);

  function singleDetection(
    detections: readonly ShipmentTagDetection[],
  ): ShipmentTagDetection | undefined {
    if (detections.length === 0) return undefined;
    if (detections.length > 1) {
      setScanError(
        "Multiple AprilTags were found. Present one parcel at a time.",
      );
      return undefined;
    }
    return detections[0];
  }

  async function confirm(tagId: number): Promise<void> {
    try {
      await onConfirmedRef.current(tagId);
    } catch (cause) {
      setScanError(
        errorMessage(cause, "The shipment tag could not be resolved."),
      );
    }
  }

  function observeCameraDetections(
    detections: readonly ShipmentTagDetection[],
  ): void {
    cameraEmptyFramesRef.current = 0;
    const detection = singleDetection(detections);
    if (detection === undefined) return;
    if (detection.tagId === cameraLatchedTagIdRef.current) {
      if (cameraConsensusRef.current.tagId !== null) resetCameraConsensus();
      setScanError("");
      return;
    }
    const observation = observeShipmentTagDetection(
      cameraConsensusRef.current,
      detection,
      knownTagIdsRef.current,
    );
    if (!observation.accepted) return;
    cameraConsensusRef.current = observation.consensus;
    setCameraConsensus(observation.consensus);
    setScanError("");
    if (observation.confirmedTagId === undefined) return;
    cameraLatchedTagIdRef.current = observation.confirmedTagId;
    setCameraLatchedTagId(observation.confirmedTagId);
    resetCameraConsensus();
    void confirm(observation.confirmedTagId);
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

  async function scanCanvas(canvas: HTMLCanvasElement): Promise<boolean> {
    setScanningImage(true);
    try {
      const detections = await detectCanvas(canvas);
      const detection = singleDetection(detections);
      if (detection === undefined) {
        if (detections.length === 0) {
          setScanError("No AprilTag was found in that image.");
        }
        return false;
      }
      if (detection.hammingDistance !== 0) {
        setScanError(
          "The tag read was uncertain. Move closer or use a sharper image and try again.",
        );
        return false;
      }
      setScanError("");
      await confirm(detection.tagId);
      return true;
    } catch (cause) {
      setScanError(errorMessage(cause, "The image could not be scanned."));
      return false;
    } finally {
      setScanningImage(false);
    }
  }

  async function scanFile(file: File): Promise<boolean> {
    if (file.size < 1 || file.size > MAXIMUM_UPLOAD_BYTES) {
      setScanError("Choose an image smaller than 10 MB.");
      return false;
    }
    try {
      const image = await createImageBitmap(file);
      try {
        const canvas = workCanvasRef.current;
        if (canvas === null) throw new Error("Scanner canvas is unavailable.");
        drawSourceToCanvas(image, image.width, image.height, canvas);
        return await scanCanvas(canvas);
      } finally {
        image.close();
      }
    } catch (cause) {
      setScanError(errorMessage(cause, "The image could not be scanned."));
      return false;
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
        ) {
          return;
        }
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

  return {
    cameraActive,
    cameraConsensus,
    cameraLatchedTagId,
    scanError,
    scanningImage,
    videoRef,
    workCanvasRef,
    resetCameraCycle,
    scanCanvas,
    scanFile,
    setScanError,
    startCamera,
    stopCamera,
  };
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
