import { loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { encodeCameraPreviewFrame } from "../src/camera-preview.js";

describe("camera preview encoding", () => {
  it("downsamples a grayscale camera frame to a bounded JPEG", async () => {
    const bytes = await encodeCameraPreviewFrame({
      width: 1280,
      height: 720,
      grayscale: new Uint8Array(1280 * 720).fill(128),
    });
    const image = await loadImage(Buffer.from(bytes));

    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(image.width).toBe(640);
    expect(image.height).toBe(360);
  });

  it("rejects malformed source pixels", async () => {
    await expect(
      encodeCameraPreviewFrame({
        width: 2,
        height: 2,
        grayscale: new Uint8Array(3),
      }),
    ).rejects.toThrow("camera preview frame is invalid");
  });
});
