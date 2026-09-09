import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonQualifiedPullListProgressStore,
  emptyQualifiedPullListProgressState,
} from "../src/fulfillment/pull-list-progress.js";

const PULLED_AT = "2026-08-25T12:00:00.000Z";

describe("qualified pull-list progress", () => {
  it("returns an empty v2 state when the file does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-progress-empty-"));

    await expect(
      new JsonQualifiedPullListProgressStore(
        join(directory, "missing.json"),
      ).load(),
    ).resolves.toEqual(emptyQualifiedPullListProgressState());
  });

  it("reads v1 as qualified v2 without rewriting until the next save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-progress-v1-"));
    const path = join(directory, "progress.json");
    const legacy = {
      version: 1,
      orders: {
        "ORDER-1": {
          "SKU-1": { quantity: 2, pulledAt: PULLED_AT },
        },
      },
    };
    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(path, original, "utf8");
    const store = new JsonQualifiedPullListProgressStore(path, {
      legacyConnectionId: "tcgplayer-main",
    });

    const migrated = await store.load();

    expect(migrated).toEqual({
      version: 2,
      allocations: [
        {
          connectionId: "tcgplayer-main",
          remoteId: "ORDER-1",
          lineKey: "SKU-1",
          quantity: 2,
          pulledAt: PULLED_AT,
        },
      ],
    });
    expect(await readFile(path, "utf8")).toBe(original);

    await store.save(migrated);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(migrated);
  });

  it("preserves equal remote and line IDs on separate connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-progress-accounts-"));
    const path = join(directory, "progress.json");
    const store = new JsonQualifiedPullListProgressStore(path);
    const state = {
      version: 2 as const,
      allocations: [
        {
          connectionId: "first-main",
          remoteId: "ORDER-1",
          lineKey: "SKU-1",
          quantity: 1,
          pulledAt: PULLED_AT,
        },
        {
          connectionId: "second-main",
          remoteId: "ORDER-1",
          lineKey: "SKU-1",
          quantity: 3,
          pulledAt: PULLED_AT,
        },
      ],
    };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it("fails closed on unsupported or duplicate allocation state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pull-progress-invalid-"));
    const unsupportedPath = join(directory, "unsupported.json");
    const duplicatePath = join(directory, "duplicate.json");
    await writeFile(unsupportedPath, '{"version":999}\n', "utf8");
    const allocation = {
      connectionId: "first-main",
      remoteId: "ORDER-1",
      lineKey: "SKU-1",
      quantity: 1,
      pulledAt: PULLED_AT,
    };
    await writeFile(
      duplicatePath,
      `${JSON.stringify({ version: 2, allocations: [allocation, allocation] })}\n`,
      "utf8",
    );

    await expect(
      new JsonQualifiedPullListProgressStore(unsupportedPath).load(),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(
      new JsonQualifiedPullListProgressStore(duplicatePath).load(),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });
});
