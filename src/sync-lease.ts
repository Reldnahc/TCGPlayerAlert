import {
  mkdir,
  readFile,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "./errors.js";

export interface SyncLease {
  runExclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export const immediateSyncLease: SyncLease = {
  runExclusive: <T>(work: () => Promise<T>) => work(),
};

export interface FileSyncLeaseOptions {
  readonly pollIntervalMs?: number;
  readonly staleAfterMs?: number;
}

export class FileSyncLease implements SyncLease {
  private readonly lockDirectory: string;
  private readonly ownerFile: string;
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;

  constructor(path: string, options: FileSyncLeaseOptions = {}) {
    this.lockDirectory = resolve(path);
    this.ownerFile = resolve(this.lockDirectory, "owner");
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.staleAfterMs = options.staleAfterMs ?? 120_000;
  }

  async runExclusive<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = randomUUID();
    await this.acquire(token, signal);
    const leaseStatus = { lost: false };
    const heartbeat = setInterval(
      () => {
        const now = new Date();
        void utimes(this.lockDirectory, now, now).catch(() => {
          leaseStatus.lost = true;
        });
      },
      Math.max(100, Math.floor(this.staleAfterMs / 3)),
    );
    heartbeat.unref();
    try {
      const result = await work();
      if (leaseStatus.lost) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          "The synchronization lease was lost while work was running.",
        );
      }
      return result;
    } finally {
      clearInterval(heartbeat);
      await this.release(token);
    }
  }

  private async acquire(token: string, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(this.lockDirectory), { recursive: true });
    for (;;) {
      if (signal?.aborted) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          "Synchronization was canceled while waiting for another run.",
        );
      }
      try {
        await mkdir(this.lockDirectory);
        try {
          await writeFile(this.ownerFile, token, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          return;
        } catch (error) {
          await rmdir(this.lockDirectory).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "Unable to acquire the synchronization lease.",
            { cause: error },
          );
        }
      }
      await this.removeIfStale();
      await wait(this.pollIntervalMs, signal);
    }
  }

  private async removeIfStale(): Promise<void> {
    try {
      const metadata = await stat(this.lockDirectory);
      if (Date.now() - metadata.mtimeMs <= this.staleAfterMs) return;
      let expectedToken: string | undefined;
      try {
        expectedToken = await readFile(this.ownerFile, "utf8");
      } catch (error) {
        if (!hasCode(error, "ENOENT")) return;
      }
      if (expectedToken === undefined) {
        await rmdir(this.lockDirectory).catch(() => undefined);
        return;
      }
      const currentToken = await readFile(this.ownerFile, "utf8").catch(
        () => undefined,
      );
      if (currentToken !== expectedToken) return;
      try {
        await unlink(this.ownerFile);
        await rmdir(this.lockDirectory).catch(() => undefined);
      } catch {
        // Another contender already removed or replaced the stale lease.
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "Unable to inspect the synchronization lease.",
          { cause: error },
        );
      }
    }
  }

  private async release(token: string): Promise<void> {
    const currentToken = await readFile(this.ownerFile, "utf8").catch(
      () => undefined,
    );
    if (currentToken !== token) return;
    await unlink(this.ownerFile).catch(() => undefined);
    await rmdir(this.lockDirectory).catch(() => undefined);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function wait(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
