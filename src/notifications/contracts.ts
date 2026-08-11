export type NotificationEventType =
  | "authentication-required"
  | "inbound-message"
  | "order-canceled"
  | "shipment-mark-attempt";

interface NotificationEventBase {
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

export type NotificationEvent =
  | (NotificationEventBase & {
      readonly type: "authentication-required";
    })
  | (NotificationEventBase & {
      readonly type: "inbound-message";
      readonly threadId: number;
      readonly unreadMessageCount: number;
    })
  | (NotificationEventBase & {
      readonly type: "order-canceled";
      readonly orderNumber: string;
      readonly providerStatus: string;
    })
  | (NotificationEventBase & {
      readonly type: "shipment-mark-attempt";
      readonly orderNumber: string;
      readonly outcome: "applied" | "already-applied" | "failed";
      readonly errorCode?: string;
    });

export interface NotificationEventSettings {
  readonly authenticationRequired: boolean;
  readonly inboundMessage: boolean;
  readonly orderCanceled: boolean;
  readonly shipmentMarkAttempt: boolean;
}

export interface DiscordNotificationSettings {
  readonly enabled: boolean;
  readonly webhookUrlEnv: string;
  readonly events: NotificationEventSettings;
}

export interface NotificationPublisher {
  publish(event: NotificationEvent, signal?: AbortSignal): Promise<void>;
}

export interface NotificationSink {
  isConfigured(): boolean;
  send(event: NotificationEvent, signal?: AbortSignal): Promise<void>;
}
