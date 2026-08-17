import type { Decoder, Demuxer, Scaler } from "node-av/api";

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const CAPTURE_FRAMES_PER_SECOND = 10;
const MAXIMUM_FRAME_PIXELS = 16_000_000;

export interface CameraDevice {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface CameraDiscoveryResult {
  readonly cameras: readonly CameraDevice[];
  readonly issue?: string;
}

export interface CameraFrame {
  readonly width: number;
  readonly height: number;
  readonly grayscale: Uint8Array;
}

export interface CameraCaptureSettings {
  /** An empty value asks the adapter to use the operating-system default. */
  readonly deviceId: string;
}

export interface CameraCaptureAdapter {
  discover(): Promise<CameraDiscoveryResult>;
  frames(
    settings: CameraCaptureSettings,
    signal: AbortSignal,
  ): AsyncIterable<CameraFrame>;
}

export class NodeAvCameraCapture implements CameraCaptureAdapter {
  async discover(): Promise<CameraDiscoveryResult> {
    return discoverSystemCameras();
  }

  async *frames(
    settings: CameraCaptureSettings,
    signal: AbortSignal,
  ): AsyncIterable<CameraFrame> {
    signal.throwIfAborted();
    const { Decoder, DeviceAPI, Scaler } = await import("node-av/api");
    let input: Demuxer | undefined;
    let decoder: Decoder | undefined;
    let scaler: Scaler | undefined;
    let closeInputPromise: Promise<void> | undefined;
    const closeInput = () => {
      if (input !== undefined) {
        closeInputPromise ??= input.close().catch(() => undefined);
      }
    };
    try {
      input = await DeviceAPI.openCamera({
        videoDevice: settings.deviceId === "" ? 0 : settings.deviceId,
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        frameRate: CAPTURE_FRAMES_PER_SECOND,
      });
      signal.throwIfAborted();
      const video = input.video();
      if (video === undefined) {
        throw new Error("The selected camera did not provide a video stream.");
      }
      decoder = await Decoder.create(video);
      scaler = new Scaler();
      signal.addEventListener("abort", closeInput, { once: true });
      for await (const frame of decoder.frames(input.packets(video.index))) {
        if (frame === null || signal.aborted) break;
        try {
          const width = frame.width;
          const height = frame.height;
          if (
            !Number.isInteger(width) ||
            !Number.isInteger(height) ||
            width < 1 ||
            height < 1 ||
            width * height > MAXIMUM_FRAME_PIXELS
          ) {
            throw new Error("The camera returned an unsupported frame size.");
          }
          const grayscale = await scaler.toBuffer(frame, { format: "gray" });
          if (grayscale.length !== width * height) {
            throw new Error("The camera returned malformed grayscale pixels.");
          }
          yield { width, height, grayscale };
        } finally {
          frame.free();
        }
      }
    } finally {
      signal.removeEventListener("abort", closeInput);
      scaler?.close();
      decoder?.close();
      closeInput();
      await closeInputPromise;
    }
  }
}

export async function discoverSystemCameras(): Promise<CameraDiscoveryResult> {
  try {
    const { DeviceAPI } = await import("node-av/api");
    const cameras = (await DeviceAPI.list())
      .filter((device) => device.type === "video")
      .map((device) => ({
        id: device.name,
        label: device.name,
        isDefault: device.isDefault,
      }));
    return { cameras };
  } catch {
    return {
      cameras: [],
      issue: "Camera discovery is unavailable on this system.",
    };
  }
}
