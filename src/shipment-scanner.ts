import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ShipmentScannerConfig } from "./config.js";
import { ApplicationError } from "./errors.js";
import type { ManagedOrderSummary, ReadyOrderSource } from "./ready-orders.js";

export const SHIPMENT_TAG_COUNT = 587;
const MAXIMUM_SHIPMENT_RECORDS = 10_000;

export type ShipmentScanResult =
  | {
      readonly state: "matched";
      readonly tagId: number;
      readonly order: ManagedOrderSummary;
    }
  | {
      readonly state: "shipped";
      readonly tagId: number;
      readonly order: ManagedOrderSummary;
      readonly outcome: "applied" | "already-applied";
    }
  | {
      readonly state: "already-processed";
      readonly tagId: number;
      readonly orderNumber: string;
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
      readonly orderNumber: string;
    };

export interface ShipmentScannerStatus {
  readonly enabled: boolean;
  readonly automaticallyMarkShipped: boolean;
  readonly soundEnabled: boolean;
  readonly readyOrderCount: number;
  readonly readyTagIds: readonly number[];
  readonly conflictingTagCount: number;
  readonly reviewRequiredCount: number;
  readonly snapshotFetchedAt?: string;
}

export interface ShipmentMutationRecord {
  readonly orderNumber: string;
  readonly tagId: number;
  readonly status: "running" | "succeeded" | "review-required";
  readonly updatedAt: string;
  readonly outcome?: "applied" | "already-applied";
}

export interface ShipmentScanState {
  readonly version: 1;
  readonly records: Readonly<Record<string, ShipmentMutationRecord>>;
}

export interface ShipmentScanStore {
  load(): Promise<ShipmentScanState>;
  save(state: ShipmentScanState): Promise<void>;
}

export interface ShipmentMutationService {
  markShipped(
    orderNumber: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly orderNumber: string;
    readonly outcome: "applied" | "already-applied";
  }>;
}

export interface ShipmentScannerServiceOptions {
  readonly settings: () => Promise<ShipmentScannerConfig>;
  readonly readyOrders: ReadyOrderSource;
  readonly orders: ShipmentMutationService;
  readonly store: ShipmentScanStore;
  readonly now?: () => Date;
}

export function shipmentTagId(orderNumber: string): number {
  const normalized = safeOrderNumber(orderNumber);
  const digest = createHash("sha256")
    .update("tcgplayer-alert:shipment-tag:v1\0", "utf8")
    .update(normalized, "utf8")
    .digest();
  return digest.readUInt32BE(0) % SHIPMENT_TAG_COUNT;
}

export class ShipmentScannerService {
  private readonly settings: ShipmentScannerServiceOptions["settings"];
  private readonly readyOrders: ReadyOrderSource;
  private readonly orders: ShipmentMutationService;
  private readonly store: ShipmentScanStore;
  private readonly now: () => Date;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: ShipmentScannerServiceOptions) {
    this.settings = options.settings;
    this.readyOrders = options.readyOrders;
    this.orders = options.orders;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async status(): Promise<ShipmentScannerStatus> {
    const settings = await this.settings();
    const snapshot = this.readyOrders.snapshot();
    const scanState = recoverInterruptedMutations(await this.store.load());
    const tagCounts = new Map<number, number>();
    for (const order of snapshot?.orders ?? []) {
      const tagId = shipmentTagId(order.orderNumber);
      tagCounts.set(tagId, (tagCounts.get(tagId) ?? 0) + 1);
    }
    return {
      enabled: settings.enabled,
      automaticallyMarkShipped: settings.automaticallyMarkShipped,
      soundEnabled: settings.soundEnabled,
      readyOrderCount: snapshot?.orders.length ?? 0,
      readyTagIds: [...tagCounts.keys()].sort((left, right) => left - right),
      conflictingTagCount: [...tagCounts.values()].filter((count) => count > 1)
        .length,
      reviewRequiredCount: Object.values(scanState.records).filter(
        (record) => record.status === "review-required",
      ).length,
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
    return this.mutate(resolution.order, resolution.tagId, signal);
  }

  async markShipped(
    tagId: number,
    expectedOrderNumber: string,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult> {
    await this.requireEnabled();
    const normalizedOrderNumber = safeOrderNumber(expectedOrderNumber);
    const resolution = await this.resolve(tagId, signal);
    if (resolution.state !== "matched") return resolution;
    if (resolution.order.orderNumber !== normalizedOrderNumber) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The ready-order match changed. Scan the parcel again.",
      );
    }
    return this.mutate(resolution.order, resolution.tagId, signal);
  }

  private async requireEnabled(): Promise<ShipmentScannerConfig> {
    const settings = await this.settings();
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
    const snapshot = await this.readyOrders.refresh(signal);
    const matches = snapshot.orders.filter(
      (order) => shipmentTagId(order.orderNumber) === normalizedTagId,
    );
    const scanState = recoverInterruptedMutations(
      await this.store.load(),
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
      const record = scanState.records[order.orderNumber];
      if (record?.status === "succeeded") {
        return {
          state: "already-processed",
          tagId: normalizedTagId,
          orderNumber: order.orderNumber,
        };
      }
      if (record?.status === "review-required") {
        return {
          state: "review-required",
          tagId: normalizedTagId,
          orderNumber: order.orderNumber,
        };
      }
      return { state: "matched", tagId: normalizedTagId, order };
    }

    const previous = latestRecordForTag(scanState, normalizedTagId);
    if (previous?.status === "succeeded") {
      return {
        state: "already-processed",
        tagId: normalizedTagId,
        orderNumber: previous.orderNumber,
      };
    }
    if (previous?.status === "review-required") {
      return {
        state: "review-required",
        tagId: normalizedTagId,
        orderNumber: previous.orderNumber,
      };
    }
    return { state: "no-match", tagId: normalizedTagId };
  }

  private mutate(
    order: ManagedOrderSummary,
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
    order: ManagedOrderSummary,
    tagId: number,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult> {
    const state = recoverInterruptedMutations(
      await this.store.load(),
      this.now,
    );
    const existing = state.records[order.orderNumber];
    if (existing?.status === "succeeded") {
      return {
        state: "already-processed",
        tagId,
        orderNumber: order.orderNumber,
      };
    }
    if (existing?.status === "review-required") {
      return {
        state: "review-required",
        tagId,
        orderNumber: order.orderNumber,
      };
    }

    await this.store.save(
      withRecord(state, {
        orderNumber: order.orderNumber,
        tagId,
        status: "running",
        updatedAt: this.now().toISOString(),
      }),
    );
    try {
      const result = await this.orders.markShipped(order.orderNumber, signal);
      await this.store.save(
        withRecord(await this.store.load(), {
          orderNumber: order.orderNumber,
          tagId,
          status: "succeeded",
          updatedAt: this.now().toISOString(),
          outcome: result.outcome,
        }),
      );
      return { state: "shipped", tagId, order, outcome: result.outcome };
    } catch (cause) {
      await this.store.save(
        withRecord(await this.store.load(), {
          orderNumber: order.orderNumber,
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

  constructor(path: string) {
    this.absolutePath = resolve(path);
  }

  async load(): Promise<ShipmentScanState> {
    try {
      const value = JSON.parse(
        await readFile(this.absolutePath, "utf8"),
      ) as unknown;
      if (!isShipmentScanState(value)) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The shipment-scan state schema is unsupported.",
        );
      }
      return value;
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
        "Unable to persist shipment-scan state atomically.",
        { cause: error },
      );
    }
  }
}

export function emptyShipmentScanState(): ShipmentScanState {
  return { version: 1, records: {} };
}

export function recoverInterruptedMutations(
  state: ShipmentScanState,
  now: () => Date = () => new Date(),
): ShipmentScanState {
  const records = Object.fromEntries(
    Object.entries(state.records).map(([orderNumber, record]) => [
      orderNumber,
      record.status === "running"
        ? {
            ...record,
            status: "review-required" as const,
            updatedAt: now().toISOString(),
          }
        : record,
    ]),
  );
  return { version: 1, records };
}

function withRecord(
  state: ShipmentScanState,
  record: ShipmentMutationRecord,
): ShipmentScanState {
  const records: Record<string, ShipmentMutationRecord> = {
    ...state.records,
    [record.orderNumber]: record,
  };
  const excess = Object.keys(records).length - MAXIMUM_SHIPMENT_RECORDS;
  if (excess > 0) {
    const removable = Object.values(records)
      .filter(
        (candidate) =>
          candidate.status === "succeeded" &&
          candidate.orderNumber !== record.orderNumber,
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const candidate of removable.slice(0, excess)) {
      Reflect.deleteProperty(records, candidate.orderNumber);
    }
  }
  if (Object.keys(records).length > MAXIMUM_SHIPMENT_RECORDS) {
    throw new ApplicationError(
      "PERSISTENCE_ERROR",
      "Shipment-scan review history requires operator cleanup.",
    );
  }
  return {
    version: 1,
    records,
  };
}

function latestRecordForTag(
  state: ShipmentScanState,
  tagId: number,
): ShipmentMutationRecord | undefined {
  return Object.values(state.records)
    .filter((record) => record.tagId === tagId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
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

function safeOrderNumber(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    containsControlCharacter(normalized)
  ) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "The order number is invalid.",
    );
  }
  return normalized;
}

function isShipmentScanState(value: unknown): value is ShipmentScanState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) {
    return false;
  }
  const records = Object.entries(value.records);
  if (records.length > MAXIMUM_SHIPMENT_RECORDS) return false;
  return records.every(([orderNumber, raw]) => {
    if (!isRecord(raw)) return false;
    return (
      isSafeOrderNumberValue(orderNumber) &&
      raw.orderNumber === orderNumber &&
      typeof raw.tagId === "number" &&
      Number.isInteger(raw.tagId) &&
      raw.tagId >= 0 &&
      raw.tagId < SHIPMENT_TAG_COUNT &&
      (raw.status === "running" ||
        raw.status === "succeeded" ||
        raw.status === "review-required") &&
      typeof raw.updatedAt === "string" &&
      Number.isFinite(Date.parse(raw.updatedAt)) &&
      (raw.outcome === undefined ||
        raw.outcome === "applied" ||
        raw.outcome === "already-applied")
    );
  });
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
