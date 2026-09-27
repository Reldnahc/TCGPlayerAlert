import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  JsonLocalInventoryStore,
  LocalInventoryService,
} from "../src/local-inventory.js";
import { ReplenishmentService } from "../src/replenishment.js";
import { parseReplenishmentRule } from "../src/replenishment-contracts.js";

const id = "00000000-0000-4000-8000-000000000001";
const identities = [
  {
    namespace: "tcgplayer.sku",
    value: "456",
    precision: "exact-variant" as const,
  },
  {
    namespace: "tcgplayer.product",
    value: "123",
    precision: "product" as const,
  },
];
async function fixture(stock = 3) {
  const path = join(
    await mkdtemp(join(tmpdir(), "replenishment-")),
    "stock.json",
  );
  const clock = { now: new Date("2026-09-26T12:00:00.000Z") };
  const store = new JsonLocalInventoryStore(path);
  const local = new LocalInventoryService(store, {
    id: () => id,
    now: () => clock.now,
  });
  await local.add({
    displayName: "Synthetic Promo Pack",
    quantity: stock,
    catalogIdentities: identities,
    attributes: {},
  });
  const remote = { quantity: 1, reserved: 0, shipped: false };
  const submit = vi.fn((quantity: number) => {
    remote.quantity += quantity;
    return Promise.resolve();
  });
  const gateway = {
    connectionId: "tcgplayer-main",
    accountScope: () => "synthetic-account",
    isShipped: vi.fn(() => Promise.resolve(remote.shipped)),
    prepare: vi.fn(() =>
      Promise.resolve({
        quantity: remote.quantity,
        reservedQuantity: remote.reserved,
        submit,
      }),
    ),
  };
  const service = new ReplenishmentService(local, gateway, () => clock.now);
  const sale = (
    remoteId = "SYNTHETIC-ORDER-1",
    quantity = 1,
    connectionId = "tcgplayer-main",
  ) =>
    local.deductSale({
      ref: { connectionId, remoteId },
      lines: [{ quantity, catalogIdentities: identities }],
    });
  const enable = () =>
    service.configure(id, { enabled: true, targetQuantity: 1, price: 2 });
  const advance = () => {
    clock.now = new Date(clock.now.getTime() + 61000);
  };
  return {
    path,
    local,
    store,
    clock,
    remote,
    gateway,
    submit,
    service,
    sale,
    enable,
    advance,
  };
}

describe("shipped-sale replenishment", () => {
  it("waits for shipment, persists tickets across restart, and does not deduct or replenish twice", async () => {
    const f = await fixture();
    await f.enable();
    expect(await f.service.runOne()).toBe(false);
    await f.sale();
    await f.sale();
    f.remote.quantity = 0;
    await f.service.runOne();
    expect(f.submit).not.toHaveBeenCalled();
    expect((await f.local.snapshot()).items[0]?.onHand).toBe(2);
    expect((await f.service.snapshot()).rules[0]?.tickets).toHaveLength(1);
    f.remote.shipped = true;
    f.advance();
    const restarted = new ReplenishmentService(
      new LocalInventoryService(new JsonLocalInventoryStore(f.path)),
      f.gateway,
      () => f.clock.now,
    );
    await restarted.runOne();
    await restarted.runOne();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(1);
    expect((await restarted.snapshot()).rules[0]).toMatchObject({
      status: "watching",
      tickets: [],
      jobs: [{ status: "submitted", quantity: 1 }],
    });
    expect((await f.local.snapshot()).items[0]?.onHand).toBe(2);
  });
  it("replaces repeated shipped sales until local stock is exhausted", async () => {
    const f = await fixture();
    await f.enable();
    f.remote.shipped = true;
    for (let n = 1; n <= 3; n++) {
      await f.sale(`SYNTHETIC-${String(n)}`);
      f.remote.quantity = 0;
      f.advance();
      await f.service.runOne();
    }
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect((await f.local.snapshot()).items[0]?.onHand).toBe(0);
    expect((await f.service.snapshot()).rules[0]).toMatchObject({
      enabled: false,
      status: "out-of-stock",
    });
  });
  it("never replenishes old sales, paused rules, other connections, or explicit delists", async () => {
    const f = await fixture(10);
    await f.sale("OLD");
    await f.enable();
    await f.sale("OLD");
    await f.sale("OTHER", 1, "manapool-main");
    expect((await f.service.snapshot()).rules[0]?.tickets).toHaveLength(0);
    await f.sale("NEW");
    await f.service.pauseExactIdentity("tcgplayer.sku", "456");
    f.remote.shipped = true;
    f.remote.quantity = 0;
    expect(await f.service.runOne()).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).rules[0]).toMatchObject({
      status: "paused",
      tickets: [],
    });
  });
  it("caps replacement by shipped units, stock and reservations on other connections", async () => {
    const f = await fixture(5);
    await f.service.configure(id, {
      enabled: true,
      targetQuantity: 4,
      price: 2,
    });
    await f.sale();
    f.remote.quantity = 0;
    f.remote.shipped = true;
    await f.service.runOne();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(1);
    await f.sale("SECOND");
    f.remote.quantity = 0;
    f.remote.reserved = 3;
    f.advance();
    await f.service.runOne();
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect((await f.service.snapshot()).rules[0]?.jobs.at(-1)?.status).toBe(
      "skipped",
    );
  });
  it("pauses uncertain submissions and requires explicit reconciliation before watching future sales", async () => {
    const f = await fixture();
    await f.enable();
    await f.sale();
    f.remote.quantity = 0;
    f.remote.shipped = true;
    f.submit.mockRejectedValue(new Error("synthetic transport failure"));
    await f.service.runOne();
    f.advance();
    await f.service.runOne();
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect((await f.service.snapshot()).rules[0]?.status).toBe(
      "review-required",
    );
    await expect(f.enable()).rejects.toThrow("reconciliation");
    await f.service.configure(id, {
      enabled: true,
      price: 2,
      targetQuantity: 1,
      reconciled: true,
    });
    expect(await f.service.runOne()).toBe(false);
  });
  it("quarantines a running job after restart without resubmitting it", async () => {
    const f = await fixture();
    await f.enable();
    await f.local.withReplenishmentState(async (state, save) =>
      save({
        ...state,
        replenishments:
          state.replenishments?.map((rule) => ({
            ...rule,
            status: "running",
            jobs: [
              {
                id,
                at: f.clock.now.toISOString(),
                status: "running",
                quantity: 1,
                message: "Submitting",
              },
            ],
          })) ?? [],
      }),
    );
    await f.service.runOne();
    expect(f.submit).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).rules[0]).toMatchObject({
      enabled: false,
      status: "review-required",
      jobs: [{ status: "review-required" }],
    });
  });
  it("retries only verification reads and waits for every tracked order", async () => {
    const f = await fixture(5);
    await f.enable();
    await f.sale();
    await f.sale("SECOND");
    f.remote.quantity = 0;
    f.gateway.isShipped
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await f.service.runOne();
    expect(f.submit).not.toHaveBeenCalled();
    f.advance();
    f.gateway.isShipped.mockRejectedValueOnce(new Error("read failed"));
    await f.service.runOne();
    expect(f.submit).not.toHaveBeenCalled();
    f.advance();
    f.remote.shipped = true;
    await f.service.runOne();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("serializes separate service instances against the same durable local stock", async () => {
    const f = await fixture();
    await f.enable();
    await f.sale();
    f.remote.quantity = 0;
    f.remote.shipped = true;
    const second = new ReplenishmentService(
      new LocalInventoryService(new JsonLocalInventoryStore(f.path)),
      f.gateway,
      () => f.clock.now,
    );
    await Promise.all([f.service.runOne(), second.runOne()]);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("holds replacements when the connected seller changes", async () => {
    const f = await fixture();
    await f.enable();
    await f.sale();
    f.remote.shipped = true;
    f.remote.quantity = 0;
    f.gateway.accountScope = () => "different-synthetic-account";
    await f.service.runOne();
    expect(f.submit).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).rules[0]?.status).toBe(
      "review-required",
    );
  });

  it("rejects invalid controls and malformed durable rules", async () => {
    const f = await fixture();
    await expect(
      f.service.configure(id, {
        enabled: true,
        price: 1.001,
        targetQuantity: 1,
      }),
    ).rejects.toThrow();
    await expect(
      f.service.configure(id, { enabled: true, price: 2, targetQuantity: 0 }),
    ).rejects.toThrow();
    await f.enable();
    expect(() => parseReplenishmentRule({ enabled: true })).toThrow();
    const rule = (await f.service.snapshot()).rules[0];
    expect(() =>
      parseReplenishmentRule({
        ...rule,
        tickets: [
          {
            ref: { connectionId: "other", remoteId: "SYNTHETIC" },
            quantity: 1,
          },
        ],
      }),
    ).toThrow();
  });
});
