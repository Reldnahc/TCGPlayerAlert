import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";
import {
  orderRefKey,
  parseConnectionId,
  parseOrderRefKey,
  parseProviderOrderRef,
  type ProviderOrderRef,
} from "./marketplaces/identity.js";
import { FileSyncLease, type SyncLease } from "./sync-lease.js";

export const SHIPMENT_TAG_COUNT = 587;
export const SHIPMENT_TAG_REUSE_ORDER_GAP = 100;
const MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS = SHIPMENT_TAG_COUNT;

export interface ShipmentTagAssignment {
  readonly ref: ProviderOrderRef;
  readonly tagId: number;
  readonly assignedAt: string;
  readonly assignedSequence: number;
  readonly retiredSequence?: number;
}

export interface ShipmentTagAssignmentState {
  readonly version: 3;
  readonly lastSequence: number;
  readonly assignments: Readonly<Record<string, ShipmentTagAssignment>>;
}

export interface ShipmentTagAssigner {
  assign(ref: ProviderOrderRef, signal?: AbortSignal): Promise<number>;
}

export interface ShipmentTagRegistry extends ShipmentTagAssigner {
  reserveAll(
    refs: readonly ProviderOrderRef[],
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]>;
  reconcile(
    refs: readonly ProviderOrderRef[],
    completedConnectionIds?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]>;
  assigned(
    refs: readonly ProviderOrderRef[],
  ): Promise<readonly ShipmentTagAssignment[]>;
}

export interface JsonShipmentTagRegistryOptions {
  readonly now?: () => Date;
  readonly lease?: SyncLease;
  readonly legacyConnectionId?: string;
}

export function shipmentTagId(ref: ProviderOrderRef): number {
  const key = orderRefKey(ref);
  const digest = createHash("sha256")
    .update("tcgplayer-alert:shipment-tag:v2\0", "utf8")
    .update(key, "utf8")
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
  private readonly legacyConnectionId: string | undefined;

  constructor(path: string, options: JsonShipmentTagRegistryOptions = {}) {
    this.absolutePath = resolve(path);
    this.now = options.now ?? (() => new Date());
    this.lease =
      options.lease ?? new FileSyncLease(`${this.absolutePath}.lock`);
    this.legacyConnectionId =
      options.legacyConnectionId === undefined
        ? undefined
        : parseConnectionId(options.legacyConnectionId);
  }

  assign(ref: ProviderOrderRef, signal?: AbortSignal): Promise<number> {
    const normalized = parseProviderOrderRef(ref);
    const key = orderRefKey(normalized);
    return this.lease.runExclusive(async () => {
      const state = await this.load();
      const next = activateAndAssign(state, [normalized], this.now);
      if (!sameAssignmentState(state, next)) await this.save(next);
      return requiredAssignment(next, key).tagId;
    }, signal);
  }

  reserveAll(
    refs: readonly ProviderOrderRef[],
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]> {
    const normalized = normalizedRefs(refs);
    return this.lease.runExclusive(async () => {
      const state = await this.load();
      const next = activateAndAssign(state, normalized, this.now);
      if (!sameAssignmentState(state, next)) await this.save(next);
      return normalized.map((ref) =>
        requiredAssignment(next, orderRefKey(ref)),
      );
    }, signal);
  }

  reconcile(
    refs: readonly ProviderOrderRef[],
    completedConnectionIds?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<readonly ShipmentTagAssignment[]> {
    const normalized = normalizedRefs(refs);
    const active = new Set(normalized.map(orderRefKey));
    return this.lease.runExclusive(async () => {
      const state = await this.load();
      const reconciled = retireMissingAssignments(
        state,
        active,
        completedConnectionIds,
      );
      const next = activateAndAssign(reconciled, normalized, this.now);
      if (!sameAssignmentState(state, next)) await this.save(next);
      return normalized.map((ref) =>
        requiredAssignment(next, orderRefKey(ref)),
      );
    }, signal);
  }

  async assigned(
    refs: readonly ProviderOrderRef[],
  ): Promise<readonly ShipmentTagAssignment[]> {
    const normalized = normalizedRefs(refs);
    const state = await this.load();
    return normalized.flatMap((ref) => {
      const assignment = state.assignments[orderRefKey(ref)];
      return assignment === undefined ? [] : [assignment];
    });
  }

  private async load(): Promise<ShipmentTagAssignmentState> {
    try {
      const value = JSON.parse(
        await readFile(this.absolutePath, "utf8"),
      ) as unknown;
      const state = parseShipmentTagAssignmentState(
        value,
        this.legacyConnectionId,
      );
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
  return { version: 3, lastSequence: 0, assignments: {} };
}

function activateAndAssign(
  state: ShipmentTagAssignmentState,
  refs: readonly ProviderOrderRef[],
  now: () => Date,
): ShipmentTagAssignmentState {
  let changed = false;
  const assignments: Record<string, ShipmentTagAssignment> = {
    ...state.assignments,
  };
  for (const ref of refs) {
    const key = orderRefKey(ref);
    const existing = assignments[key];
    if (existing?.retiredSequence === undefined) continue;
    assignments[key] = {
      ref: existing.ref,
      tagId: existing.tagId,
      assignedAt: existing.assignedAt,
      assignedSequence: existing.assignedSequence,
    };
    changed = true;
  }
  return assignMissing(changed ? { ...state, assignments } : state, refs, now);
}

function retireMissingAssignments(
  state: ShipmentTagAssignmentState,
  active: ReadonlySet<string>,
  completedConnectionIds: ReadonlySet<string> | undefined,
): ShipmentTagAssignmentState {
  const assignments = Object.fromEntries(
    Object.entries(state.assignments).map(([key, assignment]) => {
      if (active.has(key) || assignment.retiredSequence !== undefined) {
        return [key, assignment];
      }
      if (
        completedConnectionIds !== undefined &&
        !completedConnectionIds.has(assignment.ref.connectionId)
      ) {
        return [key, assignment];
      }
      return [key, { ...assignment, retiredSequence: state.lastSequence }];
    }),
  );
  return { ...state, assignments };
}

function assignMissing(
  state: ShipmentTagAssignmentState,
  refs: readonly ProviderOrderRef[],
  now: () => Date,
): ShipmentTagAssignmentState {
  const missing = refs.filter(
    (ref) => state.assignments[orderRefKey(ref)] === undefined,
  );
  if (missing.length === 0) return state;
  const assignments: Record<string, ShipmentTagAssignment> = {
    ...state.assignments,
  };
  const assignedAt = now().toISOString();
  let lastSequence = state.lastSequence;
  for (const ref of [...missing].sort((left, right) =>
    orderRefKey(left).localeCompare(orderRefKey(right)),
  )) {
    const key = orderRefKey(ref);
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
    const preferred = shipmentTagId(ref);
    const tagId = firstAvailableTag(preferred, used);
    assignments[key] = {
      ref,
      tagId,
      assignedAt,
      assignedSequence,
    };
    lastSequence = assignedSequence;
  }
  return { version: 3, lastSequence, assignments };
}

function releaseEligibleAssignments(
  assignments: Record<string, ShipmentTagAssignment>,
  nextSequence: number,
): void {
  for (const [key, assignment] of Object.entries(assignments)) {
    if (
      assignment.retiredSequence !== undefined &&
      nextSequence - assignment.retiredSequence >= SHIPMENT_TAG_REUSE_ORDER_GAP
    ) {
      Reflect.deleteProperty(assignments, key);
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

function normalizedRefs(
  values: readonly ProviderOrderRef[],
): readonly ProviderOrderRef[] {
  return [
    ...new Map(
      values.map((value) => {
        const ref = parseProviderOrderRef(value);
        return [orderRefKey(ref), ref] as const;
      }),
    ).values(),
  ].sort((left, right) => orderRefKey(left).localeCompare(orderRefKey(right)));
}

function requiredAssignment(
  state: ShipmentTagAssignmentState,
  key: string,
): ShipmentTagAssignment {
  const assignment = state.assignments[key];
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
  legacyConnectionId?: string,
): ShipmentTagAssignmentState | undefined {
  if (!isRecord(value) || !isRecord(value.assignments)) return undefined;
  if (value.version === 1) {
    if (legacyConnectionId === undefined) return undefined;
    const versionTwo = migrateVersionOneState(value.assignments);
    return versionTwo === undefined
      ? undefined
      : migrateVersionTwoState(versionTwo, legacyConnectionId);
  }
  if (value.version === 2) {
    return legacyConnectionId === undefined
      ? undefined
      : migrateVersionTwoState(value, legacyConnectionId);
  }
  if (
    value.version !== 3 ||
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
  const assignments: Record<string, ShipmentTagAssignment> = {};
  for (const [key, raw] of entries) {
    if (
      !isVersionThreeAssignment(raw, key, tagIds) ||
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
    assignments[key] = {
      ref: parseProviderOrderRef(raw.ref),
      tagId: raw.tagId,
      assignedAt: raw.assignedAt,
      assignedSequence: raw.assignedSequence,
      ...(raw.retiredSequence === undefined
        ? {}
        : { retiredSequence: raw.retiredSequence }),
    };
  }
  return { version: 3, lastSequence: value.lastSequence, assignments };
}

function migrateVersionOneState(
  assignmentsValue: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(assignmentsValue).sort((left, right) => {
    const leftDate = isRecord(left[1]) ? String(left[1].assignedAt) : "";
    const rightDate = isRecord(right[1]) ? String(right[1].assignedAt) : "";
    return leftDate.localeCompare(rightDate) || left[0].localeCompare(right[0]);
  });
  if (entries.length > MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS) return undefined;
  const tagIds = new Set<number>();
  const assignments: Record<string, unknown> = {};
  for (const [index, [orderNumber, raw]] of entries.entries()) {
    if (!isLegacyBaseAssignment(raw, orderNumber, tagIds)) return undefined;
    assignments[orderNumber] = {
      orderNumber,
      tagId: raw.tagId as number,
      assignedAt: raw.assignedAt as string,
      assignedSequence: index + 1,
    };
  }
  return { version: 2, lastSequence: entries.length, assignments };
}

function migrateVersionTwoState(
  value: Record<string, unknown>,
  legacyConnectionId: string,
): ShipmentTagAssignmentState | undefined {
  if (
    value.version !== 2 ||
    !Number.isSafeInteger(value.lastSequence) ||
    Number(value.lastSequence) < 0 ||
    !isRecord(value.assignments)
  ) {
    return undefined;
  }
  const entries = Object.entries(value.assignments);
  if (entries.length > MAXIMUM_SHIPMENT_TAG_ASSIGNMENTS) return undefined;
  const tagIds = new Set<number>();
  const sequences = new Set<number>();
  const assignments: Record<string, ShipmentTagAssignment> = {};
  for (const [orderNumber, raw] of entries) {
    if (
      !isLegacyBaseAssignment(raw, orderNumber, tagIds) ||
      !Number.isSafeInteger(raw.assignedSequence) ||
      Number(raw.assignedSequence) < 1 ||
      Number(raw.assignedSequence) > Number(value.lastSequence) ||
      sequences.has(Number(raw.assignedSequence)) ||
      (raw.retiredSequence !== undefined &&
        (!Number.isSafeInteger(raw.retiredSequence) ||
          Number(raw.retiredSequence) < Number(raw.assignedSequence) ||
          Number(raw.retiredSequence) > Number(value.lastSequence)))
    ) {
      return undefined;
    }
    sequences.add(Number(raw.assignedSequence));
    const ref = {
      connectionId: legacyConnectionId,
      remoteId: orderNumber,
    };
    assignments[orderRefKey(ref)] = {
      ref,
      tagId: Number(raw.tagId),
      assignedAt: String(raw.assignedAt),
      assignedSequence: Number(raw.assignedSequence),
      ...(raw.retiredSequence === undefined
        ? {}
        : { retiredSequence: Number(raw.retiredSequence) }),
    };
  }
  return {
    version: 3,
    lastSequence: Number(value.lastSequence),
    assignments,
  };
}

function isLegacyBaseAssignment(
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

function isVersionThreeAssignment(
  raw: unknown,
  key: string,
  tagIds: Set<number>,
): raw is Record<string, unknown> & {
  ref: ProviderOrderRef;
  tagId: number;
  assignedAt: string;
  assignedSequence: number;
  retiredSequence?: number;
} {
  if (!isRecord(raw)) return false;
  try {
    const ref = parseProviderOrderRef(raw.ref);
    parseOrderRefKey(key);
    if (orderRefKey(ref) !== key) return false;
  } catch {
    return false;
  }
  if (
    !Number.isSafeInteger(raw.tagId) ||
    Number(raw.tagId) < 0 ||
    Number(raw.tagId) >= SHIPMENT_TAG_COUNT ||
    typeof raw.assignedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.assignedAt)) ||
    tagIds.has(Number(raw.tagId))
  ) {
    return false;
  }
  tagIds.add(Number(raw.tagId));
  return true;
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
