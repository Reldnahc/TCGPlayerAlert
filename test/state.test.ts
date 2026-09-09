import { describe, expect, it } from "vitest";
import {
  emptyState,
  JsonStateStore,
  recoverInterruptedActions,
  type ApplicationState,
} from "../src/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("workflow state", () => {
  it("starts with the versioned empty schema", () => {
    expect(emptyState()).toEqual({ version: 2, baselines: {}, orders: {} });
  });

  it("quarantines an interrupted side effect for operator review", () => {
    const state: ApplicationState = {
      version: 2,
      baselines: {},
      orders: {
        "synthetic-main/synthetic": {
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          providerStatus: "ReadyToShip",
          workflowStatus: "pending",
          matchedRuleIds: ["default"],
          ruleReasons: {},
          actions: {
            print: {
              status: "running",
              attempts: 1,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      },
    };

    const recovered = recoverInterruptedActions(state);

    expect(recovered.orders["synthetic-main/synthetic"]?.workflowStatus).toBe(
      "review-required",
    );
    expect(
      recovered.orders["synthetic-main/synthetic"]?.actions.print,
    ).toMatchObject({
      status: "review-required",
      errorCode: "INTERRUPTED_DURING_SIDE_EFFECT",
    });
  });

  it("rejects malformed nested state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-state-"));
    try {
      const path = join(directory, "state.json");
      await writeFile(
        path,
        JSON.stringify({ version: 1, orders: { synthetic: null } }),
        "utf8",
      );

      await expect(new JsonStateStore(path).load()).rejects.toMatchObject({
        code: "PERSISTENCE_ERROR",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy dry-run actions into pending work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-state-"));
    try {
      const path = join(directory, "state.json");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          baselineCompletedAt: "2026-01-01T00:00:00.000Z",
          orders: {
            synthetic: {
              firstSeenAt: "2026-01-01T00:00:00.000Z",
              lastSeenAt: "2026-01-01T00:00:00.000Z",
              providerStatus: "ReadyToShip",
              workflowStatus: "dry-run",
              matchedRuleIds: ["default"],
              ruleReasons: {},
              actions: {
                print: {
                  status: "dry-run",
                  attempts: 1,
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              },
            },
          },
        }),
        "utf8",
      );

      const state = await new JsonStateStore(path, {
        legacyConnectionId: "tcgplayer-main",
      }).load();

      expect(state.version).toBe(2);
      expect(state.baselines).toEqual({
        "tcgplayer-main": "2026-01-01T00:00:00.000Z",
      });
      expect(state.orders["tcgplayer-main/synthetic"]).toMatchObject({
        workflowStatus: "pending",
        actions: { print: { status: "pending", attempts: 1 } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
