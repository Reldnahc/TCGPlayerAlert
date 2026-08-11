import { createCanvas } from "@napi-rs/canvas";
import type { CameraFrame } from "./camera-capture.js";

const MAXIMUM_PREVIEW_WIDTH = 640;
const MAXIMUM_PREVIEW_HEIGHT = 480;
const MAXIMUM_FRAME_PIXELS = 16_000_000;
const JPEG_QUALITY = 72;

export async function encodeCameraPreviewFrame(
  frame: CameraFrame,
): Promise<Uint8Array> {
  validateFrame(frame);
  const scale = Math.min(
    1,
    MAXIMUM_PREVIEW_WIDTH / frame.width,
    MAXIMUM_PREVIEW_HEIGHT / frame.height,
  );
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  const pixels = image.data;

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      frame.height - 1,
      Math.floor(((y + 0.5) * frame.height) / height),
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        frame.width - 1,
        Math.floor(((x + 0.5) * frame.width) / width),
      );
      const luminance = frame.grayscale[sourceY * frame.width + sourceX] ?? 0;
      const target = (y * width + x) * 4;
      pixels[target] = luminance;
      pixels[target + 1] = luminance;
      pixels[target + 2] = luminance;
      pixels[target + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas.encode("jpeg", JPEG_QUALITY);
}

function validateFrame(frame: CameraFrame): void {
  if (
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width * frame.height > MAXIMUM_FRAME_PIXELS ||
    frame.grayscale.length !== frame.width * frame.height
  ) {
    throw new Error("The camera preview frame is invalid.");
  }
}
