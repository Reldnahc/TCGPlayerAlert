import { safeErrorCode } from "../errors.js";
import type { Logger } from "../logger.js";
import type {
  DiscordNotificationSettings,
  NotificationEvent,
  NotificationEventType,
  NotificationPublisher,
  NotificationSink,
} from "./contracts.js";
import type { JsonNotificationStateStore } from "./state.js";

export interface NotificationServiceOptions {
  readonly settings: () =>
    DiscordNotificationSettings | Promise<DiscordNotificationSettings>;
  readonly sink: NotificationSink;
  readonly state: JsonNotificationStateStore;
  readonly logger: Logger;
}

export class NotificationService implements NotificationPublisher {
  constructor(private readonly options: NotificationServiceOptions) {}

  async publish(event: NotificationEvent, signal?: AbortSignal): Promise<void> {
    if (event.type === "shipment-mark-attempt" && event.outcome !== "failed") {
      await this.options.state
        .removeReadyOrderNumber(event.orderNumber)
        .catch((error: unknown) => this.logFailure(event, error));
    }
    let settings: DiscordNotificationSettings;
    try {
      settings = await this.options.settings();
    } catch (error) {
      this.logFailure(event, error);
      return;
    }
    if (!settings.enabled || !eventEnabled(settings, event.type)) {
      return;
    }
    try {
      if (!this.options.sink.isConfigured()) return;
    } catch (error) {
      this.logFailure(event, error);
      return;
    }
    let claimed: boolean;
    try {
      claimed = await this.options.state.claimDelivery(
        event.idempotencyKey,
        event.type,
        event.occurredAt,
      );
    } catch (error) {
      this.logFailure(event, error);
      return;
    }
    if (!claimed) return;
    try {
      await this.options.sink.send(event, signal);
      await this.options.state.completeDelivery(
        event.idempotencyKey,
        "delivered",
      );
      this.options.logger.info("notification.delivered", {
        type: event.type,
      });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await this.options.state
        .completeDelivery(event.idempotencyKey, "failed", errorCode)
        .catch(() => undefined);
      this.logFailure(event, error);
    }
  }

  private logFailure(event: NotificationEvent, error: unknown): void {
    this.options.logger.error("notification.failed", {
      type: event.type,
      errorCode: safeErrorCode(error),
    });
  }
}

function eventEnabled(
  settings: DiscordNotificationSettings,
  type: NotificationEventType,
): boolean {
  if (type === "authentication-required") {
    return settings.events.authenticationRequired;
  }
  if (type === "inbound-message") return settings.events.inboundMessage;
  if (type === "order-canceled") return settings.events.orderCanceled;
  return settings.events.shipmentMarkAttempt;
}
