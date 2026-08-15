import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";
import { FileSyncLease, type SyncLease } from "./sync-lease.js";

export const SHIPMENT_TAG_COUNT = 587;
const MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS = SHIPMENT_TAG_COUNT;

export interface ShipmentTagAssignment {
  readonly orderNumber: string;
  readonly tagId: number;
  readonly assignedAt: string;
}

export interface ShipmentTagAssignmentState {
  readonly version: 1;
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
      const existing = state.assignments[normalized];
      if (existing !== undefined) return existing.tagId;
      const next = assignMissing(state, [normalized], this.now);
      await this.save(next);
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
      const next = assignMissing(state, normalized, this.now);
      if (next !== state) await this.save(next);
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
      const retained = Object.fromEntries(
        Object.entries(state.assignments).filter(([orderNumber]) =>
          active.has(orderNumber),
        ),
      );
      const pruned: ShipmentTagAssignmentState = {
        version: 1,
        assignments: retained,
      };
      const next = assignMissing(pruned, normalized, this.now);
      if (!sameAssignments(state, next)) await this.save(next);
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
      if (!isShipmentTagAssignmentState(value)) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The shipment-tag assignment schema is unsupported or unsafe.",
        );
      }
      return value;
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
  return { version: 1, assignments: {} };
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
  if (
    Object.keys(state.assignments).length + missing.length >
    MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS
  ) {
    throw new ApplicationError(
      "REVIEW_REQUIRED",
      "No unique shipment marker is available. Printing stopped before a duplicate tag could be created.",
    );
  }
  const assignments: Record<string, ShipmentTagAssignment> = {
    ...state.assignments,
  };
  const used = new Set(
    Object.values(assignments).map((assignment) => assignment.tagId),
  );
  const assignedAt = now().toISOString();
  for (const orderNumber of [...missing].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const preferred = shipmentTagId(orderNumber);
    const tagId = firstAvailableTag(preferred, used);
    assignments[orderNumber] = { orderNumber, tagId, assignedAt };
    used.add(tagId);
  }
  return { version: 1, assignments };
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

function sameAssignments(
  left: ShipmentTagAssignmentState,
  right: ShipmentTagAssignmentState,
): boolean {
  return JSON.stringify(left.assignments) === JSON.stringify(right.assignments);
}

function isShipmentTagAssignmentState(
  value: unknown,
): value is ShipmentTagAssignmentState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.assignments)) {
    return false;
  }
  const entries = Object.entries(value.assignments);
  if (entries.length > MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS) return false;
  const tagIds = new Set<number>();
  for (const [orderNumber, raw] of entries) {
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
  }
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
