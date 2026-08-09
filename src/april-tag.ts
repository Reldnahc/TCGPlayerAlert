import "js-aruco2/src/dictionaries/apriltag_36h11.js";

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

const MAXIMUM_IMAGE_PIXELS = 16_000_000;
const { default: aruco } = await import("js-aruco2");
const dictionary = new aruco.AR.Dictionary(SHIPMENT_TAG_FAMILY);
const detector = new aruco.AR.Detector({
  dictionaryName: SHIPMENT_TAG_FAMILY,
  maxHammingDistance: 2,
});

export function createShipmentAprilTag(tagId: number): FiducialMarkerMatrix {
  if (
    !Number.isInteger(tagId) ||
    tagId < 0 ||
    tagId >= dictionary.codeList.length
  ) {
    throw new TypeError(
      `An AprilTag id between 0 and ${String(dictionary.codeList.length - 1)} is required.`,
    );
  }
  const code = dictionary.codeList[tagId];
  if (code === undefined)
    throw new TypeError("The AprilTag id is unavailable.");
  const dataSize = dictionary.markSize - 2;
  const border = "1".repeat(dictionary.markSize);
  const rows = [
    border,
    ...Array.from({ length: dataSize }, (_, row) => {
      const data = Array.from({ length: dataSize }, (_, column) =>
        code[row * dataSize + column] === "1" ? "0" : "1",
      ).join("");
      return `1${data}1`;
    }),
    border,
  ];
  return {
    family: SHIPMENT_TAG_FAMILY,
    tagId,
    rows,
    quietZoneModules: 1,
    sizeMm: 14,
  };
}

export function detectShipmentAprilTags(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): readonly ShipmentTagDetection[] {
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
  return detector.detectImage(width, height, data).map((marker) => ({
    tagId: marker.id,
    hammingDistance: marker.hammingDistance,
    corners: marker.corners,
  }));
}
