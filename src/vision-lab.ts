export type VisionLabCaseId = "unique" | "missing" | "ambiguous" | "basket";

export interface VisionLabOrder {
  readonly orderNumber: string;
  readonly buyerName: string;
  readonly addressLines: readonly string[];
  readonly tagId: number;
}

export interface VisionLabCase {
  readonly id: VisionLabCaseId;
  readonly label: string;
  readonly detail: string;
  readonly printedOrders: readonly VisionLabOrder[];
  readonly candidates: readonly VisionLabOrder[];
}

export type VisionLabResolution =
  | {
      readonly state: "match";
      readonly tagId: number;
      readonly order: VisionLabOrder;
    }
  | {
      readonly state: "duplicate";
      readonly tagId: number;
      readonly order: VisionLabOrder;
    }
  | {
      readonly state: "ambiguous";
      readonly tagId: number;
      readonly orders: readonly VisionLabOrder[];
    }
  | {
      readonly state: "missing";
      readonly tagId: number;
    };

const uniqueOrder: VisionLabOrder = {
  orderNumber: "LAB-1001",
  buyerName: "Morgan Sample",
  addressLines: ["Morgan Sample", "125 Example Avenue", "Test City, IL 60000"],
  tagId: 7,
};

const firstAmbiguousOrder: VisionLabOrder = {
  orderNumber: "LAB-2001",
  buyerName: "Taylor Example",
  addressLines: [
    "Taylor Example",
    "40 Demonstration Road",
    "Sampletown, IL 60001",
  ],
  tagId: 18,
};

const secondAmbiguousOrder: VisionLabOrder = {
  ...firstAmbiguousOrder,
  orderNumber: "LAB-2002",
};

const missingOrder: VisionLabOrder = {
  orderNumber: "LAB-3001",
  buyerName: "Jordan Fixture",
  addressLines: ["Jordan Fixture", "88 Prototype Lane", "Mock City, IL 60002"],
  tagId: 29,
};

const basketOrders: readonly VisionLabOrder[] = [
  {
    orderNumber: "LAB-4001",
    buyerName: "Avery Fixture",
    addressLines: [
      "Avery Fixture",
      "14 Sandbox Street",
      "Example City, IL 60010",
    ],
    tagId: 41,
  },
  {
    orderNumber: "LAB-4002",
    buyerName: "Bailey Sample",
    addressLines: [
      "Bailey Sample",
      "260 Prototype Court",
      "Test City, IL 60011",
    ],
    tagId: 84,
  },
  {
    orderNumber: "LAB-4003",
    buyerName: "Cameron Demo",
    addressLines: ["Cameron Demo", "9 Validation Way", "Mock City, IL 60012"],
    tagId: 126,
  },
  {
    orderNumber: "LAB-4004",
    buyerName: "Drew Example",
    addressLines: [
      "Drew Example",
      "711 Fixture Boulevard",
      "Sampletown, IL 60013",
    ],
    tagId: 205,
  },
  {
    orderNumber: "LAB-4005",
    buyerName: "Emery Mock",
    addressLines: ["Emery Mock", "52 Simulation Circle", "Test City, IL 60014"],
    tagId: 333,
  },
];

export const VISION_LAB_CASES: readonly VisionLabCase[] = [
  {
    id: "unique",
    label: "One match",
    detail: "The tag identifies exactly one fake ready-to-ship order.",
    printedOrders: [uniqueOrder],
    candidates: [uniqueOrder],
  },
  {
    id: "missing",
    label: "No match",
    detail: "The label tag is absent from the fake ready-order pool.",
    printedOrders: [missingOrder],
    candidates: [uniqueOrder, firstAmbiguousOrder],
  },
  {
    id: "ambiguous",
    label: "Two matches",
    detail: "Two fake orders intentionally share one tag.",
    printedOrders: [firstAmbiguousOrder],
    candidates: [firstAmbiguousOrder, secondAmbiguousOrder],
  },
  {
    id: "basket",
    label: "Basket of 5",
    detail: "Five unique fake labels share one ready-order pool.",
    printedOrders: basketOrders,
    candidates: basketOrders,
  },
];

export function parseVisionLabCaseId(
  value: unknown,
): VisionLabCaseId | undefined {
  return value === "unique" ||
    value === "missing" ||
    value === "ambiguous" ||
    value === "basket"
    ? value
    : undefined;
}

export function visionLabCase(caseId: VisionLabCaseId): VisionLabCase {
  const result = VISION_LAB_CASES.find((candidate) => candidate.id === caseId);
  if (result === undefined) throw new TypeError("Unknown vision lab case.");
  return result;
}

export function parseVisionLabLabelIndex(
  value: unknown,
  caseId: VisionLabCaseId,
): number | undefined {
  const labelIndex = value === undefined ? 0 : value;
  return Number.isInteger(labelIndex) &&
    (labelIndex as number) >= 0 &&
    (labelIndex as number) < visionLabCase(caseId).printedOrders.length
    ? (labelIndex as number)
    : undefined;
}

export function visionLabPrintedOrder(
  caseId: VisionLabCaseId,
  labelIndex = 0,
): VisionLabOrder {
  const order = visionLabCase(caseId).printedOrders[labelIndex];
  if (order === undefined) throw new TypeError("Unknown vision lab label.");
  return order;
}

export function resolveVisionLabScan(
  tagId: number,
  candidates: readonly VisionLabOrder[],
  completedOrderNumbers: ReadonlySet<string> = new Set(),
): VisionLabResolution {
  const matches = candidates.filter((candidate) => candidate.tagId === tagId);
  if (matches.length === 0) return { state: "missing", tagId };
  if (matches.length > 1) return { state: "ambiguous", tagId, orders: matches };
  const order = matches[0];
  if (order === undefined) return { state: "missing", tagId };
  return completedOrderNumbers.has(order.orderNumber)
    ? { state: "duplicate", tagId, order }
    : { state: "match", tagId, order };
}
