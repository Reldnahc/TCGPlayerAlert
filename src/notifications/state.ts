import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "../errors.js";
import {
  orderRefKey,
  parseConnectionId,
  parseOrderRefKey,
  parseProviderOrderRef,
  parseRemoteId,
  type ProviderOrderRef,
} from "../marketplaces/identity.js";
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

export interface MessageObservation {
  readonly fingerprint: string;
  readonly observedAt: string;
}

export interface NotificationState {
  readonly version: 2;
  readonly readyOrderRefs?: readonly ProviderOrderRef[];
  readonly messages?: Readonly<
    Record<string, Readonly<Record<string, MessageObservation>>>
  >;
  readonly deliveries: readonly DeliveryRecord[];
}

const emptyState = (): NotificationState => ({ version: 2, deliveries: [] });

export class JsonNotificationStateStore {
  private readonly path: string;
  private readonly legacyConnectionId: string | undefined;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    options: { readonly legacyConnectionId?: string } = {},
  ) {
    this.path = resolve(path);
    this.legacyConnectionId =
      options.legacyConnectionId === undefined
        ? undefined
        : parseConnectionId(options.legacyConnectionId);
  }

  readReadyOrderRefs(): Promise<readonly ProviderOrderRef[] | undefined> {
    return this.exclusive(async () => (await this.load()).readyOrderRefs);
  }

  writeReadyOrderRefs(refs: readonly ProviderOrderRef[]): Promise<void> {
    return this.mutate((state) => ({
      ...state,
      readyOrderRefs: uniqueRefs(refs),
    }));
  }

  removeReadyOrderRef(ref: ProviderOrderRef): Promise<void> {
    const key = orderRefKey(ref);
    return this.exclusive(async () => {
      const state = await this.load();
      if (state.readyOrderRefs === undefined) return;
      await this.save({
        ...state,
        readyOrderRefs: state.readyOrderRefs.filter(
          (candidate) => orderRefKey(candidate) !== key,
        ),
      });
    });
  }

  readMessages(
    connectionId: string,
  ): Promise<Readonly<Record<string, MessageObservation>> | undefined> {
    const normalized = parseConnectionId(connectionId);
    return this.exclusive(
      async () => (await this.load()).messages?.[normalized],
    );
  }

  mergeMessages(
    connectionId: string,
    observations: Readonly<Record<string, MessageObservation>>,
  ): Promise<void> {
    const normalized = parseConnectionId(connectionId);
    return this.mutate((state) => {
      const messages = {
        ...(state.messages?.[normalized] ?? {}),
        ...parseMessageObservations(observations),
      };
      const bounded = Object.fromEntries(
        Object.entries(messages)
          .sort((left, right) =>
            right[1].observedAt.localeCompare(left[1].observedAt),
          )
          .slice(0, MESSAGE_HISTORY_LIMIT),
      );
      return {
        ...state,
        messages: { ...(state.messages ?? {}), [normalized]: bounded },
      };
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
      const record = parseDelivery({
        key,
        type,
        attemptedAt,
        status: "sending",
      });
      await this.save({
        ...state,
        deliveries: [...state.deliveries, record].slice(
          -DELIVERY_HISTORY_LIMIT,
        ),
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
          ? parseDelivery({
              ...delivery,
              status,
              ...(errorCode === undefined ? {} : { errorCode }),
            })
          : delivery,
      ),
    }));
  }

  private mutate(
    update: (state: NotificationState) => NotificationState,
  ): Promise<void> {
    return this.exclusive(async () => this.save(update(await this.load())));
  }

  private load(): Promise<NotificationState> {
    return readFile(this.path, "utf8")
      .then((value) => {
        if (Buffer.byteLength(value, "utf8") > MAX_STATE_BYTES) {
          throw invalidState();
        }
        return parseState(
          JSON.parse(value) as unknown,
          this.legacyConnectionId,
        );
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
    const validated = parseVersionTwoState(state);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
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

function parseState(
  value: unknown,
  legacyConnectionId?: string,
): NotificationState {
  if (!isRecord(value)) throw invalidState();
  if (value.version === 1) {
    if (legacyConnectionId === undefined) throw invalidState();
    return migrateVersionOneState(value, legacyConnectionId);
  }
  if (value.version === 2) return parseVersionTwoState(value);
  throw invalidState();
}

function parseVersionTwoState(value: unknown): NotificationState {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.deliveries)
  ) {
    throw invalidState();
  }
  const readyOrderRefs = parseOptionalRefs(value.readyOrderRefs);
  const messages = parseMessagesByConnection(value.messages);
  const deliveries = value.deliveries.map(parseDelivery);
  if (deliveries.length > DELIVERY_HISTORY_LIMIT) throw invalidState();
  return {
    version: 2,
    ...(readyOrderRefs === undefined ? {} : { readyOrderRefs }),
    ...(messages === undefined ? {} : { messages }),
    deliveries,
  };
}

function migrateVersionOneState(
  value: Record<string, unknown>,
  legacyConnectionId: string,
): NotificationState {
  if (!Array.isArray(value.deliveries)) throw invalidState();
  const readyOrderNumbers = value.readyOrderNumbers;
  if (
    readyOrderNumbers !== undefined &&
    (!Array.isArray(readyOrderNumbers) ||
      readyOrderNumbers.some((entry) => !safeText(entry, 256)))
  ) {
    throw invalidState();
  }
  const legacyMessages = parseMessageObservations(value.messages);
  const deliveries = value.deliveries.map((entry) => {
    const delivery = parseDelivery(entry);
    return delivery.type === "order-canceled"
      ? {
          ...delivery,
          key: migrateCanceledDeliveryKey(delivery.key, legacyConnectionId),
        }
      : delivery;
  });
  if (deliveries.length > DELIVERY_HISTORY_LIMIT) throw invalidState();
  return {
    version: 2,
    ...(readyOrderNumbers === undefined
      ? {}
      : {
          readyOrderRefs: uniqueRefs(
            (readyOrderNumbers as string[]).map((remoteId) => ({
              connectionId: legacyConnectionId,
              remoteId: parseRemoteId(remoteId),
            })),
          ),
        }),
    ...(legacyMessages === undefined
      ? {}
      : { messages: { [legacyConnectionId]: legacyMessages } }),
    deliveries,
  };
}

function parseOptionalRefs(
  value: unknown,
): readonly ProviderOrderRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100_000) throw invalidState();
  try {
    return uniqueRefs(value.map((entry) => parseProviderOrderRef(entry)));
  } catch {
    throw invalidState();
  }
}

function uniqueRefs(
  refs: readonly ProviderOrderRef[],
): readonly ProviderOrderRef[] {
  return [
    ...new Map(
      refs.map((ref) => {
        const key = orderRefKey(ref);
        return [key, parseOrderRefKey(key)] as const;
      }),
    ).entries(),
  ]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, ref]) => ref);
}

function parseMessagesByConnection(
  value: unknown,
): NotificationState["messages"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 1_000) {
    throw invalidState();
  }
  const result: Record<
    string,
    Readonly<Record<string, MessageObservation>>
  > = {};
  for (const [connectionId, entries] of Object.entries(value)) {
    try {
      parseConnectionId(connectionId);
    } catch {
      throw invalidState();
    }
    const parsed = parseMessageObservations(entries);
    if (parsed === undefined) throw invalidState();
    result[connectionId] = parsed;
  }
  return result;
}

function parseMessageObservations(
  value: unknown,
): Readonly<Record<string, MessageObservation>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidState();
  const entries = Object.entries(value);
  if (entries.length > MESSAGE_HISTORY_LIMIT) throw invalidState();
  const result: Record<string, MessageObservation> = {};
  for (const [key, entry] of entries) {
    if (!/^\d{1,16}$/u.test(key) || !isRecord(entry)) throw invalidState();
    if (!safeText(entry.fingerprint, 128) || !isTimestamp(entry.observedAt)) {
      throw invalidState();
    }
    result[key] = {
      fingerprint: entry.fingerprint,
      observedAt: entry.observedAt,
    };
  }
  return result;
}

function parseDelivery(value: unknown): DeliveryRecord {
  if (!isRecord(value)) throw invalidState();
  if (
    !safeText(value.key, 512) ||
    !isEventType(value.type) ||
    !isTimestamp(value.attemptedAt) ||
    (value.status !== "sending" &&
      value.status !== "delivered" &&
      value.status !== "failed") ||
    (value.errorCode !== undefined && !safeText(value.errorCode, 128))
  ) {
    throw invalidState();
  }
  return {
    key: value.key,
    type: value.type,
    attemptedAt: value.attemptedAt,
    status: value.status,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

function migrateCanceledDeliveryKey(
  key: string,
  legacyConnectionId: string,
): string {
  const match = /^order-canceled:(.+):([^:]+)$/u.exec(key);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw invalidState();
  }
  const ref = {
    connectionId: legacyConnectionId,
    remoteId: parseRemoteId(match[1]),
  };
  return `order-canceled:${orderRefKey(ref)}:${match[2]}`;
}

function isEventType(value: unknown): value is NotificationEventType {
  return (
    value === "authentication-required" ||
    value === "inbound-message" ||
    value === "order-canceled" ||
    value === "shipment-mark-attempt"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/\p{Cc}/u.test(value)
  );
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
