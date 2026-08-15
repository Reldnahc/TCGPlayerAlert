import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";
import { FileSyncLease, type SyncLease } from "./sync-lease.js";

export const SHIPMENT_TAG_COUNT = 587;
export const SHIPMENT_TAG_REUSE_ORDER_GAP = 100;
const MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS = SHIPMENT_TAG_COUNT;

export interface ShipmentTagAssignment {
  readonly orderNumber: string;
  readonly tagId: number;
  readonly assignedAt: string;
  readonly assignedSequence: number;
  readonly retiredSequence?: number;
}

export interface ShipmentTagAssignmentState {
  readonly version: 2;
  readonly lastSequence: number;
  readonly assignments: Readonly<Record<string, ShipmentTagAssignment>>;
}

export interface ShipmentTagAssigner {
  assign(orderNumber: string, signal?: AbortSignal): Promise<number>;
}

export interface ShipmentTagRegistry extends ShipmentTagAssigner {
  reserveAll(
    orderNumbers: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]>;
  reconcile(
    orderNumbers: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]>;
  assigned(
    orderNumbers: readonly string[],
  ): Promise<readonly ShipmentTagAssignment[]>;
}

export interface JsonShipmentTagRegistryOptions {
  readonly now?: () => Date;
  readonly lease?: SyncLease;
}

export function shipmentTagId(orderNumber: string): number {
  const normalized = safeOrderNumber(orderNumber);
  const digest = createHash("sha256")
    .update("tcgplayer-alert:shipment-tag:v1\0", "utf8")
    .update(normalized, "utf8")
    .digest();
  return digest.readUInt32BE(0) % SHIPMENT_TAG_COUNT;
}

export function shipmentTagAssignmentsPath(scanStateFile: string): string {
  return `${scanStateFile}.tags`;
}

export class JsonShipmentTagRegistry implements ShipmentTagRegistry {
  private readonly absolutePath: string;
  private readonly now: () => Date;
  private readonly lease: SyncLease;

  constructor(path: string, options: JsonShipmentTagRegistryOptions = {}) {
    this.absolutePath = resolve(path);
    this.now = options.now ?? (() => new Date());
    this.lease =
      options.lease ?? new FileSyncLease(`${this.absolutePath}.lock`);
  }

  assign(orderNumber: string, signal?: AbortSignal): Promise<number> {
    const normalized = safeOrderNumber(orderNumber);
    return this.lease.runExclusive(async () => {
      const state = await this.load();
      const next = activateAndAssign(state, [normalized], this.now);
      if (!sameAssignmentState(state, next)) await this.save(next);
      return requiredAssignment(next, normalized).tagId;
    }, signal);
  }

  reserveAll(
    orderNumbers: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]> {
    const normalized = normalizedOrderNumbers(orderNumbers);
    return this.lease.runExclusive(async () => {
      const state = await this.load();
      const next = activateAndAssign(state, normalized, this.now);
      if (!sameAssignmentState(state, next)) await this.save(next);
      return normalized.map((orderNumber) =>
        requiredAssignment(next, orderNumber),
      );
    }, signal);
  }

  reconcile(
    orderNumbers: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]> {
    const normalized = normalizedOrderNumbers(orderNumbers);
    const active = new Set(normalized);
    return this.lease.runExclusive(async () => {
      const state = await this.load();
      const reconciled = retireMissingAssignments(state, active);
      const next = activateAndAssign(reconciled, normalized, this.now);
      if (!sameAssignmentState(state, next)) await this.save(next);
      return normalized.map((orderNumber) =>
        requiredAssignment(next, orderNumber),
      );
    }, signal);
  }

  async assigned(
    orderNumbers: readonly string[],
  ): Promise<readonly ShipmentTagAssignment[]> {
    const normalized = normalizedOrderNumbers(orderNumbers);
    const state = await this.load();
    return normalized.flatMap((orderNumber) => {
      const assignment = state.assignments[orderNumber];
      return assignment === undefined ? [] : [assignment];
    });
  }

  private async load(): Promise<ShipmentTagAssignmentState> {
    try {
      const value = JSON.parse(
        await readFile(this.absolutePath, "utf8"),
      ) as unknown;
      const state = parseShipmentTagAssignmentState(value);
      if (state === undefined) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The shipment-tag assignment schema is unsupported or unsafe.",
        );
      }
      return state;
    } catch (error) {
      if (isMissingFile(error)) return emptyShipmentTagAssignmentState();
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read shipment-tag assignments.",
        { cause: error },
      );
    }
  }

  private async save(state: ShipmentTagAssignmentState): Promise<void> {
    const temporaryPath = `${this.absolutePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.absolutePath), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to persist shipment-tag assignments atomically.",
        { cause: error },
      );
    }
  }
}

export function emptyShipmentTagAssignmentState(): ShipmentTagAssignmentState {
  return { version: 2, lastSequence: 0, assignments: {} };
}

function activateAndAssign(
  state: ShipmentTagAssignmentState,
  orderNumbers: readonly string[],
  now: () => Date,
): ShipmentTagAssignmentState {
  let changed = false;
  const assignments: Record<string, ShipmentTagAssignment> = {
    ...state.assignments,
  };
  for (const orderNumber of orderNumbers) {
    const existing = assignments[orderNumber];
    if (existing?.retiredSequence === undefined) continue;
    assignments[orderNumber] = {
      orderNumber: existing.orderNumber,
      tagId: existing.tagId,
      assignedAt: existing.assignedAt,
      assignedSequence: existing.assignedSequence,
    };
    changed = true;
  }
  return assignMissing(
    changed ? { ...state, assignments } : state,
    orderNumbers,
    now,
  );
}

function retireMissingAssignments(
  state: ShipmentTagAssignmentState,
  active: ReadonlySet<string>,
): ShipmentTagAssignmentState {
  const assignments = Object.fromEntries(
    Object.entries(state.assignments).map(([orderNumber, assignment]) => {
      if (active.has(orderNumber) || assignment.retiredSequence !== undefined) {
        return [orderNumber, assignment];
      }
      return [
        orderNumber,
        { ...assignment, retiredSequence: state.lastSequence },
      ];
    }),
  );
  return { ...state, assignments };
}

function assignMissing(
  state: ShipmentTagAssignmentState,
  orderNumbers: readonly string[],
  now: () => Date,
): ShipmentTagAssignmentState {
  const missing = orderNumbers.filter(
    (orderNumber) => state.assignments[orderNumber] === undefined,
  );
  if (missing.length === 0) return state;
  const assignments: Record<string, ShipmentTagAssignment> = {
    ...state.assignments,
  };
  const assignedAt = now().toISOString();
  let lastSequence = state.lastSequence;
  for (const orderNumber of [...missing].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const assignedSequence = lastSequence + 1;
    releaseEligibleAssignments(assignments, assignedSequence);
    if (Object.keys(assignments).length >= MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS) {
      throw new ApplicationError(
        "REVIEW_REQUIRED",
        "No unique shipment marker is available. Printing stopped before a duplicate tag could be created.",
      );
    }
    const used = new Set(
      Object.values(assignments).map((assignment) => assignment.tagId),
    );
    const preferred = shipmentTagId(orderNumber);
    const tagId = firstAvailableTag(preferred, used);
    assignments[orderNumber] = {
      orderNumber,
      tagId,
      assignedAt,
      assignedSequence,
    };
    lastSequence = assignedSequence;
  }
  return { version: 2, lastSequence, assignments };
}

function releaseEligibleAssignments(
  assignments: Record<string, ShipmentTagAssignment>,
  nextSequence: number,
): void {
  for (const [orderNumber, assignment] of Object.entries(assignments)) {
    if (
      assignment.retiredSequence !== undefined &&
      nextSequence - assignment.retiredSequence >= SHIPMENT_TAG_REUSE_ORDER_GAP
    ) {
      Reflect.deleteProperty(assignments, orderNumber);
    }
  }
}

function firstAvailableTag(
  preferred: number,
  used: ReadonlySet<number>,
): number {
  for (let offset = 0; offset < SHIPMENT_TAG_COUNT; offset += 1) {
    const candidate = (preferred + offset) % SHIPMENT_TAG_COUNT;
    if (!used.has(candidate)) return candidate;
  }
  throw new ApplicationError(
    "REVIEW_REQUIRED",
    "No unique shipment marker is available. Printing stopped before a duplicate tag could be created.",
  );
}

function normalizedOrderNumbers(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(safeOrderNumber))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function requiredAssignment(
  state: ShipmentTagAssignmentState,
  orderNumber: string,
): ShipmentTagAssignment {
  const assignment = state.assignments[orderNumber];
  if (assignment === undefined) {
    throw new ApplicationError(
      "PERSISTENCE_ERROR",
      "A reserved shipment tag is missing.",
    );
  }
  return assignment;
}

function sameAssignmentState(
  left: ShipmentTagAssignmentState,
  right: ShipmentTagAssignmentState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseShipmentTagAssignmentState(
  value: unknown,
): ShipmentTagAssignmentState | undefined {
  if (!isRecord(value) || !isRecord(value.assignments)) return undefined;
  if (value.version === 1) return migrateVersionOneState(value.assignments);
  if (
    value.version !== 2 ||
    typeof value.lastSequence !== "number" ||
    !Number.isInteger(value.lastSequence) ||
    value.lastSequence < 0
  ) {
    return undefined;
  }
  const entries = Object.entries(value.assignments);
  if (entries.length > MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS) return undefined;
  const tagIds = new Set<number>();
  const assignedSequences = new Set<number>();
  for (const [orderNumber, raw] of entries) {
    if (
      !isBaseAssignment(raw, orderNumber, tagIds) ||
      typeof raw.assignedSequence !== "number" ||
      !Number.isInteger(raw.assignedSequence) ||
      raw.assignedSequence < 1 ||
      raw.assignedSequence > value.lastSequence ||
      assignedSequences.has(raw.assignedSequence) ||
      (raw.retiredSequence !== undefined &&
        (typeof raw.retiredSequence !== "number" ||
          !Number.isInteger(raw.retiredSequence) ||
          raw.retiredSequence < raw.assignedSequence ||
          raw.retiredSequence > value.lastSequence))
    ) {
      return undefined;
    }
    assignedSequences.add(raw.assignedSequence);
  }
  return value as unknown as ShipmentTagAssignmentState;
}

function migrateVersionOneState(
  assignmentsValue: Record<string, unknown>,
): ShipmentTagAssignmentState | undefined {
  const entries = Object.entries(assignmentsValue).sort((left, right) => {
    const leftDate = isRecord(left[1]) ? String(left[1].assignedAt) : "";
    const rightDate = isRecord(right[1]) ? String(right[1].assignedAt) : "";
    return leftDate.localeCompare(rightDate) || left[0].localeCompare(right[0]);
  });
  if (entries.length > MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS) return undefined;
  const tagIds = new Set<number>();
  const assignments: Record<string, ShipmentTagAssignment> = {};
  for (const [index, [orderNumber, raw]] of entries.entries()) {
    if (!isBaseAssignment(raw, orderNumber, tagIds)) return undefined;
    assignments[orderNumber] = {
      orderNumber,
      tagId: raw.tagId as number,
      assignedAt: raw.assignedAt as string,
      assignedSequence: index + 1,
    };
  }
  return { version: 2, lastSequence: entries.length, assignments };
}

function isBaseAssignment(
  raw: unknown,
  orderNumber: string,
  tagIds: Set<number>,
): raw is Record<string, unknown> {
  if (
    !isRecord(raw) ||
    !isSafeOrderNumberValue(orderNumber) ||
    raw.orderNumber !== orderNumber ||
    typeof raw.tagId !== "number" ||
    !Number.isInteger(raw.tagId) ||
    raw.tagId < 0 ||
    raw.tagId >= SHIPMENT_TAG_COUNT ||
    typeof raw.assignedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.assignedAt)) ||
    tagIds.has(raw.tagId)
  ) {
    return false;
  }
  tagIds.add(raw.tagId);
  return true;
}

function safeOrderNumber(value: string): string {
  const normalized = value.trim();
  if (!isSafeOrderNumberValue(normalized)) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "The order number is invalid.",
    );
  }
  return normalized;
}

function isSafeOrderNumberValue(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    !containsControlCharacter(value) &&
    value.trim() === value &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
