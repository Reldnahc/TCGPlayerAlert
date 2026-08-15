import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonShipmentTagRegistry,
  shipmentTagId,
  SHIPMENT_TAG_COUNT,
} from "../src/index.js";

function collidingOrderNumbers(): readonly [string, string] {
  const seen = new Map<number, string>();
  for (let index = 0; index <= SHIPMENT_TAG_COUNT; index += 1) {
    const orderNumber = `REGISTRY-COLLISION-${String(index)}`;
    const tagId = shipmentTagId(orderNumber);
    const previous = seen.get(tagId);
    if (previous !== undefined) return [previous, orderNumber];
    seen.set(tagId, orderNumber);
  }
  throw new Error("Expected a deterministic tag collision.");
}

describe("shipment tag registry", () => {
  it("persists a stable, distinct assignment for colliding orders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-test-"));
    const path = join(directory, "tags.json");
    const [first, second] = collidingOrderNumbers();
    const registry = new JsonShipmentTagRegistry(path, {
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    const assignments = await registry.reserveAll([second, first]);

    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((value) => value.tagId)).size).toBe(2);
    expect(
      assignments.find((value) => value.orderNumber === first)?.tagId,
    ).toBe(shipmentTagId(first));
    await expect(
      new JsonShipmentTagRegistry(path).assign(second),
    ).resolves.toBe(
      assignments.find((value) => value.orderNumber === second)?.tagId,
    );
  });

  it("serializes concurrent reservations made by separate registry instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-race-"));
    const path = join(directory, "tags.json");
    const [first, second] = collidingOrderNumbers();
    const left = new JsonShipmentTagRegistry(path);
    const right = new JsonShipmentTagRegistry(path);

    const [firstTag, secondTag] = await Promise.all([
      left.assign(first),
      right.assign(second),
    ]);

    expect(firstTag).not.toBe(secondTag);
    await expect(left.assigned([first, second])).resolves.toHaveLength(2);
  });

  it("reclaims assignments only after an authoritative ready set excludes them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-ready-"));
    const registry = new JsonShipmentTagRegistry(join(directory, "tags.json"));
    const [first, second] = collidingOrderNumbers();
    await registry.reserveAll([first, second]);

    await registry.reconcile([second]);

    await expect(registry.assigned([first, second])).resolves.toEqual([
      expect.objectContaining({ orderNumber: second }),
    ]);
  });

  it("rejects duplicate persisted tag ids instead of guessing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-bad-"));
    const path = join(directory, "tags.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        assignments: {
          "ORDER-ONE": {
            orderNumber: "ORDER-ONE",
            tagId: 7,
            assignedAt: "2026-08-15T12:00:00.000Z",
          },
          "ORDER-TWO": {
            orderNumber: "ORDER-TWO",
            tagId: 7,
            assignedAt: "2026-08-15T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    await expect(
      new JsonShipmentTagRegistry(path).assign("ORDER-THREE"),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });

  it("fails closed before assigning more orders than the marker family supports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-full-"));
    const registry = new JsonShipmentTagRegistry(join(directory, "tags.json"));
    const orders = Array.from(
      { length: SHIPMENT_TAG_COUNT + 1 },
      (_, index) => `TOO-MANY-${String(index)}`,
    );

    await expect(registry.reserveAll(orders)).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
    });
    await expect(registry.assigned(orders)).resolves.toEqual([]);
  });
});
