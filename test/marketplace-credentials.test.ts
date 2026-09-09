import { describe, expect, it } from "vitest";
import type { TextSecretStore } from "../src/credential-store.js";
import { MarketplaceCredentialManager } from "../src/marketplaces/credentials.js";
import type { MarketplaceConnectionSetup } from "../src/marketplaces/registry.js";

const setup: MarketplaceConnectionSetup = {
  kind: "managed-credentials",
  credentialFields: [
    {
      id: "email",
      label: "Seller email",
      inputType: "email",
      secretReference: "SELLER_EMAIL",
    },
    {
      id: "access-token",
      label: "Seller API code",
      inputType: "password",
      secretReference: "SELLER_ACCESS_TOKEN",
    },
  ],
  secretEnvironmentNames: ["SELLER_EMAIL", "SELLER_ACCESS_TOKEN"],
  restartRequired: false,
};

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

describe("marketplace credential manager", () => {
  it("uses environment values only as a fallback and isolates saved settings by connection", async () => {
    const store = new MemoryTextSecretStore();
    const manager = new MarketplaceCredentialManager(store, {
      SELLER_EMAIL: "test@example.com",
      SELLER_ACCESS_TOKEN: "test-token",
    });
    await manager.initialize();

    expect(manager.status("first-main", setup)).toMatchObject({
      configured: true,
      fields: [
        { id: "email", source: "environment" },
        { id: "access-token", source: "environment" },
      ],
    });

    await manager.connect("first-main", setup, {
      email: "saved@example.com",
      "access-token": "saved-token",
    });
    expect(manager.forConnection("first-main").get("SELLER_EMAIL")).toBe(
      "saved@example.com",
    );
    expect(manager.forConnection("second-main").get("SELLER_EMAIL")).toBe(
      "test@example.com",
    );
    expect(manager.status("first-main", setup).fields).toEqual([
      {
        id: "email",
        label: "Seller email",
        inputType: "email",
        configured: true,
        source: "settings",
      },
      {
        id: "access-token",
        label: "Seller API code",
        inputType: "password",
        configured: true,
        source: "settings",
      },
    ]);

    const reloaded = new MarketplaceCredentialManager(store, {});
    await reloaded.initialize();
    expect(
      reloaded.forConnection("first-main").get("SELLER_ACCESS_TOKEN"),
    ).toBe("saved-token");

    await manager.disconnect("first-main", setup);
    expect(manager.forConnection("first-main").get("SELLER_EMAIL")).toBe(
      "test@example.com",
    );
  });
});
