import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";

const MAXIMUM_ORDERS = 10_000;
const MAXIMUM_LINES_PER_ORDER = 10_000;
const MAXIMUM_IDENTIFIER_LENGTH = 128;
const MAXIMUM_STATE_BYTES = 5 * 1024 * 1024;

export interface PulledOrderLineProgress {
  readonly quantity: number;
  readonly pulledAt: string;
}

export interface PullListProgressState {
  readonly version: 1;
  readonly orders: Readonly<
    Record<string, Readonly<Record<string, PulledOrderLineProgress>>>
  >;
}

export interface PullListProgressStore {
  load(): Promise<PullListProgressState>;
  save(state: PullListProgressState): Promise<void>;
}

export function emptyPullListProgressState(): PullListProgressState {
  return { version: 1, orders: {} };
}

export function pullListProgressPath(stateFile: string): string {
  if (stateFile.trim().length === 0) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "The workflow state path is invalid.",
    );
  }
  return `${stateFile}.pull-list-progress.json`;
}

export class JsonPullListProgressStore implements PullListProgressStore {
  private readonly absolutePath: string;

  constructor(path: string) {
    this.absolutePath = resolve(path);
  }

  async load(): Promise<PullListProgressState> {
    try {
      const text = await readFile(this.absolutePath, "utf8");
      if (Buffer.byteLength(text, "utf8") > MAXIMUM_STATE_BYTES) {
        throw persistenceError("The pull-list progress file is too large.");
      }
      const value = JSON.parse(text) as unknown;
      if (!isPullListProgressState(value)) {
        throw persistenceError("The pull-list progress schema is unsupported.");
      }
      return value;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return emptyPullListProgressState();
      if (error instanceof ApplicationError) throw error;
      throw persistenceError("Unable to read pull-list progress.", error);
    }
  }

  async save(state: PullListProgressState): Promise<void> {
    if (!isPullListProgressState(state)) {
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

function isPullListProgressState(
  value: unknown,
): value is PullListProgressState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.orders)) {
    return false;
  }
  const orders = Object.entries(value.orders);
  return (
    orders.length <= MAXIMUM_ORDERS &&
    orders.every(([orderNumber, lines]) => {
      if (!safeIdentifier(orderNumber) || !isRecord(lines)) return false;
      const entries = Object.entries(lines);
      return (
        entries.length <= MAXIMUM_LINES_PER_ORDER &&
        entries.every(
          ([skuId, progress]) =>
            safeIdentifier(skuId) && isPulledOrderLineProgress(progress),
        )
      );
    })
  );
}

function isPulledOrderLineProgress(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.quantity) &&
    Number(value.quantity) > 0 &&
    typeof value.pulledAt === "string" &&
    value.pulledAt.length <= 64 &&
    isIsoTimestamp(value.pulledAt)
  );
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function safeIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > MAXIMUM_IDENTIFIER_LENGTH) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
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
