import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyPullListProgressState,
  JsonPullListProgressStore,
  pullListProgressPath,
} from "../src/pull-list-progress.js";

describe("pull-list progress persistence", () => {
  it("atomically stores only per-order SKU progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-list-progress-"));
    try {
      const path = join(directory, "progress.json");
      const store = new JsonPullListProgressStore(path);
      await store.save({
        version: 1,
        orders: {
          "synthetic-order": {
            "synthetic-sku": {
              quantity: 2,
              pulledAt: "2026-08-10T12:00:00.000Z",
            },
          },
        },
      });

      await expect(store.load()).resolves.toEqual({
        version: 1,
        orders: {
          "synthetic-order": {
            "synthetic-sku": {
              quantity: 2,
              pulledAt: "2026-08-10T12:00:00.000Z",
            },
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns an empty versioned state when no file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-list-progress-"));
    try {
      await expect(
        new JsonPullListProgressStore(join(directory, "missing.json")).load(),
      ).resolves.toEqual(emptyPullListProgressState());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed or unbounded progress instead of resetting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-list-progress-"));
    try {
      const path = join(directory, "progress.json");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          orders: {
            "synthetic-order": {
              "synthetic-sku": {
                quantity: 0,
                pulledAt: "not-a-date",
              },
            },
          },
        }),
        "utf8",
      );

      await expect(
        new JsonPullListProgressStore(path).load(),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized progress file before parsing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-list-progress-"));
    try {
      const path = join(directory, "progress.json");
      await writeFile(path, " ".repeat(5 * 1024 * 1024 + 1), "utf8");

      await expect(
        new JsonPullListProgressStore(path).load(),
      ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to write an oversized progress file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-list-progress-"));
    try {
      const path = join(directory, "progress.json");
      const store = new JsonPullListProgressStore(path);
      const orders = Object.fromEntries(
        Array.from({ length: 4 }, (_, orderIndex) => [
          `order-${String(orderIndex)}`,
          Object.fromEntries(
            Array.from({ length: 10_000 }, (_, lineIndex) => [
              `${String(lineIndex)}-${"x".repeat(120)}`,
              {
                quantity: 1,
                pulledAt: "2026-08-10T12:00:00.000Z",
              },
            ]),
          ),
        ]),
      );

      await expect(store.save({ version: 1, orders })).rejects.toThrow(
        "The pull-list progress file is too large.",
      );
      await expect(readFile(path, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("derives a separate progress path from the workflow state file", () => {
    expect(pullListProgressPath(".data/state.json")).toBe(
      ".data/state.json.pull-list-progress.json",
    );
  });
});
