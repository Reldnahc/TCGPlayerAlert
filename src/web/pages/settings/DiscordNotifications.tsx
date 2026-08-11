import { useEffect, useState } from "preact/hooks";
import type { Settings } from "../../contracts.js";
import { uiApi } from "../../api.js";
import {
  Button,
  Field,
  Notice,
  StatusBadge,
  Toggle,
} from "../../components/ui.js";
import { errorMessage } from "../../utils.js";

export function DiscordNotifications({
  settings,
  onChange,
}: {
  readonly settings: Settings;
  readonly onChange: (settings: Settings) => void;
}) {
  const [status, setStatus] = useState<
    Awaited<ReturnType<typeof uiApi.discordWebhook>> | undefined
  >();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState<
    "load" | "connect" | "test" | "disconnect" | null
  >("load");
  const [message, setMessage] = useState<{
    readonly tone: "success" | "danger";
    readonly text: string;
  }>();

  useEffect(() => {
    let active = true;
    void uiApi
      .discordWebhook()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (active) {
          setMessage({
            tone: "danger",
            text: errorMessage(cause, "Discord status could not be loaded."),
          });
        }
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function connect() {
    if (busy !== null || webhookUrl.trim() === "") return;
    setBusy("connect");
    setMessage(undefined);
    try {
      setStatus(await uiApi.connectDiscordWebhook(webhookUrl));
      setWebhookUrl("");
      setMessage({ tone: "success", text: "Discord webhook saved securely." });
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(cause, "The Discord webhook could not be saved."),
      });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (busy !== null) return;
    setBusy("test");
    setMessage(undefined);
    try {
      await uiApi.testDiscordWebhook();
      setMessage({ tone: "success", text: "Test notification delivered." });
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(cause, "The test notification failed."),
      });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (busy !== null) return;
    setBusy("disconnect");
    setMessage(undefined);
    try {
      setStatus(await uiApi.disconnectDiscordWebhook());
      setMessage({ tone: "success", text: "Protected webhook removed." });
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(cause, "The Discord webhook could not be removed."),
      });
    } finally {
      setBusy(null);
    }
  }

  const discord = settings.notifications.discord;
  const updateEvent = (key: keyof typeof discord.events, checked: boolean) =>
    onChange({
      ...settings,
      notifications: {
        discord: {
          ...discord,
          events: { ...discord.events, [key]: checked },
        },
      },
    });

  return (
    <section class="editor-section settings-editor settings-editor--single discord-settings">
      <div class="editor-section__head">
        <div>
          <div class="discord-settings__title">
            <h2>Discord</h2>
            {status === undefined ? null : (
              <StatusBadge
                status={status.configured ? "connected" : "disconnected"}
              />
            )}
          </div>
          <p>
            Send operational alerts without message bodies, buyer details, or
            addresses.
          </p>
        </div>
      </div>
      <div class="discord-connection">
        <Field
          label="Webhook URL"
          hint={
            status?.configured === true
              ? `Configured from ${status.source === "environment" ? "the environment" : "Windows protected storage"}`
              : status?.protectedStorage === false
                ? "Use the configured environment variable on this operating system"
                : "Create a webhook in the intended private Discord channel"
          }
        >
          <input
            type="password"
            value={webhookUrl}
            disabled={busy !== null || status?.protectedStorage === false}
            placeholder={
              status?.configured === true
                ? "Webhook configured"
                : "https://discord.com/api/webhooks/..."
            }
            autoComplete="off"
            onInput={(event) => setWebhookUrl(event.currentTarget.value)}
          />
        </Field>
        <div class="discord-connection__actions">
          <Button
            tone="primary"
            busy={busy === "connect"}
            disabled={
              busy !== null ||
              webhookUrl.trim() === "" ||
              status?.protectedStorage === false
            }
            onClick={() => void connect()}
          >
            Save webhook
          </Button>
          <Button
            busy={busy === "test"}
            disabled={busy !== null || status?.configured !== true}
            onClick={() => void test()}
          >
            Send test
          </Button>
          {status?.source !== "protected" ? null : (
            <Button
              tone="danger"
              busy={busy === "disconnect"}
              disabled={busy !== null}
              onClick={() => void disconnect()}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      {message === undefined ? null : (
        <Notice tone={message.tone}>{message.text}</Notice>
      )}
      <div class="notification-grid">
        <Toggle
          label="Enable Discord notifications"
          description="Master switch for automatic webhook delivery"
          checked={discord.enabled}
          onChange={(enabled) =>
            onChange({
              ...settings,
              notifications: { discord: { ...discord, enabled } },
            })
          }
        />
        <Toggle
          label="Seller session expires"
          checked={discord.events.authenticationRequired}
          onChange={(checked) => updateEvent("authenticationRequired", checked)}
        />
        <Toggle
          label="New customer message"
          description="Sends only an unread count and portal link, never the subject or message body"
          checked={discord.events.inboundMessage}
          onChange={(checked) => updateEvent("inboundMessage", checked)}
        />
        <Toggle
          label="Order canceled"
          description="Detected when a previously ready order changes to a TCGplayer cancellation status"
          checked={discord.events.orderCanceled}
          onChange={(checked) => updateEvent("orderCanceled", checked)}
        />
        <Toggle
          label="Mark-shipped attempt"
          description="Reports accepted, already-shipped, and failed attempts from every app workflow"
          checked={discord.events.shipmentMarkAttempt}
          onChange={(checked) => updateEvent("shipmentMarkAttempt", checked)}
        />
      </div>
    </section>
  );
}
