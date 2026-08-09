import { describe, expect, it, vi } from "vitest";
import type { ShipmentTagDetector } from "../src/background-april-tag-detector.js";
import {
  BackgroundShipmentScanner,
  type ShipmentScanCue,
  type ShipmentTagResolver,
} from "../src/background-shipment-scanner.js";
import type {
  CameraCaptureAdapter,
  CameraFrame,
} from "../src/camera-capture.js";
import type { ShipmentScannerConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";

const settings: ShipmentScannerConfig = {
  enabled: true,
  automaticallyMarkShipped: true,
  soundEnabled: false,
  camera: { enabled: true, deviceId: "synthetic-camera" },
  stateFile: ".data/synthetic-scans.json",
};

const frame: CameraFrame = {
  width: 2,
  height: 2,
  grayscale: new Uint8Array(4),
};

const logger: Logger = { info: vi.fn(), error: vi.fn() };

describe("background shipment scanner", () => {
  it("confirms five frames and resolves the tag without a browser", async () => {
    const scan = vi.fn().mockResolvedValue({
      state: "already-processed",
      tagId: 7,
      orderNumber: "SYNTHETIC-ORDER",
    });
    const scanner = new BackgroundShipmentScanner({
      settings: () => Promise.resolve(settings),
      camera: new SyntheticCamera(5),
      detector: new SyntheticDetector(7),
      scanner: resolver(scan),
      logger,
    });
    const controller = new AbortController();
    const running = scanner.run(controller.signal);

    await waitUntil(() => scan.mock.calls.length === 1);
    expect(scanner.cameraStatus()).toMatchObject({
      state: "running",
      latchedTagId: 7,
      lastResult: { state: "already-processed", tagId: 7 },
    });

    controller.abort();
    await running;
  });

  it("pauses a review-mode camera after one exact match", async () => {
    const reviewSettings = {
      ...settings,
      automaticallyMarkShipped: false,
    };
    const scan = vi.fn().mockResolvedValue({
      state: "matched",
      tagId: 18,
      order: syntheticOrder,
    });
    const detector = new SyntheticDetector(18);
    const cue: ShipmentScanCue = { play: vi.fn(), failure: vi.fn() };
    const scanner = new BackgroundShipmentScanner({
      settings: () => Promise.resolve(reviewSettings),
      camera: new SyntheticCamera(12),
      detector,
      scanner: resolver(scan),
      logger,
      cue,
    });
    const controller = new AbortController();
    const running = scanner.run(controller.signal);

    await waitUntil(
      () => scanner.cameraStatus().state === "waiting-for-review",
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(scan).toHaveBeenCalledOnce();
    expect(detector.calls).toBe(5);

    controller.abort();
    await running;
  });
});

class SyntheticCamera implements CameraCaptureAdapter {
  constructor(private readonly count: number) {}

  discover() {
    return Promise.resolve({ cameras: [] });
  }

  async *frames(_settings: { readonly deviceId: string }, signal: AbortSignal) {
    for (let index = 0; index < this.count; index += 1) yield frame;
    await new Promise<void>((resolvePromise) => {
      if (signal.aborted) resolvePromise();
      else
        signal.addEventListener("abort", () => resolvePromise(), {
          once: true,
        });
    });
  }
}

class SyntheticDetector implements ShipmentTagDetector {
  calls = 0;

  constructor(private readonly tagId: number) {}

  detect() {
    this.calls += 1;
    return Promise.resolve([
      { tagId: this.tagId, hammingDistance: 0, corners: [] },
    ]);
  }

  close() {
    return undefined;
  }
}

const syntheticOrder = {
  orderNumber: "SYNTHETIC-ORDER",
  buyerName: "Synthetic Buyer",
  orderDate: "2026-08-07T12:00:00.000Z",
  status: "Ready to Ship",
  statusCode: "ReadyToShip",
  canMarkShipped: true,
  shippingType: "Standard",
  productAmount: 10,
  shippingAmount: 1.49,
  totalAmount: 11.49,
} as const;

function resolver(scan: ShipmentTagResolver["scan"]): ShipmentTagResolver {
  return {
    status: () =>
      Promise.resolve({
        enabled: true,
        automaticallyMarkShipped: true,
        soundEnabled: false,
        readyOrderCount: 1,
        readyTagIds: [7, 18],
        conflictingTagCount: 0,
        reviewRequiredCount: 0,
      }),
    scan,
    markShipped: vi.fn(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for scanner.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
