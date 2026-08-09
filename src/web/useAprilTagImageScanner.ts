import { useRef, useState } from "preact/hooks";
import type { ShipmentTagDetection } from "../april-tag.js";
import { detectShipmentAprilTags } from "./april-tag-detector.js";
import { errorMessage } from "./utils.js";

const MAXIMUM_IMAGE_PIXELS = 16_000_000;
const MAXIMUM_UPLOAD_BYTES = 10 * 1024 * 1024;

export function useAprilTagImageScanner(options: {
  readonly onConfirmed: (tagId: number) => void | Promise<void>;
}) {
  const [scanError, setScanError] = useState("");
  const [scanningImage, setScanningImage] = useState(false);
  const workCanvasRef = useRef<HTMLCanvasElement>(null);

  async function confirm(tagId: number): Promise<void> {
    try {
      await options.onConfirmed(tagId);
    } catch (cause) {
      setScanError(
        errorMessage(cause, "The shipment tag could not be resolved."),
      );
    }
  }

  async function scanCanvas(canvas: HTMLCanvasElement): Promise<boolean> {
    setScanningImage(true);
    try {
      const detections = await detectCanvas(canvas);
      const detection = singleDetection(detections);
      if (detection === undefined) {
        setScanError(
          detections.length === 0
            ? "No AprilTag was found in that image."
            : "Multiple AprilTags were found. Present one parcel at a time.",
        );
        return false;
      }
      if (detection.hammingDistance !== 0) {
        setScanError(
          "The tag read was uncertain. Use a sharper image and try again.",
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

  return {
    scanError,
    scanningImage,
    workCanvasRef,
    scanFile,
    setScanError,
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

function singleDetection(
  detections: readonly ShipmentTagDetection[],
): ShipmentTagDetection | undefined {
  return detections.length === 1 ? detections[0] : undefined;
}

function drawSourceToCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
): void {
  const scale = Math.min(
    1,
    Math.sqrt(MAXIMUM_IMAGE_PIXELS / (sourceWidth * sourceHeight)),
  );
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("Canvas rendering is unavailable.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
}
