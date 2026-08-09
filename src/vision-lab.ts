export type VisionLabCaseId = "unique" | "missing" | "ambiguous";

export interface VisionLabOrder {
  readonly orderNumber: string;
  readonly buyerName: string;
  readonly addressLines: readonly string[];
  readonly verificationCode: string;
}

export interface VisionLabCase {
  readonly id: VisionLabCaseId;
  readonly label: string;
  readonly detail: string;
  readonly printedOrder: VisionLabOrder;
  readonly candidates: readonly VisionLabOrder[];
}

export type VisionLabResolution =
  | {
      readonly state: "match";
      readonly code: string;
      readonly order: VisionLabOrder;
    }
  | {
      readonly state: "duplicate";
      readonly code: string;
      readonly order: VisionLabOrder;
    }
  | {
      readonly state: "ambiguous";
      readonly code: string;
      readonly orders: readonly VisionLabOrder[];
    }
  | {
      readonly state: "missing";
      readonly code: string;
    };

const uniqueOrder: VisionLabOrder = {
  orderNumber: "LAB-1001",
  buyerName: "Morgan Sample",
  addressLines: ["Morgan Sample", "125 Example Avenue", "Test City, IL 60000"],
  verificationCode: "TCGA1:7K4M9Q2V8D6R3X5P",
};

const firstAmbiguousOrder: VisionLabOrder = {
  orderNumber: "LAB-2001",
  buyerName: "Taylor Example",
  addressLines: [
    "Taylor Example",
    "40 Demonstration Road",
    "Sampletown, IL 60001",
  ],
  verificationCode: "TCGA1:2N8C4W7H5J9M3R6T",
};

const secondAmbiguousOrder: VisionLabOrder = {
  ...firstAmbiguousOrder,
  orderNumber: "LAB-2002",
};

const missingOrder: VisionLabOrder = {
  orderNumber: "LAB-3001",
  buyerName: "Jordan Fixture",
  addressLines: ["Jordan Fixture", "88 Prototype Lane", "Mock City, IL 60002"],
  verificationCode: "TCGA1:9F3P6T2X7K4M8Q5V",
};

export const VISION_LAB_CASES: readonly VisionLabCase[] = [
  {
    id: "unique",
    label: "One match",
    detail: "The code identifies exactly one fake ready-to-ship order.",
    printedOrder: uniqueOrder,
    candidates: [uniqueOrder],
  },
  {
    id: "missing",
    label: "No match",
    detail: "The label code is absent from the fake ready-order pool.",
    printedOrder: missingOrder,
    candidates: [uniqueOrder, firstAmbiguousOrder],
  },
  {
    id: "ambiguous",
    label: "Two matches",
    detail: "Two fake orders intentionally share one code.",
    printedOrder: firstAmbiguousOrder,
    candidates: [firstAmbiguousOrder, secondAmbiguousOrder],
  },
];

export function parseVisionLabCaseId(
  value: unknown,
): VisionLabCaseId | undefined {
  return value === "unique" || value === "missing" || value === "ambiguous"
    ? value
    : undefined;
}

export function visionLabCase(caseId: VisionLabCaseId): VisionLabCase {
  const result = VISION_LAB_CASES.find((candidate) => candidate.id === caseId);
  if (result === undefined) throw new TypeError("Unknown vision lab case.");
  return result;
}

export function resolveVisionLabScan(
  code: string,
  candidates: readonly VisionLabOrder[],
  completedOrderNumbers: ReadonlySet<string> = new Set(),
): VisionLabResolution {
  const matches = candidates.filter(
    (candidate) => candidate.verificationCode === code,
  );
  if (matches.length === 0) return { state: "missing", code };
  if (matches.length > 1) return { state: "ambiguous", code, orders: matches };
  const order = matches[0];
  if (order === undefined) return { state: "missing", code };
  return completedOrderNumbers.has(order.orderNumber)
    ? { state: "duplicate", code, order }
    : { state: "match", code, order };
}
