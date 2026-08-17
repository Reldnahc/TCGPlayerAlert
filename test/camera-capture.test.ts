import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeAvCameraCapture } from "../src/camera-capture.js";

const nodeAv = vi.hoisted(() => ({
  openCamera: vi.fn(),
  createDecoder: vi.fn(),
}));

vi.mock("node-av/api", () => ({
  DeviceAPI: {
    openCamera: nodeAv.openCamera,
    list: vi.fn(),
  },
  Decoder: { create: nodeAv.createDecoder },
  Scaler: class {
    close() {
      return undefined;
    }
  },
}));

describe("camera capture", () => {
  beforeEach(() => {
    nodeAv.openCamera.mockReset();
    nodeAv.createDecoder.mockReset();
    nodeAv.openCamera.mockResolvedValue({
      video: () => ({ index: 0 }),
      packets: () => [],
      close: () => Promise.resolve(),
    });
    nodeAv.createDecoder.mockResolvedValue({
      frames: () => emptyFrames(),
      close: vi.fn(),
    });
  });

  it("requests camera frames every 100 milliseconds", async () => {
    const capture = new NodeAvCameraCapture();
    const frames = capture.frames(
      { deviceId: "synthetic-camera" },
      new AbortController().signal,
    );
    const iterator = frames[Symbol.asyncIterator]();

    await iterator.next();

    expect(nodeAv.openCamera).toHaveBeenCalledWith({
      videoDevice: "synthetic-camera",
      width: 1280,
      height: 720,
      frameRate: 10,
    });
  });
});

async function* emptyFrames() {
  await Promise.resolve();
  yield* [];
}
