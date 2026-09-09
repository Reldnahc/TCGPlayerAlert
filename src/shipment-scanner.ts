import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ShipmentScannerConfig } from "./config.js";
import { ApplicationError } from "./errors.js";
import {
  parseMutationResult,
  parseOrderSummary,
  type MutationResult,
  type OrderSummary,
  type ProviderIssue,
} from "./marketplaces/contracts.js";
import {
  orderRefKey,
  parseConnectionId,
  parseOrderRefKey,
  parseProviderOrderRef,
  sameOrderRef,
  type ProviderOrderRef,
} from "./marketplaces/identity.js";
import {
  SHIPMENT_TAG_COUNT,
  type ShipmentTagRegistry,
} from "./shipment-tags.js";

const MAXIMUM_SHIPMENT_RECORDS = 10_000;

export interface QualifiedReadyOrderSnapshot {
  readonly orders: readonly OrderSummary[];
  /** Connections whose complete ready queue contributed to this snapshot. */
  readonly successfulConnectionIds: readonly string[];
  readonly issues: readonly ProviderIssue[];
  readonly fetchedAt: string;
}

export interface QualifiedReadyOrderSource {
  snapshot(): QualifiedReadyOrderSnapshot | undefined;
  refresh(signal?: AbortSignal): Promise<QualifiedReadyOrderSnapshot>;
  remove(ref: ProviderOrderRef): void;
}

export type ShipmentScanResult =
  | {
      readonly state: "matched";
      readonly tagId: number;
      readonly order: OrderSummary;
    }
  | {
      readonly state: "shipped";
      readonly tagId: number;
      readonly order: OrderSummary;
      readonly outcome: "applied" | "already-applied";
    }
  | {
      readonly state: "already-processed";
      readonly tagId: number;
      readonly ref: ProviderOrderRef;
    }
  | {
      readonly state: "no-match";
      readonly tagId: number;
    }
  | {
      readonly state: "ambiguous";
      readonly tagId: number;
      readonly matchCount: number;
    }
  | {
      readonly state: "review-required";
      readonly tagId: number;
      readonly ref: ProviderOrderRef;
    };

export interface ShipmentScannerStatus {
  readonly enabled: boolean;
  readonly automaticallyMarkShipped: boolean;
  readonly soundEnabled: boolean;
  readonly readyOrderCount: number;
  readonly readyTagIds: readonly number[];
  readonly conflictingTagCount: number;
  readonly reviewRequiredCount: number;
  readonly issues: readonly ProviderIssue[];
  readonly snapshotFetchedAt?: string;
}

export interface ShipmentMutationRecord {
  readonly ref: ProviderOrderRef;
  readonly tagId: number;
  readonly status: "running" | "succeeded" | "review-required";
  readonly updatedAt: string;
  readonly outcome?: "applied" | "already-applied";
}

export interface ShipmentScanState {
  readonly version: 2;
  readonly records: Readonly<Record<string, ShipmentMutationRecord>>;
}

export interface ShipmentScanStore {
  load(): Promise<ShipmentScanState>;
  save(state: ShipmentScanState): Promise<void>;
}

export interface ShipmentMutationService {
  markShipped(
    input: { readonly ref: ProviderOrderRef },
    signal?: AbortSignal,
  ): Promise<MutationResult>;
}

export interface ShipmentScannerServiceOptions {
  readonly settings: () => Promise<ShipmentScannerConfig>;
  readonly readyOrders: QualifiedReadyOrderSource;
  readonly orders: ShipmentMutationService;
  readonly store: ShipmentScanStore;
  readonly tags: ShipmentTagRegistry;
  readonly now?: () => Date;
}

export class ShipmentScannerService {
  private readonly now: () => Date;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ShipmentScannerServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async status(): Promise<ShipmentScannerStatus> {
    const settings = await this.options.settings();
    const snapshot = this.options.readyOrders.snapshot();
    const scanState = recoverInterruptedMutations(
      await this.options.store.load(),
    );
    const assignments = await this.options.tags.reserveAll(
      (snapshot?.orders ?? []).map((order) => order.ref),
    );
    return {
      enabled: settings.enabled,
      automaticallyMarkShipped: settings.automaticallyMarkShipped,
      soundEnabled: settings.soundEnabled,
      readyOrderCount: snapshot?.orders.length ?? 0,
      readyTagIds: assignments
        .map((assignment) => assignment.tagId)
        .sort((left, right) => left - right),
      conflictingTagCount: 0,
      reviewRequiredCount: Object.values(scanState.records).filter(
        (record) => record.status === "review-required",
      ).length,
      issues: snapshot?.issues ?? [],
      ...(snapshot === undefined
        ? {}
        : { snapshotFetchedAt: snapshot.fetchedAt }),
    };
  }

  async scan(tagId: number, signal?: AbortSignal): Promise<ShipmentScanResult> {
    const settings = await this.requireEnabled();
    const resolution = await this.resolve(tagId, signal);
    if (resolution.state !== "matched") return resolution;
    if (!settings.automaticallyMarkShipped) return resolution;
    if (
      requiresTracking(resolution.order) ||
      resolution.order.actions["mark-shipped"].state !== "available"
    ) {
      return resolution;
    }
    return this.mutate(resolution.order, resolution.tagId, signal);
  }

  async markShipped(
    tagId: number,
    expectedRef: ProviderOrderRef,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult> {
    await this.requireEnabled();
    const ref = parseProviderOrderRef(expectedRef);
    const resolution = await this.resolve(tagId, signal);
    if (resolution.state !== "matched") return resolution;
    if (!sameOrderRef(resolution.order.ref, ref)) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The ready-order match changed. Scan the parcel again.",
      );
    }
    return this.mutate(resolution.order, resolution.tagId, signal);
  }

  private async requireEnabled(): Promise<ShipmentScannerConfig> {
    const settings = await this.options.settings();
    if (!settings.enabled) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Shipment scanning is disabled in Settings.",
      );
    }
    return settings;
  }

  private async resolve(
    tagId: number,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult> {
    const normalizedTagId = validTagId(tagId);
    const snapshot = await this.options.readyOrders.refresh(signal);
    const orders = snapshot.orders.map(parseOrderSummary);
    const assignments = await this.options.tags.reconcile(
      orders.map((order) => order.ref),
      new Set(snapshot.successfulConnectionIds),
      signal,
    );
    const tagByOrder = new Map(
      assignments.map((assignment) => [
        orderRefKey(assignment.ref),
        assignment.tagId,
      ]),
    );
    const matches = orders.filter(
      (order) => tagByOrder.get(orderRefKey(order.ref)) === normalizedTagId,
    );
    const scanState = recoverInterruptedMutations(
      await this.options.store.load(),
      this.now,
    );
    if (matches.length > 1) {
      return {
        state: "ambiguous",
        tagId: normalizedTagId,
        matchCount: matches.length,
      };
    }
    const order = matches[0];
    if (order !== undefined) {
      const record = scanState.records[orderRefKey(order.ref)];
      if (record?.status === "succeeded") {
        return {
          state: "already-processed",
          tagId: normalizedTagId,
          ref: record.ref,
        };
      }
      if (record?.status === "review-required") {
        return {
          state: "review-required",
          tagId: normalizedTagId,
          ref: record.ref,
        };
      }
      return { state: "matched", tagId: normalizedTagId, order };
    }

    const previous = latestRecordForTag(scanState, normalizedTagId);
    if (previous?.status === "succeeded") {
      return {
        state: "already-processed",
        tagId: normalizedTagId,
        ref: previous.ref,
      };
    }
    if (previous?.status === "review-required") {
      return {
        state: "review-required",
        tagId: normalizedTagId,
        ref: previous.ref,
      };
    }
    return { state: "no-match", tagId: normalizedTagId };
  }

  private mutate(
    order: OrderSummary,
    tagId: number,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult> {
    return new Promise<ShipmentScanResult>((resolvePromise, reject) => {
      const run = async () => {
        try {
          resolvePromise(await this.performMutation(order, tagId, signal));
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("The shipment mutation failed."),
          );
        }
      };
      this.mutationTail = this.mutationTail.then(run, run);
    });
  }

  private async performMutation(
    order: OrderSummary,
    tagId: number,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult> {
    const state = recoverInterruptedMutations(
      await this.options.store.load(),
      this.now,
    );
    const key = orderRefKey(order.ref);
    const existing = state.records[key];
    if (existing?.status === "succeeded") {
      return { state: "already-processed", tagId, ref: existing.ref };
    }
    if (existing?.status === "review-required") {
      return { state: "review-required", tagId, ref: existing.ref };
    }

    await this.options.store.save(
      withRecord(state, {
        ref: order.ref,
        tagId,
        status: "running",
        updatedAt: this.now().toISOString(),
      }),
    );
    try {
      const result = parseMutationResult(
        await this.options.orders.markShipped({ ref: order.ref }, signal),
      );
      if (!sameOrderRef(result.ref, order.ref)) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "The marketplace returned a shipment result for another order.",
        );
      }
      if (result.outcome === "review-required") {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          "The marketplace could not confirm the shipment result.",
        );
      }
      await this.options.store.save(
        withRecord(await this.options.store.load(), {
          ref: order.ref,
          tagId,
          status: "succeeded",
          updatedAt: this.now().toISOString(),
          outcome: result.outcome,
        }),
      );
      this.options.readyOrders.remove(order.ref);
      return { state: "shipped", tagId, order, outcome: result.outcome };
    } catch (cause) {
      signal?.throwIfAborted();
      await this.options.store.save(
        withRecord(await this.options.store.load(), {
          ref: order.ref,
          tagId,
          status: "review-required",
          updatedAt: this.now().toISOString(),
        }),
      );
      throw new ApplicationError(
        "REVIEW_REQUIRED",
        "The shipment result is uncertain. Review the order before trying again.",
        { cause },
      );
    }
  }
}

export class JsonShipmentScanStore implements ShipmentScanStore {
  private readonly absolutePath: string;
  private readonly legacyConnectionId: string | undefined;

  constructor(
    path: string,
    options: { readonly legacyConnectionId?: string } = {},
  ) {
    this.absolutePath = resolve(path);
    this.legacyConnectionId =
      options.legacyConnectionId === undefined
        ? undefined
        : parseConnectionId(options.legacyConnectionId);
  }

  async load(): Promise<ShipmentScanState> {
    try {
      return parseShipmentScanState(
        JSON.parse(await readFile(this.absolutePath, "utf8")) as unknown,
        this.legacyConnectionId,
      );
    } catch (error) {
      if (isMissingFile(error)) return emptyShipmentScanState();
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read shipment-scan state.",
        { cause: error },
      );
    }
  }

  async save(state: ShipmentScanState): Promise<void> {
    const validated = parseVersionTwoState(state);
    const temporaryPath = `${this.absolutePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.absolutePath), { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(temporaryPath, this.absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to persist shipment-scan state atomically.",
        { cause: error },
      );
    }
  }
}

export function emptyShipmentScanState(): ShipmentScanState {
  return { version: 2, records: {} };
}

export function recoverInterruptedMutations(
  state: ShipmentScanState,
  now: () => Date = () => new Date(),
): ShipmentScanState {
  const records = Object.fromEntries(
    Object.entries(state.records).map(([key, record]) => [
      key,
      record.status === "running"
        ? {
            ...record,
            status: "review-required" as const,
            updatedAt: now().toISOString(),
          }
        : record,
    ]),
  );
  return { version: 2, records };
}

function withRecord(
  state: ShipmentScanState,
  record: ShipmentMutationRecord,
): ShipmentScanState {
  const key = orderRefKey(record.ref);
  const records: Record<string, ShipmentMutationRecord> = {
    ...state.records,
    [key]: record,
  };
  const excess = Object.keys(records).length - MAXIMUM_SHIPMENT_RECORDS;
  if (excess > 0) {
    const removable = Object.entries(records)
      .filter(
        ([candidateKey, candidate]) =>
          candidate.status === "succeeded" && candidateKey !== key,
      )
      .sort((left, right) =>
        left[1].updatedAt.localeCompare(right[1].updatedAt),
      );
    for (const [candidateKey] of removable.slice(0, excess)) {
      Reflect.deleteProperty(records, candidateKey);
    }
  }
  if (Object.keys(records).length > MAXIMUM_SHIPMENT_RECORDS) {
    throw new ApplicationError(
      "PERSISTENCE_ERROR",
      "Shipment-scan review history requires operator cleanup.",
    );
  }
  return { version: 2, records };
}

function latestRecordForTag(
  state: ShipmentScanState,
  tagId: number,
): ShipmentMutationRecord | undefined {
  return Object.values(state.records)
    .filter((record) => record.tagId === tagId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function parseShipmentScanState(
  value: unknown,
  legacyConnectionId?: string,
): ShipmentScanState {
  if (!isRecord(value)) throw invalidState();
  if (value.version === 1) {
    if (legacyConnectionId === undefined) throw invalidState();
    return migrateVersionOneState(value, legacyConnectionId);
  }
  if (value.version === 2) return parseVersionTwoState(value);
  throw invalidState();
}

function migrateVersionOneState(
  value: Record<string, unknown>,
  legacyConnectionId: string,
): ShipmentScanState {
  if (!isRecord(value.records)) throw invalidState();
  const records: Record<string, ShipmentMutationRecord> = {};
  if (Object.keys(value.records).length > MAXIMUM_SHIPMENT_RECORDS) {
    throw invalidState();
  }
  for (const [orderNumber, raw] of Object.entries(value.records)) {
    if (!isLegacyRecord(raw, orderNumber)) throw invalidState();
    const ref = { connectionId: legacyConnectionId, remoteId: orderNumber };
    records[orderRefKey(ref)] = {
      ref,
      tagId: raw.tagId,
      status: raw.status,
      updatedAt: raw.updatedAt,
      ...(raw.outcome === undefined ? {} : { outcome: raw.outcome }),
    };
  }
  return { version: 2, records };
}

function parseVersionTwoState(value: unknown): ShipmentScanState {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.records)) {
    throw invalidState();
  }
  const entries = Object.entries(value.records);
  if (entries.length > MAXIMUM_SHIPMENT_RECORDS) throw invalidState();
  const records: Record<string, ShipmentMutationRecord> = {};
  for (const [key, raw] of entries) {
    if (!isRecord(raw)) throw invalidState();
    let ref: ProviderOrderRef;
    try {
      ref = parseProviderOrderRef(raw.ref);
      if (!sameOrderRef(parseOrderRefKey(key), ref)) throw invalidState();
    } catch {
      throw invalidState();
    }
    if (!isRecordFields(raw)) throw invalidState();
    records[key] = {
      ref,
      tagId: raw.tagId,
      status: raw.status,
      updatedAt: raw.updatedAt,
      ...(raw.outcome === undefined ? {} : { outcome: raw.outcome }),
    };
  }
  return { version: 2, records };
}

function isLegacyRecord(
  value: unknown,
  orderNumber: string,
): value is Record<string, unknown> & {
  tagId: number;
  status: ShipmentMutationRecord["status"];
  updatedAt: string;
  outcome?: ShipmentMutationRecord["outcome"];
} {
  return (
    isRecord(value) &&
    value.orderNumber === orderNumber &&
    isSafeLegacyOrderNumber(orderNumber) &&
    isRecordFields(value)
  );
}

function isRecordFields(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  tagId: number;
  status: ShipmentMutationRecord["status"];
  updatedAt: string;
  outcome?: ShipmentMutationRecord["outcome"];
} {
  return (
    Number.isSafeInteger(value.tagId) &&
    Number(value.tagId) >= 0 &&
    Number(value.tagId) < SHIPMENT_TAG_COUNT &&
    (value.status === "running" ||
      value.status === "succeeded" ||
      value.status === "review-required") &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.outcome === undefined ||
      value.outcome === "applied" ||
      value.outcome === "already-applied")
  );
}

function requiresTracking(order: OrderSummary): boolean {
  return (
    order.totals.total.currency !== "USD" ||
    order.totals.total.minorUnits >= 5_000
  );
}

function validTagId(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= SHIPMENT_TAG_COUNT) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "The shipment tag id is invalid.",
    );
  }
  return value;
}

function isSafeLegacyOrderNumber(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    !/\p{Cc}/u.test(value) &&
    value.trim() === value &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
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

function invalidState(): ApplicationError {
  return new ApplicationError(
    "PERSISTENCE_ERROR",
    "The shipment-scan state schema is unsupported or unsafe.",
  );
}
