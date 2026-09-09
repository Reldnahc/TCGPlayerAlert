import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonShipmentTagRegistry,
  shipmentTagId,
  SHIPMENT_TAG_COUNT,
  SHIPMENT_TAG_REUSE_ORDER_GAP,
  type ProviderOrderRef,
} from "../src/index.js";

const ref = (
  remoteId: string,
  connectionId = "synthetic-main",
): ProviderOrderRef => ({ connectionId, remoteId });

function collidingRefs(): readonly [ProviderOrderRef, ProviderOrderRef] {
  const seen = new Map<number, ProviderOrderRef>();
  for (let index = 0; index <= SHIPMENT_TAG_COUNT; index += 1) {
    const candidate = ref(`REGISTRY-COLLISION-${String(index)}`);
    const tagId = shipmentTagId(candidate);
    const previous = seen.get(tagId);
    if (previous !== undefined) return [previous, candidate];
    seen.set(tagId, candidate);
  }
  throw new Error("Expected a deterministic tag collision.");
}

describe("qualified shipment tag registry", () => {
  it("persists distinct assignments for hash collisions and duplicate remote IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-test-"));
    const path = join(directory, "tags.json");
    const [first, second] = collidingRefs();
    const duplicateAcrossConnection = ref(first.remoteId, "other-main");
    const registry = new JsonShipmentTagRegistry(path, {
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    const assignments = await registry.reserveAll([
      second,
      first,
      duplicateAcrossConnection,
    ]);

    expect(assignments).toHaveLength(3);
    expect(new Set(assignments.map((value) => value.tagId)).size).toBe(3);
    await expect(
      new JsonShipmentTagRegistry(path).assign(second),
    ).resolves.toBe(
      assignments.find((value) => value.ref.remoteId === second.remoteId)
        ?.tagId,
    );
  });

  it("serializes concurrent reservations across registry instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-race-"));
    const path = join(directory, "tags.json");
    const [first, second] = collidingRefs();
    const left = new JsonShipmentTagRegistry(path);
    const right = new JsonShipmentTagRegistry(path);

    const [firstTag, secondTag] = await Promise.all([
      left.assign(first),
      right.assign(second),
    ]);

    expect(firstTag).not.toBe(secondTag);
    await expect(left.assigned([first, second])).resolves.toHaveLength(2);
  });

  it("retires only orders from successfully reconciled connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-partial-"));
    const registry = new JsonShipmentTagRegistry(join(directory, "tags.json"));
    const healthy = ref("HEALTHY", "healthy-main");
    const failed = ref("FAILED", "failed-main");
    await registry.reserveAll([healthy, failed]);

    await registry.reconcile([], new Set(["healthy-main"]));

    await expect(registry.assigned([healthy])).resolves.toEqual([
      expect.objectContaining({ retiredSequence: 2 }),
    ]);
    const [failedAssignment] = await registry.assigned([failed]);
    expect(failedAssignment?.retiredSequence).toBeUndefined();
  });

  it("quarantines a retired tag until enough newer assignments exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-ready-"));
    const registry = new JsonShipmentTagRegistry(join(directory, "tags.json"));
    const retired = ref("RETIRED");
    await registry.assign(retired);
    await registry.reconcile([], new Set([retired.connectionId]));
    await registry.reserveAll(
      Array.from({ length: SHIPMENT_TAG_REUSE_ORDER_GAP - 1 }, (_, index) =>
        ref(`NEW-${String(index)}`),
      ),
    );
    await expect(registry.assigned([retired])).resolves.toHaveLength(1);
    await registry.assign(ref("NEW-LAST"));
    await expect(registry.assigned([retired])).resolves.toEqual([]);
  });

  it("migrates v2 in memory without rewriting until the next mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-v2-"));
    const path = join(directory, "tags.json");
    const legacy = {
      version: 2,
      lastSequence: 1,
      assignments: {
        "LEGACY-ORDER": {
          orderNumber: "LEGACY-ORDER",
          tagId: 12,
          assignedAt: "2026-08-15T12:00:00.000Z",
          assignedSequence: 1,
        },
      },
    };
    await writeFile(path, JSON.stringify(legacy), "utf8");
    const registry = new JsonShipmentTagRegistry(path, {
      legacyConnectionId: "tcgplayer-main",
    });
    const migratedRef = ref("LEGACY-ORDER", "tcgplayer-main");

    await expect(registry.assigned([migratedRef])).resolves.toEqual([
      expect.objectContaining({ ref: migratedRef, tagId: 12 }),
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
    await registry.assign(ref("NEXT-ORDER"));
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 3,
      assignments: {
        "tcgplayer-main/LEGACY-ORDER": { ref: migratedRef, tagId: 12 },
      },
    });
  });

  it("fails closed for duplicate persisted tags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-bad-"));
    const path = join(directory, "tags.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        lastSequence: 2,
        assignments: {
          one: {
            orderNumber: "one",
            tagId: 7,
            assignedAt: "2026-08-15T12:00:00.000Z",
            assignedSequence: 1,
          },
          two: {
            orderNumber: "two",
            tagId: 7,
            assignedAt: "2026-08-15T12:01:00.000Z",
            assignedSequence: 2,
          },
        },
      }),
      "utf8",
    );
    await expect(
      new JsonShipmentTagRegistry(path, {
        legacyConnectionId: "tcgplayer-main",
      }).assign(ref("THREE")),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  it("fails before assigning more orders than the marker family supports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-full-"));
    const registry = new JsonShipmentTagRegistry(join(directory, "tags.json"));
    const refs = Array.from({ length: SHIPMENT_TAG_COUNT + 1 }, (_, index) =>
      ref(`TOO-MANY-${String(index)}`),
    );
    await expect(registry.reserveAll(refs)).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
    });
    await expect(registry.assigned(refs)).resolves.toEqual([]);
  });
});
