import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "../errors.js";
import type { NotificationEventType } from "./contracts.js";

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const DELIVERY_HISTORY_LIMIT = 500;
const MESSAGE_HISTORY_LIMIT = 1_000;

interface DeliveryRecord {
  readonly key: string;
  readonly type: NotificationEventType;
  readonly attemptedAt: string;
  readonly status: "sending" | "delivered" | "failed";
  readonly errorCode?: string;
}

interface MessageObservation {
  readonly fingerprint: string;
  readonly observedAt: string;
}

interface NotificationState {
  readonly version: 1;
  readonly readyOrderNumbers?: readonly string[];
  readonly messages?: Readonly<Record<string, MessageObservation>>;
  readonly deliveries: readonly DeliveryRecord[];
}

const emptyState = (): NotificationState => ({ version: 1, deliveries: [] });

export class JsonNotificationStateStore {
  private readonly path: string;
  private operations: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  readReadyOrderNumbers(): Promise<readonly string[] | undefined> {
    return this.exclusive(async () => (await this.load()).readyOrderNumbers);
  }

  writeReadyOrderNumbers(orderNumbers: readonly string[]): Promise<void> {
    return this.mutate((state) => ({
      ...state,
      readyOrderNumbers: [...new Set(orderNumbers)].sort(),
    }));
  }

  removeReadyOrderNumber(orderNumber: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      if (state.readyOrderNumbers === undefined) return;
      await this.save({
        ...state,
        readyOrderNumbers: state.readyOrderNumbers.filter(
          (candidate) => candidate !== orderNumber,
        ),
      });
    });
  }

  readMessages(): Promise<
    Readonly<Record<string, MessageObservation>> | undefined
  > {
    return this.exclusive(async () => (await this.load()).messages);
  }

  mergeMessages(
    observations: Readonly<Record<string, MessageObservation>>,
  ): Promise<void> {
    return this.mutate((state) => {
      const messages = { ...(state.messages ?? {}), ...observations };
      const bounded = Object.fromEntries(
        Object.entries(messages)
          .sort((left, right) =>
            right[1].observedAt.localeCompare(left[1].observedAt),
          )
          .slice(0, MESSAGE_HISTORY_LIMIT),
      );
      return { ...state, messages: bounded };
    });
  }

  claimDelivery(
    key: string,
    type: NotificationEventType,
    attemptedAt: string,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.load();
      if (state.deliveries.some((delivery) => delivery.key === key)) {
        return false;
      }
      await this.save({
        ...state,
        deliveries: [
          ...state.deliveries,
          { key, type, attemptedAt, status: "sending" as const },
        ].slice(-DELIVERY_HISTORY_LIMIT),
      });
      return true;
    });
  }

  completeDelivery(
    key: string,
    status: "delivered" | "failed",
    errorCode?: string,
  ): Promise<void> {
    return this.mutate((state) => ({
      ...state,
      deliveries: state.deliveries.map((delivery) =>
        delivery.key === key
          ? {
              ...delivery,
              status,
              ...(errorCode === undefined ? {} : { errorCode }),
            }
          : delivery,
      ),
    }));
  }

  private mutate(
    update: (state: NotificationState) => NotificationState,
  ): Promise<void> {
    return this.exclusive(async () => {
      await this.save(update(await this.load()));
    });
  }

  private load(): Promise<NotificationState> {
    return readFile(this.path, "utf8")
      .then((value) => {
        if (Buffer.byteLength(value, "utf8") > MAX_STATE_BYTES) {
          throw invalidState();
        }
        return parseState(JSON.parse(value) as unknown);
      })
      .catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return emptyState();
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "Notification state could not be read or validated.",
          { cause: error },
        );
      });
  }

  private async save(state: NotificationState): Promise<void> {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw invalidState();
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Notification state could not be saved.",
        { cause: error },
      );
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseState(value: unknown): NotificationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState();
  }
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || !Array.isArray(source.deliveries)) {
    throw invalidState();
  }
  const readyOrderNumbers = source.readyOrderNumbers;
  if (
    readyOrderNumbers !== undefined &&
    (!Array.isArray(readyOrderNumbers) ||
      readyOrderNumbers.some((entry) => !safeText(entry, 128)))
  ) {
    throw invalidState();
  }
  const messages = parseMessages(source.messages);
  const deliveries = source.deliveries.map(parseDelivery);
  return {
    version: 1,
    ...(readyOrderNumbers === undefined
      ? {}
      : { readyOrderNumbers: readyOrderNumbers as string[] }),
    ...(messages === undefined ? {} : { messages }),
    deliveries,
  };
}

function parseMessages(
  value: unknown,
): Readonly<Record<string, MessageObservation>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState();
  }
  const result: Record<string, MessageObservation> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !/^\d{1,16}$/u.test(key) ||
      typeof entry !== "object" ||
      entry === null
    ) {
      throw invalidState();
    }
    const source = entry as Record<string, unknown>;
    if (!safeText(source.fingerprint, 128) || !isTimestamp(source.observedAt)) {
      throw invalidState();
    }
    result[key] = {
      fingerprint: source.fingerprint,
      observedAt: source.observedAt,
    };
  }
  return result;
}

function parseDelivery(value: unknown): DeliveryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState();
  }
  const source = value as Record<string, unknown>;
  if (
    !safeText(source.key, 512) ||
    !isEventType(source.type) ||
    !isTimestamp(source.attemptedAt) ||
    (source.status !== "sending" &&
      source.status !== "delivered" &&
      source.status !== "failed") ||
    (source.errorCode !== undefined && !safeText(source.errorCode, 128))
  ) {
    throw invalidState();
  }
  return {
    key: source.key,
    type: source.type,
    attemptedAt: source.attemptedAt,
    status: source.status,
    ...(source.errorCode === undefined ? {} : { errorCode: source.errorCode }),
  };
}

function isEventType(value: unknown): value is NotificationEventType {
  return (
    value === "authentication-required" ||
    value === "inbound-message" ||
    value === "order-canceled" ||
    value === "shipment-mark-attempt"
  );
}

function safeText(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function invalidState(): ApplicationError {
  return new ApplicationError(
    "PERSISTENCE_ERROR",
    "Notification state is invalid.",
  );
}
