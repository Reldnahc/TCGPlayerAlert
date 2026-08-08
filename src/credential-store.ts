import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";

const MAX_PROTECTED_BYTES = 64 * 1024;
const POWERSHELL_TIMEOUT_MILLISECONDS = 15_000;

export type StoredSellerSession =
  | {
      readonly version: 1;
      readonly state: "connected";
      readonly authCookie: string;
      readonly sellerKey: string;
      readonly connectorToken: string;
      readonly updatedAt: string;
      readonly expiresAt?: string;
    }
  | {
      readonly version: 1;
      readonly state: "expired";
      readonly sellerKey: string;
      readonly connectorToken: string;
      readonly updatedAt: string;
    }
  | {
      readonly version: 1;
      readonly state: "disconnected";
      readonly updatedAt: string;
    };

export interface CredentialProtector {
  protect(value: Uint8Array): Promise<Uint8Array>;
  unprotect(value: Uint8Array): Promise<Uint8Array>;
}

export interface SellerCredentialStore {
  readonly available: boolean;
  load(): Promise<StoredSellerSession | undefined>;
  save(value: StoredSellerSession): Promise<void>;
}

export class ProtectedFileCredentialStore implements SellerCredentialStore {
  readonly available = true;
  private readonly path: string;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    private readonly protector: CredentialProtector,
  ) {
    this.path = resolve(path);
  }

  load(): Promise<StoredSellerSession | undefined> {
    return this.exclusive(async () => {
      let protectedBytes: Uint8Array;
      try {
        protectedBytes = await readFile(this.path);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw persistenceError(
          "Unable to read protected seller credentials.",
          error,
        );
      }
      if (
        protectedBytes.length === 0 ||
        protectedBytes.length > MAX_PROTECTED_BYTES
      ) {
        throw persistenceError(
          "Protected seller credentials have an invalid size.",
        );
      }
      try {
        const plaintext = await this.protector.unprotect(protectedBytes);
        if (plaintext.length === 0 || plaintext.length > MAX_PROTECTED_BYTES) {
          throw new Error("Invalid plaintext size");
        }
        return parseStoredSellerSession(
          JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown,
        );
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw persistenceError(
          "Protected seller credentials could not be decrypted or validated.",
          error,
        );
      }
    });
  }

  save(value: StoredSellerSession): Promise<void> {
    return this.exclusive(async () => {
      const plaintext = Buffer.from(JSON.stringify(value), "utf8");
      let protectedBytes: Uint8Array;
      try {
        protectedBytes = await this.protector.protect(plaintext);
      } catch (error) {
        throw persistenceError("Unable to protect seller credentials.", error);
      }
      if (
        protectedBytes.length === 0 ||
        protectedBytes.length > MAX_PROTECTED_BYTES
      ) {
        throw persistenceError(
          "Protected seller credentials have an invalid size.",
        );
      }
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, protectedBytes, {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporaryPath, this.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw persistenceError(
          "Unable to save protected seller credentials.",
          error,
        );
      }
    });
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

export class WindowsDpapiProtector implements CredentialProtector {
  async protect(value: Uint8Array): Promise<Uint8Array> {
    return runDpapi("Protect", value);
  }

  async unprotect(value: Uint8Array): Promise<Uint8Array> {
    return runDpapi("Unprotect", value);
  }
}

export function createPlatformCredentialStore(
  path: string,
): SellerCredentialStore {
  if (process.platform !== "win32") return new UnavailableCredentialStore();
  return new ProtectedFileCredentialStore(path, new WindowsDpapiProtector());
}

class UnavailableCredentialStore implements SellerCredentialStore {
  readonly available = false;

  load(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  save(): Promise<void> {
    return Promise.reject(
      new ApplicationError(
        "CONFIGURATION_ERROR",
        "Protected seller credential storage is not available on this operating system.",
      ),
    );
  }
}

async function runDpapi(
  operation: "Protect" | "Unprotect",
  value: Uint8Array,
): Promise<Uint8Array> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$inputText = [Console]::In.ReadToEnd()",
    "$bytes = [Convert]::FromBase64String($inputText)",
    `$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join("\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const output = await runPowerShell(
    encodedScript,
    Buffer.from(value).toString("base64"),
  );
  try {
    return Buffer.from(output, "base64");
  } catch (error) {
    throw persistenceError(
      "Windows returned invalid protected credential data.",
      error,
    );
  }
}

function runPowerShell(encodedScript: string, input: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedScript,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        rejectPromise(new Error("Windows credential protection timed out.")),
      );
    }, POWERSHELL_TIMEOUT_MILLISECONDS);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_PROTECTED_BYTES * 2) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 4096) stderr.push(chunk);
    });
    child.once("error", (error) => settle(() => rejectPromise(error)));
    child.once("close", (code) => {
      settle(() => {
        if (code !== 0 || outputBytes > MAX_PROTECTED_BYTES * 2) {
          rejectPromise(new Error("Windows credential protection failed."));
          return;
        }
        const result = Buffer.concat(stdout).toString("utf8").trim();
        if (result === "") {
          rejectPromise(
            new Error("Windows credential protection returned no data."),
          );
          return;
        }
        resolvePromise(result);
      });
    });
    child.stdin.end(input);
  });
}

function parseStoredSellerSession(value: unknown): StoredSellerSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw persistenceError("Protected seller credentials are invalid.");
  }
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || !isTimestamp(source.updatedAt)) {
    throw persistenceError("Protected seller credentials are invalid.");
  }
  if (source.state === "disconnected") {
    return { version: 1, state: "disconnected", updatedAt: source.updatedAt };
  }
  const sellerKey = safeText(source.sellerKey, 256);
  const connectorToken = safeHex(source.connectorToken, 64);
  if (
    source.state === "expired" &&
    sellerKey !== undefined &&
    connectorToken !== undefined
  ) {
    return {
      version: 1,
      state: "expired",
      sellerKey,
      connectorToken,
      updatedAt: source.updatedAt,
    };
  }
  const authCookie = safeText(source.authCookie, 16_384);
  const expiresAt = source.expiresAt;
  if (
    source.state === "connected" &&
    sellerKey !== undefined &&
    connectorToken !== undefined &&
    authCookie !== undefined &&
    (expiresAt === undefined || isTimestamp(expiresAt))
  ) {
    return {
      version: 1,
      state: "connected",
      authCookie,
      sellerKey,
      connectorToken,
      updatedAt: source.updatedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
  throw persistenceError("Protected seller credentials are invalid.");
}

function safeText(value: unknown, maximumLength: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return undefined;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return value;
}

function safeHex(value: unknown, length: number): string | undefined {
  return typeof value === "string" &&
    new RegExp(`^[a-f0-9]{${String(length)}}$`, "u").test(value)
    ? value
    : undefined;
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

function persistenceError(message: string, cause?: unknown): ApplicationError {
  return new ApplicationError("PERSISTENCE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}
