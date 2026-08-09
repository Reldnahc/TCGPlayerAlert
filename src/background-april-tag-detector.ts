import { access, readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ShipmentTagDetection } from "./april-tag.js";
import type { CameraFrame } from "./camera-capture.js";
import { SHIPMENT_TAG_COUNT } from "./shipment-scanner.js";

const DETECTION_STRUCTURE_LIMIT = 100;

interface VendorDetection {
  readonly id?: unknown;
  readonly hamming?: unknown;
  readonly corners?: unknown;
}

interface VendorDetector {
  initialize(): Promise<void>;
  setupDetector(family: string, hammingDistance: number): number;
  setParameters(parameters: Readonly<Record<string, unknown>>): void;
  detect(pixels: Uint8Array, width: number, height: number): unknown;
  cleanup(): void;
}

type VendorDetectorConstructor = new () => VendorDetector;

export interface ShipmentTagDetector {
  detect(frame: CameraFrame): Promise<readonly ShipmentTagDetection[]>;
  close(): void;
}

export class WasmShipmentTagDetector implements ShipmentTagDetector {
  private detector: Promise<VendorDetector> | undefined;

  async detect(frame: CameraFrame): Promise<readonly ShipmentTagDetection[]> {
    if (
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.grayscale.length !== frame.width * frame.height
    ) {
      return [];
    }
    const detector = await (this.detector ??= createVendorDetector());
    return parseDetections(
      detector.detect(frame.grayscale, frame.width, frame.height),
      frame.width,
      frame.height,
    );
  }

  close(): void {
    const detector = this.detector;
    this.detector = undefined;
    if (detector !== undefined) {
      void detector.then((value) => value.cleanup()).catch(() => undefined);
    }
  }
}

async function createVendorDetector(): Promise<VendorDetector> {
  const directory = await vendorDirectory();
  const [familiesSource, wasmSource, wrapperSource, wasmBinary] =
    await Promise.all([
      readFile(resolve(directory, "tag-families.js"), "utf8"),
      readFile(resolve(directory, "apriltag_wasm.js"), "utf8"),
      readFile(resolve(directory, "apriltag-wasm-wrapper.js"), "utf8"),
      readFile(resolve(directory, "apriltag_wasm.wasm")),
    ]);
  const quietConsole = {
    log: () => undefined,
    error: () => undefined,
    warn: () => undefined,
  };
  const context = createContext({
    console: quietConsole,
    window: {},
    URL,
    Response,
    TextDecoder,
    TextEncoder,
    WebAssembly,
    performance,
    fetch: (input: unknown) => {
      if (String(input) !== "apriltag_wasm.wasm") {
        throw new Error("The AprilTag runtime requested an unknown asset.");
      }
      return Promise.resolve(
        new Response(wasmBinary, {
          headers: { "content-type": "application/wasm" },
        }),
      );
    },
  });
  runInContext(familiesSource, context, { filename: "tag-families.js" });
  runInContext(wasmSource, context, { filename: "apriltag_wasm.js" });
  runInContext(wrapperSource, context, {
    filename: "apriltag-wasm-wrapper.js",
  });
  const Constructor = runInContext(
    "AprilTagDetector",
    context,
  ) as VendorDetectorConstructor;
  const detector = new Constructor();
  await detector.initialize();
  if (detector.setupDetector("tag36h11", 2) !== 0) {
    detector.cleanup();
    throw new Error("The AprilTag 36h11 detector could not be configured.");
  }
  detector.setParameters({
    quadDecimate: 1,
    quadSigma: 0,
    refineEdges: true,
    decodeSharpening: 0.25,
    debug: false,
  });
  return detector;
}

async function vendorDirectory(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL("./vendor/apriltag-js/", import.meta.url)),
    resolve("dist/vendor/apriltag-js"),
    resolve("src/web/public/vendor/apriltag-js"),
  ];
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, "apriltag_wasm.wasm"));
      return candidate;
    } catch {
      // Try the next deliberate build/source location.
    }
  }
  throw new Error("The AprilTag runtime assets are unavailable.");
}

function parseDetections(
  value: unknown,
  width: number,
  height: number,
): readonly ShipmentTagDetection[] {
  if (!Array.isArray(value) || value.length > DETECTION_STRUCTURE_LIMIT) {
    throw new Error("The AprilTag detector returned an invalid result.");
  }
  return value.map((candidate) => {
    const detection = asRecord(candidate) as VendorDetection | undefined;
    const tagId = detection?.id;
    const hammingDistance = detection?.hamming;
    const corners = detection?.corners;
    if (
      !Number.isInteger(tagId) ||
      Number(tagId) < 0 ||
      Number(tagId) >= SHIPMENT_TAG_COUNT ||
      typeof hammingDistance !== "number" ||
      !Number.isFinite(hammingDistance) ||
      hammingDistance < 0 ||
      !Array.isArray(corners) ||
      corners.length !== 4
    ) {
      throw new Error("The AprilTag detector returned malformed data.");
    }
    return {
      tagId: Number(tagId),
      hammingDistance: Math.round(hammingDistance),
      corners: corners.map((corner) => {
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
          throw new Error("The AprilTag detector returned invalid corners.");
        }
        return { x, y };
      }),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
