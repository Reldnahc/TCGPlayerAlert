import {
  TAG36H11_BIT_COORDINATES,
  TAG36H11_CODES,
} from "./april-tag-36h11-data.js";

export const SHIPMENT_TAG_FAMILY = "APRILTAG_36h11" as const;

export interface FiducialMarkerMatrix {
  readonly family: typeof SHIPMENT_TAG_FAMILY;
  readonly tagId: number;
  readonly rows: readonly string[];
  readonly quietZoneModules: number;
  readonly sizeMm: number;
}

export interface ShipmentTagDetection {
  readonly tagId: number;
  readonly hammingDistance: number;
  readonly corners: readonly {
    readonly x: number;
    readonly y: number;
  }[];
}

const TAG_BODY_MODULES = 8;
const TAG_DATA_BITS = 36;

export function createShipmentAprilTag(tagId: number): FiducialMarkerMatrix {
  if (!Number.isInteger(tagId) || tagId < 0 || tagId >= TAG36H11_CODES.length) {
    throw new TypeError(
      `An AprilTag id between 0 and ${String(TAG36H11_CODES.length - 1)} is required.`,
    );
  }
  const code = TAG36H11_CODES[tagId];
  if (code === undefined)
    throw new TypeError("The AprilTag id is unavailable.");
  const modules = Array.from({ length: TAG_BODY_MODULES }, () =>
    Array.from({ length: TAG_BODY_MODULES }, () => "1"),
  );
  for (const [bit, coordinate] of TAG36H11_BIT_COORDINATES.entries()) {
    const [x, y] = coordinate;
    if ((code & (1n << BigInt(TAG_DATA_BITS - bit - 1))) === 0n) continue;
    const row = modules[y];
    if (row?.[x] === undefined) {
      throw new Error("The generated AprilTag family layout is invalid.");
    }
    row[x] = "0";
  }
  return {
    family: SHIPMENT_TAG_FAMILY,
    tagId,
    rows: modules.map((row) => row.join("")),
    quietZoneModules: 1,
    sizeMm: 14,
  };
}
