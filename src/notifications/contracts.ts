export type NotificationEventType =
  | "authentication-required"
  | "inbound-message"
  | "order-canceled"
  | "shipment-mark-attempt";

interface NotificationEventBase {
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

interface ConnectionNotificationEvent {
  readonly connectionId: string;
  readonly connectionLabel: string;
}

export type NotificationEvent =
  | (NotificationEventBase &
      ConnectionNotificationEvent & {
        readonly type: "authentication-required";
      })
  | (NotificationEventBase &
      ConnectionNotificationEvent & {
        readonly type: "inbound-message";
        readonly threadId: number;
        readonly unreadMessageCount: number;
      })
  | (NotificationEventBase &
      ConnectionNotificationEvent & {
        readonly type: "order-canceled";
        readonly ref: ProviderOrderRef;
        readonly displayOrderNumber: string;
        readonly providerStatus: string;
      })
  | (NotificationEventBase &
      ConnectionNotificationEvent & {
        readonly type: "shipment-mark-attempt";
        readonly ref: ProviderOrderRef;
        readonly displayOrderNumber: string;
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
import type { ProviderOrderRef } from "../marketplaces/identity.js";
