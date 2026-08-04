import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSyncLease } from "../src/index.js";

describe("cross-process synchronization lease", () => {
  it("serializes independent lease instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-lease-"));
    try {
      const lockPath = join(directory, "sync.lock");
      const firstLease = new FileSyncLease(lockPath, {
        pollIntervalMs: 5,
        staleAfterMs: 1_000,
      });
      const secondLease = new FileSyncLease(lockPath, {
        pollIntervalMs: 5,
        staleAfterMs: 1_000,
      });
      const events: string[] = [];
      let releaseFirst: () => void = () => undefined;
      const firstGate = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      let firstEntered: () => void = () => undefined;
      const entered = new Promise<void>((resolvePromise) => {
        firstEntered = resolvePromise;
      });
      const first = firstLease.runExclusive(async () => {
        events.push("first-start");
        firstEntered();
        await firstGate;
        events.push("first-end");
      });
      await entered;
      const second = secondLease.runExclusive(() => {
        events.push("second-start");
        return Promise.resolve();
      });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(events).toEqual(["first-start"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-start", "first-end", "second-start"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
