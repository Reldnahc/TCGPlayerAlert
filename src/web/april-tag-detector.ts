import type { ShipmentTagDetection } from "../april-tag.js";

const MAXIMUM_IMAGE_PIXELS = 16_000_000;
const INITIALIZATION_TIMEOUT_MILLISECONDS = 30_000;
const DETECTION_TIMEOUT_MILLISECONDS = 15_000;
const DETECTOR_WORKER_PATH = "vendor/apriltag-js/detector-worker.js";

interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: number;
}

interface WorkerRecord {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly detections?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseDetections(
  value: unknown,
  width: number,
  height: number,
): readonly ShipmentTagDetection[] {
  if (!Array.isArray(value)) {
    throw new Error("The AprilTag detector returned an invalid result.");
  }
  return value.map((candidate) => {
    const detection = asRecord(candidate);
    const tagId = detection?.id;
    const hammingDistance = detection?.hamming;
    const corners = detection?.corners;
    if (
      !Number.isInteger(tagId) ||
      (tagId as number) < 0 ||
      (tagId as number) >= 587 ||
      typeof hammingDistance !== "number" ||
      !Number.isFinite(hammingDistance) ||
      hammingDistance < 0 ||
      !Array.isArray(corners) ||
      corners.length !== 4
    ) {
      throw new Error("The AprilTag detector returned a malformed detection.");
    }
    const parsedCorners = corners.map((corner) => {
      const point = asRecord(corner);
      const x = point?.x;
      const y = point?.y;
      if (
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        x < 0 ||
        x > width * 2 ||
        typeof y !== "number" ||
        !Number.isFinite(y) ||
        y < 0 ||
        y > height * 2
      ) {
        throw new Error("The AprilTag detector returned malformed corners.");
      }
      return { x, y };
    });
    return {
      tagId: tagId as number,
      hammingDistance: Math.round(hammingDistance),
      corners: parsedCorners,
    };
  });
}

class ShipmentAprilTagDetector {
  private worker: Worker | undefined;
  private initialization: Promise<void> | undefined;
  private ready = false;
  private initializedWaiter: Waiter<void> | undefined;
  private setupWaiter: Waiter<void> | undefined;
  private detectionWaiter: Waiter<readonly ShipmentTagDetection[]> | undefined;
  private detectionDimensions:
    { readonly width: number; readonly height: number } | undefined;

  async detect(
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<readonly ShipmentTagDetection[]> {
    await this.ensureReady();
    if (this.detectionWaiter !== undefined) return [];
    const worker = this.worker;
    if (worker === undefined) {
      throw new Error("The AprilTag detector worker is unavailable.");
    }

    const pixels = new Uint8Array(data).buffer;
    this.detectionDimensions = { width, height };
    const result = new Promise<readonly ShipmentTagDetection[]>(
      (resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.fail(
            new Error("The AprilTag detector did not return a result in time."),
          );
        }, DETECTION_TIMEOUT_MILLISECONDS);
        this.detectionWaiter = { resolve, reject, timer };
      },
    );
    try {
      worker.postMessage({ type: "detect", imageData: pixels, width, height }, [
        pixels,
      ]);
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error("The AprilTag image could not be sent to the worker.");
      this.fail(error);
    }
    return result;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.initialization ??= this.initialize().catch((cause: unknown) => {
      const error =
        cause instanceof Error
          ? cause
          : new Error("The AprilTag detector could not be initialized.");
      this.fail(error);
      throw error;
    });
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    const workerUrl = new URL(
      `${import.meta.env.BASE_URL}${DETECTOR_WORKER_PATH}`,
      window.location.origin,
    );
    const worker = new Worker(workerUrl);
    this.worker = worker;
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.handleMessage(event.data);
    });
    worker.addEventListener("error", (event) => {
      this.fail(
        new Error(
          event.message === ""
            ? "The AprilTag detector worker failed."
            : event.message,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.fail(new Error("The AprilTag detector took too long to load."));
      }, INITIALIZATION_TIMEOUT_MILLISECONDS);
      this.initializedWaiter = { resolve, reject, timer };
    });

    const setup = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.fail(new Error("The AprilTag detector setup timed out."));
      }, INITIALIZATION_TIMEOUT_MILLISECONDS);
      this.setupWaiter = { resolve, reject, timer };
    });
    worker.postMessage({
      type: "setup",
      family: "tag36h11",
      hammingDist: 2,
      params: {
        quadDecimate: 1,
        quadSigma: 0,
        refineEdges: true,
        decodeSharpening: 0.25,
        debug: false,
      },
    });
    await setup;
    this.ready = true;
  }

  private handleMessage(value: unknown): void {
    const message = asRecord(value) as WorkerRecord | undefined;
    if (message === undefined || typeof message.type !== "string") return;
    if (message.type === "initialized") {
      this.initializedWaiter = this.resolveWaiter(
        this.initializedWaiter,
        undefined,
      );
      return;
    }
    if (message.type === "setup-complete") {
      this.setupWaiter = this.resolveWaiter(this.setupWaiter, undefined);
      return;
    }
    if (message.type === "busy") {
      this.detectionWaiter = this.resolveWaiter(this.detectionWaiter, []);
      this.detectionDimensions = undefined;
      return;
    }
    if (message.type === "detection-result") {
      const dimensions = this.detectionDimensions;
      if (dimensions === undefined) {
        this.fail(
          new Error("The AprilTag detector returned an unexpected result."),
        );
        return;
      }
      try {
        const detections = parseDetections(
          message.detections,
          dimensions.width,
          dimensions.height,
        );
        this.detectionWaiter = this.resolveWaiter(
          this.detectionWaiter,
          detections,
        );
        this.detectionDimensions = undefined;
      } catch (cause) {
        this.fail(
          cause instanceof Error
            ? cause
            : new Error("The AprilTag detector result was invalid."),
        );
      }
      return;
    }
    if (message.type === "error") {
      this.fail(
        new Error(
          typeof message.message === "string"
            ? message.message
            : "The AprilTag detector worker reported an error.",
        ),
      );
    }
  }

  private resolveWaiter<T>(waiter: Waiter<T> | undefined, value: T): undefined {
    if (waiter === undefined) return undefined;
    window.clearTimeout(waiter.timer);
    waiter.resolve(value);
    return undefined;
  }

  private fail(error: Error): void {
    for (const waiter of [
      this.initializedWaiter,
      this.setupWaiter,
      this.detectionWaiter,
    ]) {
      if (waiter === undefined) continue;
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.initializedWaiter = undefined;
    this.setupWaiter = undefined;
    this.detectionWaiter = undefined;
    this.detectionDimensions = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = false;
    this.initialization = undefined;
  }
}

const detector = new ShipmentAprilTagDetector();

export async function detectShipmentAprilTags(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<readonly ShipmentTagDetection[]> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAXIMUM_IMAGE_PIXELS ||
    data.length !== width * height * 4
  ) {
    return [];
  }
  return detector.detect(data, width, height);
}
