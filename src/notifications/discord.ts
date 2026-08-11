import { ApplicationError } from "../errors.js";
import type { TextSecretStore } from "../credential-store.js";
import type { NotificationEvent, NotificationSink } from "./contracts.js";

const DISCORD_HOSTS = new Set([
  "discord.com",
  "canary.discord.com",
  "ptb.discord.com",
  "discordapp.com",
]);
const WEBHOOK_PATH =
  /^\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,32}\/[A-Za-z0-9_-]{20,256}\/?$/u;
const REQUEST_TIMEOUT_MS = 10_000;

export interface DiscordWebhookStatus {
  readonly configured: boolean;
  readonly source?: "protected" | "environment";
  readonly protectedStorage: boolean;
}

export interface DiscordWebhookManagerOptions {
  readonly store: TextSecretStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly webhookUrlEnvironmentName: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class DiscordWebhookManager implements NotificationSink {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetch: typeof globalThis.fetch;
  private initialized = false;
  private protectedWebhookUrl: string | undefined;

  constructor(private readonly options: DiscordWebhookManagerOptions) {
    this.environment = options.environment ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const stored = await this.options.store.load();
    this.protectedWebhookUrl =
      stored === undefined ? undefined : validateDiscordWebhookUrl(stored);
    this.initialized = true;
  }

  status(): DiscordWebhookStatus {
    this.assertInitialized();
    if (this.protectedWebhookUrl !== undefined) {
      return {
        configured: true,
        source: "protected",
        protectedStorage: this.options.store.available,
      };
    }
    const environmentUrl = this.environmentWebhookUrl();
    return {
      configured: environmentUrl !== undefined,
      ...(environmentUrl === undefined ? {} : { source: "environment" }),
      protectedStorage: this.options.store.available,
    };
  }

  async connect(webhookUrl: string): Promise<DiscordWebhookStatus> {
    this.assertInitialized();
    if (!this.options.store.available) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Protected webhook storage is unavailable. Configure the webhook through the environment instead.",
      );
    }
    const normalized = validateDiscordWebhookUrl(webhookUrl);
    await this.options.store.save(normalized);
    this.protectedWebhookUrl = normalized;
    return this.status();
  }

  async disconnect(): Promise<DiscordWebhookStatus> {
    this.assertInitialized();
    if (this.options.store.available) await this.options.store.save(undefined);
    this.protectedWebhookUrl = undefined;
    return this.status();
  }

  isConfigured(): boolean {
    return this.status().configured;
  }

  async send(event: NotificationEvent, signal?: AbortSignal): Promise<void> {
    await this.post(discordPayload(event), signal);
  }

  async sendTest(signal?: AbortSignal): Promise<void> {
    await this.post(
      {
        username: "TCGplayerAlert",
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: "Discord notifications connected",
            description:
              "This synthetic test confirms that TCGplayerAlert can deliver webhook notifications.",
            color: 0x2e8b57,
            timestamp: new Date().toISOString(),
            footer: { text: "TCGplayerAlert" },
          },
        ],
      },
      signal,
    );
  }

  private async post(payload: unknown, signal?: AbortSignal): Promise<void> {
    this.assertInitialized();
    const webhookUrl = this.currentWebhookUrl();
    if (webhookUrl === undefined) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "A Discord webhook is not configured.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200 && response.status !== 204) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          `Discord rejected the webhook with status ${String(response.status)}.`,
          { retryable: response.status === 429 || response.status >= 500 },
        );
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PROVIDER_ERROR",
        controller.signal.aborted
          ? "The Discord webhook request timed out or was canceled."
          : "The Discord webhook request failed.",
        { cause: error, retryable: true },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private currentWebhookUrl(): string | undefined {
    return this.protectedWebhookUrl ?? this.environmentWebhookUrl();
  }

  private environmentWebhookUrl(): string | undefined {
    const value =
      this.environment[this.options.webhookUrlEnvironmentName]?.trim();
    return value ? validateDiscordWebhookUrl(value) : undefined;
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error("DiscordWebhookManager must be initialized first.");
  }
}

export function validateDiscordWebhookUrl(value: string): string {
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw invalidWebhook();
  }
  if (
    url.protocol !== "https:" ||
    !DISCORD_HOSTS.has(url.hostname.toLowerCase()) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !WEBHOOK_PATH.test(url.pathname)
  ) {
    throw invalidWebhook();
  }
  return url.toString();
}

function discordPayload(event: NotificationEvent): unknown {
  const presentation = eventPresentation(event);
  return {
    username: "TCGplayerAlert",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: presentation.title,
        description: presentation.description,
        color: presentation.color,
        timestamp: event.occurredAt,
        ...(presentation.url === undefined ? {} : { url: presentation.url }),
        footer: { text: "TCGplayerAlert" },
      },
    ],
  };
}

function eventPresentation(event: NotificationEvent): {
  readonly title: string;
  readonly description: string;
  readonly color: number;
  readonly url?: string;
} {
  if (event.type === "authentication-required") {
    return {
      title: "TCGplayer session expired",
      description: "Reconnect the seller session in the local application.",
      color: 0xc0392b,
    };
  }
  if (event.type === "inbound-message") {
    return {
      title: "New TCGplayer message",
      description: `${String(event.unreadMessageCount)} unread message${event.unreadMessageCount === 1 ? "" : "s"} in this conversation. Message subjects and bodies are not sent to Discord.`,
      color: 0x3498db,
      url: `https://sellerportal.tcgplayer.com/messages/${String(event.threadId)}`,
    };
  }
  if (event.type === "order-canceled") {
    return {
      title: "Order canceled",
      description: `Order ${event.orderNumber} is now ${event.providerStatus}.`,
      color: 0xe67e22,
      url: orderUrl(event.orderNumber),
    };
  }
  const outcome =
    event.outcome === "applied"
      ? "TCGplayer accepted the shipment update."
      : event.outcome === "already-applied"
        ? "TCGplayer reported the order was already shipped."
        : `The shipment update failed${event.errorCode === undefined ? "." : ` (${event.errorCode}).`}`;
  return {
    title: "Mark-shipped attempt",
    description: `Order ${event.orderNumber}\n${outcome}`,
    color: event.outcome === "failed" ? 0xc0392b : 0x2e8b57,
    url: orderUrl(event.orderNumber),
  };
}

function orderUrl(orderNumber: string): string {
  return `https://sellerportal.tcgplayer.com/orders/${encodeURIComponent(orderNumber)}`;
}

function invalidWebhook(): ApplicationError {
  return new ApplicationError(
    "CONFIGURATION_ERROR",
    "Enter a valid Discord webhook URL from discord.com.",
  );
}
