import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "../errors.js";
import {
  parseConnectionId,
  parseProviderOrderRef,
  type ProviderOrderRef,
} from "../marketplaces/identity.js";

const MAXIMUM_ALLOCATIONS = 100_000;
const MAXIMUM_STATE_BYTES = 5 * 1024 * 1024;

export interface PullProgressAllocation {
  readonly connectionId: string;
  readonly remoteId: string;
  readonly lineKey: string;
  readonly quantity: number;
  readonly pulledAt: string;
}

export interface QualifiedPullListProgressState {
  readonly version: 2;
  readonly allocations: readonly PullProgressAllocation[];
}

export interface QualifiedPullListProgressStore {
  load(): Promise<QualifiedPullListProgressState>;
  save(state: QualifiedPullListProgressState): Promise<void>;
}

export function emptyQualifiedPullListProgressState(): QualifiedPullListProgressState {
  return { version: 2, allocations: [] };
}

export function pullProgressAllocationRef(
  allocation: PullProgressAllocation,
): ProviderOrderRef {
  return parseProviderOrderRef({
    connectionId: allocation.connectionId,
    remoteId: allocation.remoteId,
  });
}

export class JsonQualifiedPullListProgressStore implements QualifiedPullListProgressStore {
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

  async load(): Promise<QualifiedPullListProgressState> {
    try {
      const text = await readFile(this.absolutePath, "utf8");
      if (Buffer.byteLength(text, "utf8") > MAXIMUM_STATE_BYTES) {
        throw persistenceError("The pull-list progress file is too large.");
      }
      const value = JSON.parse(text) as unknown;
      if (isQualifiedState(value)) return value;
      const migrated =
        this.legacyConnectionId === undefined
          ? undefined
          : migrateLegacyState(value, this.legacyConnectionId);
      if (migrated !== undefined) return migrated;
      throw persistenceError("The pull-list progress schema is unsupported.");
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return emptyQualifiedPullListProgressState();
      }
      if (error instanceof ApplicationError) throw error;
      throw persistenceError("Unable to read pull-list progress.", error);
    }
  }

  async save(state: QualifiedPullListProgressState): Promise<void> {
    if (!isQualifiedState(state)) {
      throw persistenceError("Refusing to save invalid pull-list progress.");
    }
    const text = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_STATE_BYTES) {
      throw persistenceError("The pull-list progress file is too large.");
    }
    const directory = dirname(this.absolutePath);
    const temporaryPath = `${this.absolutePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, text, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw persistenceError("Unable to persist pull-list progress.", error);
    }
  }
}

function isQualifiedState(
  value: unknown,
): value is QualifiedPullListProgressState {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.allocations)
  ) {
    return false;
  }
  if (value.allocations.length > MAXIMUM_ALLOCATIONS) return false;
  const identities = new Set<string>();
  for (const allocation of value.allocations) {
    if (!isProgressAllocation(allocation)) return false;
    const key = allocationKey(allocation);
    if (identities.has(key)) return false;
    identities.add(key);
  }
  return true;
}

function isProgressAllocation(value: unknown): value is PullProgressAllocation {
  if (!isRecord(value)) return false;
  try {
    parseProviderOrderRef({
      connectionId: value.connectionId,
      remoteId: value.remoteId,
    });
  } catch {
    return false;
  }
  return (
    safeLineKey(value.lineKey) &&
    Number.isSafeInteger(value.quantity) &&
    Number(value.quantity) > 0 &&
    typeof value.pulledAt === "string" &&
    isIsoTimestamp(value.pulledAt)
  );
}

function migrateLegacyState(
  value: unknown,
  connectionId: string,
): QualifiedPullListProgressState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.orders)) {
    return undefined;
  }
  const allocations: PullProgressAllocation[] = [];
  for (const [remoteId, lines] of Object.entries(value.orders)) {
    try {
      parseProviderOrderRef({ connectionId, remoteId });
    } catch {
      return undefined;
    }
    if (!isRecord(lines)) return undefined;
    for (const [lineKey, progress] of Object.entries(lines)) {
      if (!safeLineKey(lineKey) || !isLegacyProgress(progress)) {
        return undefined;
      }
      allocations.push({
        connectionId,
        remoteId,
        lineKey,
        quantity: progress.quantity,
        pulledAt: progress.pulledAt,
      });
      if (allocations.length > MAXIMUM_ALLOCATIONS) return undefined;
    }
  }
  return { version: 2, allocations };
}

function isLegacyProgress(
  value: unknown,
): value is { readonly quantity: number; readonly pulledAt: string } {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.quantity) &&
    Number(value.quantity) > 0 &&
    typeof value.pulledAt === "string" &&
    isIsoTimestamp(value.pulledAt)
  );
}

function allocationKey(allocation: PullProgressAllocation): string {
  return JSON.stringify([
    allocation.connectionId,
    allocation.remoteId,
    allocation.lineKey,
  ]);
}

function safeLineKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= 256 &&
    !/\p{Cc}/u.test(value)
  );
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === code
  );
}

function persistenceError(message: string, cause?: unknown): ApplicationError {
  return new ApplicationError("PERSISTENCE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}
