import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProtectedFileCredentialStore,
  ProtectedFileTextSecretStore,
  WindowsDpapiProtector,
  type CredentialProtector,
} from "../src/index.js";

const xorProtector: CredentialProtector = {
  protect: (value) => Promise.resolve(xor(value)),
  unprotect: (value) => Promise.resolve(xor(value)),
};

describe("ProtectedFileCredentialStore", () => {
  it("round trips a credential without writing the plaintext session", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tcgplayer-alert-credentials-"),
    );
    const path = join(directory, "session.protected");
    const store = new ProtectedFileCredentialStore(path, xorProtector);
    await store.save({
      version: 1,
      state: "connected",
      authCookie: "synthetic-secret-cookie",
      sellerKey: "synthetic-seller",
      connectorToken: "a".repeat(64),
      updatedAt: "2026-08-08T12:00:00.000Z",
    });

    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).not.toContain("synthetic-secret-cookie");
    await expect(store.load()).resolves.toMatchObject({
      state: "connected",
      authCookie: "synthetic-secret-cookie",
    });
  });

  it("rejects malformed protected records instead of falling back silently", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tcgplayer-alert-credentials-"),
    );
    const path = join(directory, "session.protected");
    await writeFile(path, xor(Buffer.from('{"version":2}', "utf8")));
    const store = new ProtectedFileCredentialStore(path, xorProtector);

    await expect(store.load()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
  });
});

describe("ProtectedFileTextSecretStore", () => {
  it("round trips and removes a text secret without writing plaintext", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "tcgplayer-alert-text-secret-"),
    );
    const path = join(directory, "discord.protected");
    const store = new ProtectedFileTextSecretStore(path, xorProtector);

    await store.save("synthetic-webhook-secret");

    expect((await readFile(path)).toString("utf8")).not.toContain(
      "synthetic-webhook-secret",
    );
    await expect(store.load()).resolves.toBe("synthetic-webhook-secret");

    await store.save(undefined);
    await expect(store.load()).resolves.toBeUndefined();
  });
});

const windowsIt = process.platform === "win32" ? it : it.skip;

windowsIt("round trips synthetic bytes through Windows DPAPI", async () => {
  const protector = new WindowsDpapiProtector();
  const plaintext = Buffer.from("synthetic-dpapi-credential", "utf8");
  const protectedBytes = await protector.protect(plaintext);

  expect(Buffer.from(protectedBytes).equals(plaintext)).toBe(false);
  await expect(protector.unprotect(protectedBytes)).resolves.toEqual(plaintext);
});

function xor(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value, (byte) => byte ^ 0xa5);
}
