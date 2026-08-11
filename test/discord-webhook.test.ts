import { describe, expect, it, vi } from "vitest";
import type { TextSecretStore } from "../src/credential-store.js";
import {
  DiscordWebhookManager,
  validateDiscordWebhookUrl,
} from "../src/notifications/index.js";

const WEBHOOK_URL =
  "https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz012345";

class MemoryTextSecretStore implements TextSecretStore {
  readonly available = true;
  value: string | undefined;

  load(): Promise<string | undefined> {
    return Promise.resolve(this.value);
  }

  save(value: string | undefined): Promise<void> {
    this.value = value;
    return Promise.resolve();
  }
}

describe("DiscordWebhookManager", () => {
  it("validates Discord-owned HTTPS webhook URLs", () => {
    expect(validateDiscordWebhookUrl(WEBHOOK_URL)).toBe(WEBHOOK_URL);
    expect(() =>
      validateDiscordWebhookUrl(
        "https://example.test/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz012345",
      ),
    ).toThrow("valid Discord webhook URL");
    expect(() =>
      validateDiscordWebhookUrl(
        "https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz012345?wait=true",
      ),
    ).toThrow("valid Discord webhook URL");
  });

  it("stores the URL as a secret and never exposes it through status", async () => {
    const store = new MemoryTextSecretStore();
    const manager = new DiscordWebhookManager({
      store,
      environment: {},
      webhookUrlEnvironmentName: "SYNTHETIC_DISCORD_WEBHOOK",
    });
    await manager.initialize();

    await expect(manager.connect(WEBHOOK_URL)).resolves.toEqual({
      configured: true,
      source: "protected",
      protectedStorage: true,
    });
    expect(store.value).toBe(WEBHOOK_URL);
    expect(JSON.stringify(manager.status())).not.toContain(WEBHOOK_URL);

    await expect(manager.disconnect()).resolves.toEqual({
      configured: false,
      protectedStorage: true,
    });
    expect(store.value).toBeUndefined();
  });

  it("delivers a bounded payload without customer message content or mentions", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const manager = new DiscordWebhookManager({
      store: new MemoryTextSecretStore(),
      environment: { SYNTHETIC_DISCORD_WEBHOOK: WEBHOOK_URL },
      webhookUrlEnvironmentName: "SYNTHETIC_DISCORD_WEBHOOK",
      fetch: fetchMock,
    });
    await manager.initialize();

    await manager.send({
      type: "inbound-message",
      idempotencyKey: "inbound-message:1:2:1",
      occurredAt: "2026-08-10T12:00:00.000Z",
      threadId: 1,
      unreadMessageCount: 1,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    if (typeof request?.body !== "string") {
      throw new Error("Expected a serialized Discord payload.");
    }
    const body = request.body;
    expect(body).toContain("New TCGplayer message");
    expect(body).toContain('"allowed_mentions":{"parse":[]}');
    expect(body).toContain("Message subjects and bodies are not sent");
    expect(body).not.toContain(WEBHOOK_URL);
  });
});
