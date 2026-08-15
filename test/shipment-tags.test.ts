import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonShipmentTagRegistry,
  shipmentTagId,
  SHIPMENT_TAG_COUNT,
  SHIPMENT_TAG_REUSE_ORDER_GAP,
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

function orderWithPreferredTag(tagId: number, prefix: string): string {
  for (let index = 0; index < SHIPMENT_TAG_COUNT * 20; index += 1) {
    const orderNumber = `${prefix}-${String(index)}`;
    if (shipmentTagId(orderNumber) === tagId) return orderNumber;
  }
  throw new Error("Expected an order with the requested preferred tag.");
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

  it("quarantines a retired tag until 100 newer orders have been assigned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-ready-"));
    let now = new Date("2026-08-15T12:00:00.000Z");
    const registry = new JsonShipmentTagRegistry(join(directory, "tags.json"), {
      now: () => now,
    });
    const [first, second] = collidingOrderNumbers();
    await registry.reserveAll([first, second]);

    await registry.reconcile([second]);
    now = new Date("2036-08-15T12:00:00.000Z");
    await registry.reconcile([second]);

    await expect(registry.assigned([first])).resolves.toEqual([
      expect.objectContaining({ orderNumber: first, retiredSequence: 2 }),
    ]);

    const retiredTag = shipmentTagId(first);
    const wouldCollideWithRetiredTag = orderWithPreferredTag(
      retiredTag,
      "STALE-LABEL-COLLISION",
    );
    const firstNinetyNineNewOrders = [
      wouldCollideWithRetiredTag,
      ...Array.from(
        { length: SHIPMENT_TAG_REUSE_ORDER_GAP - 2 },
        (_, index) => `NEWER-ORDER-${String(index)}`,
      ),
    ];
    await registry.reserveAll(firstNinetyNineNewOrders);
    await expect(registry.assigned([first])).resolves.toHaveLength(1);
    await expect(registry.assign(wouldCollideWithRetiredTag)).resolves.not.toBe(
      retiredTag,
    );

    await registry.assign("NEWER-ORDER-99");
    await expect(registry.assigned([first])).resolves.toEqual([]);
  });

  it("reactivates a ready order with its original tag during quarantine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-return-"));
    const registry = new JsonShipmentTagRegistry(join(directory, "tags.json"));
    const originalTag = await registry.assign("RETURNING-ORDER");
    await registry.reconcile([]);

    await registry.reconcile(["RETURNING-ORDER"]);

    await expect(registry.assigned(["RETURNING-ORDER"])).resolves.toEqual([
      expect.objectContaining({
        orderNumber: "RETURNING-ORDER",
        tagId: originalTag,
      }),
    ]);
    expect(
      (await registry.assigned(["RETURNING-ORDER"]))[0],
    ).not.toHaveProperty("retiredSequence");
  });

  it("migrates the original assignment file before allocating another tag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-tags-v1-"));
    const path = join(directory, "tags.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        assignments: {
          "LEGACY-ORDER": {
            orderNumber: "LEGACY-ORDER",
            tagId: 12,
            assignedAt: "2026-08-15T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const registry = new JsonShipmentTagRegistry(path);

    await expect(registry.assign("LEGACY-ORDER")).resolves.toBe(12);
    await registry.assign("NEXT-ORDER");

    await expect(
      registry.assigned(["LEGACY-ORDER", "NEXT-ORDER"]),
    ).resolves.toEqual([
      expect.objectContaining({
        orderNumber: "LEGACY-ORDER",
        assignedSequence: 1,
      }),
      expect.objectContaining({
        orderNumber: "NEXT-ORDER",
        assignedSequence: 2,
      }),
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
