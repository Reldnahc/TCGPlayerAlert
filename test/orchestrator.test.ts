import { describe, expect, it } from "vitest";
import {
  ApplicationError,
  FulfillmentWorkflow,
  type RuleConfig,
} from "../src/index.js";
import {
  appConfig,
  FakeAction,
  FakeProvider,
  MemoryStateStore,
  silentLogger,
  syntheticOrderId,
} from "./fixtures.js";

const defaultRule: RuleConfig = {
  id: "default",
  enabled: true,
  when: { all: [] },
  actions: ["label", "packing-slip"],
};

function workflowFixture() {
  const provider = new FakeProvider();
  const stateStore = new MemoryStateStore();
  const label = new FakeAction("label", false);
  const packingSlip = new FakeAction("packing-slip", true);
  const workflow = new FulfillmentWorkflow({
    config: appConfig({ rules: [defaultRule] }),
    provider,
    stateStore,
    actions: { label, "packing-slip": packingSlip },
    logger: silentLogger,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    createId: () => "synthetic-correlation",
  });
  return { workflow, provider, stateStore, label, packingSlip };
}

describe("fulfillment workflow", () => {
  it("establishes the first-run baseline without confirming or acting", async () => {
    const fixture = workflowFixture();
    fixture.provider.discovered = [
      { id: syntheticOrderId, status: "ReadyToShip" },
    ];

    const result = await fixture.workflow.run("manual");

    expect(result).toMatchObject({
      baselineEstablished: true,
      discoveredCount: 1,
      processedCount: 0,
    });
    expect(fixture.provider.confirmations).toBe(0);
    expect(fixture.label.calls).toBe(0);
    expect(
      fixture.stateStore.state.orders[syntheticOrderId]?.workflowStatus,
    ).toBe("baseline");
  });

  it("prints each action once and lazily fetches one packing slip", async () => {
    const fixture = workflowFixture();
    await fixture.workflow.run("manual");
    fixture.provider.discovered = [
      { id: syntheticOrderId, status: "ReadyToShip" },
    ];

    await fixture.workflow.run("scheduled");
    await fixture.workflow.run("manual");

    expect(fixture.label.calls).toBe(1);
    expect(fixture.packingSlip.calls).toBe(1);
    expect(fixture.packingSlip.lastPackingSlip?.kind).toBe("packing-slip");
    expect(fixture.provider.packingSlips).toBe(1);
    expect(
      fixture.stateStore.state.orders[syntheticOrderId]?.workflowStatus,
    ).toBe("completed");
    expect(JSON.stringify(fixture.stateStore.state)).not.toContain(
      "Example Recipient",
    );
  });

  it("completes an order when every rule-selected action is disabled", async () => {
    const provider = new FakeProvider();
    const stateStore = new MemoryStateStore();
    const workflow = new FulfillmentWorkflow({
      config: appConfig({ rules: [defaultRule] }),
      provider,
      stateStore,
      actions: {},
      logger: silentLogger,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      createId: () => "synthetic-correlation",
    });
    await workflow.run("manual");
    provider.discovered = [{ id: syntheticOrderId, status: "ReadyToShip" }];

    await workflow.run("scheduled");

    expect(provider.confirmations).toBe(1);
    expect(provider.packingSlips).toBe(0);
    expect(stateStore.state.orders[syntheticOrderId]).toMatchObject({
      workflowStatus: "completed",
      actions: {},
    });
  });

  it("quarantines an ambiguous print and never submits it again", async () => {
    const fixture = workflowFixture();
    fixture.label.error = new ApplicationError(
      "PRINT_AMBIGUOUS",
      "Synthetic ambiguous print.",
    );
    await fixture.workflow.run("manual");
    fixture.provider.discovered = [
      { id: syntheticOrderId, status: "ReadyToShip" },
    ];

    await fixture.workflow.run("scheduled");
    await fixture.workflow.run("manual");

    expect(fixture.label.calls).toBe(1);
    expect(
      fixture.stateStore.state.orders[syntheticOrderId]?.workflowStatus,
    ).toBe("review-required");
    expect(
      fixture.stateStore.state.orders[syntheticOrderId]?.actions.label?.status,
    ).toBe("review-required");
  });

  it("processes the initial queue only with the explicit backlog option", async () => {
    const fixture = workflowFixture();
    fixture.provider.discovered = [
      { id: syntheticOrderId, status: "ReadyToShip" },
    ];

    const result = await fixture.workflow.run("manual", {
      processBacklog: true,
    });

    expect(result.baselineEstablished).toBe(false);
    expect(result.processedCount).toBe(1);
    expect(fixture.provider.confirmations).toBe(1);
  });

  it("coalesces overlapping synchronization requests", async () => {
    const fixture = workflowFixture();
    let release: () => void = () => undefined;
    fixture.provider.discoveryGate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });

    const first = fixture.workflow.run("scheduled");
    const second = fixture.workflow.run("manual");
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toMatchObject({ baselineEstablished: true });
  });
});
