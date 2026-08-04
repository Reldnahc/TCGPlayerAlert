import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyState, JsonStateStore } from "../src/index.js";

describe("JSON state persistence", () => {
  it("atomically replaces and reloads versioned state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-state-"));
    try {
      const path = join(directory, "state.json");
      const store = new JsonStateStore(path);
      await store.save(emptyState());
      await store.save({
        ...emptyState(),
        baselineCompletedAt: "2026-01-02T03:04:05.000Z",
      });

      await expect(store.load()).resolves.toMatchObject({
        version: 1,
        baselineCompletedAt: "2026-01-02T03:04:05.000Z",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed state instead of silently resetting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-state-"));
    try {
      const path = join(directory, "state.json");
      await writeFile(path, "not json", "utf8");
      const store = new JsonStateStore(path);

      await expect(store.load()).rejects.toMatchObject({
        code: "PERSISTENCE_ERROR",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
