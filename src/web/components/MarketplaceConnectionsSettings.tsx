import { useEffect, useState } from "preact/hooks";
import type { MarketplaceConnectionStatus } from "../../marketplaces/health.js";
import type { MarketplaceCredentialStatus } from "../contracts.js";
import { uiApi } from "../api.js";
import { errorMessage } from "../utils.js";
import { SellerConnectionCard } from "./SellerConnectionCard.js";
import { Button, Field, Notice, Spinner, StatusBadge } from "./ui.js";
import { useMarketplaceConnections } from "../state/MarketplaceConnectionsContext.js";

export function MarketplaceConnectionsSettings() {
  const { snapshot, refresh } = useMarketplaceConnections();
  const connections = snapshot?.connections ?? [];
  const browserSessionConnection = connections.find(
    (connection) => connection.setup?.kind === "browser-session",
  );
  const managedConnections = connections.filter(
    (connection) => connection.setup?.kind === "managed-credentials",
  );
  const environmentConnections = connections.filter(
    (connection) => connection.setup?.kind === "environment",
  );

  return (
    <div class="marketplace-connections-settings">
      {browserSessionConnection === undefined ? null : <SellerConnectionCard />}
      {snapshot === null ? (
        <section class="seller-connection">
          <Spinner label="Checking marketplace connections" />
        </section>
      ) : null}
      {managedConnections.map((connection) => (
        <ManagedCredentialConnection
          key={connection.descriptor.connectionId}
          connection={connection}
          onChanged={refresh}
        />
      ))}
      {environmentConnections.map((connection) => (
        <LegacyEnvironmentConnection
          key={connection.descriptor.connectionId}
          connection={connection}
        />
      ))}
      {snapshot !== null && connections.length === 0 ? (
        <section class="seller-connection">
          <div class="seller-connection__summary">
            <div>
              <div class="seller-connection__title">
                <h2>No additional marketplace connections</h2>
              </div>
              <p>
                Add an enabled provider connection to config/local.json, save,
                and restart the application.
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function LegacyEnvironmentConnection({
  connection,
}: {
  readonly connection: MarketplaceConnectionStatus;
}) {
  const { descriptor, health, setup } = connection;
  return (
    <section class="seller-connection">
      <div class="seller-connection__summary">
        <div>
          <div class="seller-connection__title">
            <h2>{descriptor.connectionLabel}</h2>
            <StatusBadge status={health.state} />
          </div>
          <p>
            {connectionDescription(descriptor.connectionLabel, health.state)}
          </p>
          <small>Legacy test-only environment connection</small>
        </div>
      </div>
      {setup?.kind !== "environment" ? null : (
        <div class="provider-environment">
          <span>Environment fallback</span>
          {setup.secretEnvironmentNames.map((name) => (
            <code key={name}>{name}</code>
          ))}
        </div>
      )}
    </section>
  );
}

function ManagedCredentialConnection({
  connection,
  onChanged,
}: {
  readonly connection: MarketplaceConnectionStatus;
  readonly onChanged: () => Promise<void>;
}) {
  const { descriptor, health, setup } = connection;
  const [status, setStatus] = useState<MarketplaceCredentialStatus>();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<"load" | "save" | "remove" | null>("load");
  const [message, setMessage] = useState<{
    readonly tone: "success" | "danger";
    readonly text: string;
  }>();

  useEffect(() => {
    let active = true;
    void uiApi
      .marketplaceCredentials(descriptor.connectionId)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (active) {
          setMessage({
            tone: "danger",
            text: errorMessage(
              cause,
              "Marketplace credential status could not be loaded.",
            ),
          });
        }
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [descriptor.connectionId]);

  async function save() {
    if (busy !== null || status === undefined) return;
    setBusy("save");
    setMessage(undefined);
    try {
      const next = await uiApi.saveMarketplaceCredentials(
        descriptor.connectionId,
        values,
      );
      setStatus(next);
      setValues({});
      await onChanged();
      setMessage({
        tone: "success",
        text: "Marketplace credentials saved securely and applied.",
      });
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(
          cause,
          "Marketplace credentials could not be saved.",
        ),
      });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy !== null) return;
    setBusy("remove");
    setMessage(undefined);
    try {
      setStatus(
        await uiApi.removeMarketplaceCredentials(descriptor.connectionId),
      );
      setValues({});
      await onChanged();
      setMessage({
        tone: "success",
        text: "Saved credentials removed. Test environment fallbacks remain available.",
      });
    } catch (cause) {
      setMessage({
        tone: "danger",
        text: errorMessage(
          cause,
          "Saved marketplace credentials could not be removed.",
        ),
      });
    } finally {
      setBusy(null);
    }
  }

  const fields =
    setup?.kind === "managed-credentials" ? setup.credentialFields : [];
  const complete =
    fields.length > 0 &&
    fields.every((field) => (values[field.id]?.trim().length ?? 0) > 0);
  const savedInSettings = status?.fields.some(
    (field) => field.source === "settings",
  );
  return (
    <section class="seller-connection">
      <div class="seller-connection__summary">
        <div>
          <div class="seller-connection__title">
            <h2>{descriptor.connectionLabel}</h2>
            <StatusBadge status={health.state} />
          </div>
          <p>
            {connectionDescription(descriptor.connectionLabel, health.state)}
          </p>
          <small>Connection id: {descriptor.connectionId}</small>
        </div>
      </div>
      <div class="managed-credentials">
        {busy === "load" ? (
          <Spinner label="Loading secure settings" />
        ) : (
          <>
            <div class="managed-credentials__fields">
              {fields.map((field) => {
                const fieldStatus = status?.fields.find(
                  (candidate) => candidate.id === field.id,
                );
                return (
                  <Field
                    key={field.id}
                    label={field.label}
                    {...(fieldStatus?.source === "settings"
                      ? { hint: "Saved in Windows protected storage" }
                      : fieldStatus?.source === "environment"
                        ? { hint: "Using the test environment fallback" }
                        : {})}
                  >
                    <input
                      type={field.inputType}
                      value={values[field.id] ?? ""}
                      autoComplete="off"
                      disabled={
                        busy !== null || status?.protectedStorage === false
                      }
                      placeholder={
                        fieldStatus?.configured === true
                          ? "Configured — enter a replacement"
                          : "Required"
                      }
                      onInput={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.id]: event.currentTarget.value,
                        }))
                      }
                    />
                  </Field>
                );
              })}
            </div>
            <div class="managed-credentials__actions">
              <Button
                tone="primary"
                busy={busy === "save"}
                disabled={
                  busy !== null ||
                  !complete ||
                  status?.protectedStorage === false
                }
                onClick={() => void save()}
              >
                Save credentials
              </Button>
              {!savedInSettings ? null : (
                <Button
                  tone="danger"
                  busy={busy === "remove"}
                  disabled={busy !== null}
                  onClick={() => void remove()}
                >
                  Remove saved credentials
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      {message === undefined ? null : (
        <Notice tone={message.tone}>{message.text}</Notice>
      )}
    </section>
  );
}

function connectionDescription(label: string, state: string): string {
  if (state === "connected" || state === "degraded") {
    return label + " accepted the configured seller credentials.";
  }
  if (state === "authentication-required") {
    return label + " rejected the configured credentials. Replace them below.";
  }
  if (state === "not-configured") {
    return "Enter the seller credentials for " + label + " below.";
  }
  return label + " is configured but is not currently available.";
}
