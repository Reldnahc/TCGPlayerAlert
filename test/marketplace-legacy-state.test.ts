import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonNotificationStateStore,
  JsonQualifiedPullListProgressStore,
  JsonShipmentScanStore,
  JsonShipmentTagRegistry,
  JsonStateStore,
  orderRefKey,
} from "../src/index.js";
import { legacyMarketplaceStateFixtures } from "./marketplace-characterization-fixtures.js";

describe("legacy marketplace state characterization fixtures", () => {
  it("are accepted by every current production state reader", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "legacy-marketplace-state-"),
    );
    const workflowPath = join(directory, "workflow.json");
    const pullPath = join(directory, "pull.json");
    const tagsPath = join(directory, "tags.json");
    const scansPath = join(directory, "scans.json");
    const notificationsPath = join(directory, "notifications.json");
    await Promise.all([
      writeFixture(
        workflowPath,
        legacyMarketplaceStateFixtures.applicationWorkflow,
      ),
      writeFixture(pullPath, legacyMarketplaceStateFixtures.pullProgress),
      writeFixture(tagsPath, legacyMarketplaceStateFixtures.shipmentTags),
      writeFixture(scansPath, legacyMarketplaceStateFixtures.shipmentScans),
      writeFixture(
        notificationsPath,
        legacyMarketplaceStateFixtures.notifications,
      ),
    ]);

    const originalFiles = await Promise.all(
      [workflowPath, pullPath, tagsPath, scansPath, notificationsPath].map(
        (path) => readFile(path, "utf8"),
      ),
    );
    const legacyRef = {
      connectionId: "tcgplayer-main",
      remoteId: "LEGACY-TCG-100",
    } as const;
    const qualifiedKey = orderRefKey(legacyRef);
    await expect(
      new JsonStateStore(workflowPath, {
        legacyConnectionId: "tcgplayer-main",
      }).load(),
    ).resolves.toMatchObject({
      version: 2,
      baselines: {
        "tcgplayer-main": "2026-08-24T10:00:00.000Z",
      },
      orders: {
        [qualifiedKey]:
          legacyMarketplaceStateFixtures.applicationWorkflow.orders[
            "LEGACY-TCG-100"
          ],
      },
      lastSync: {
        outcome: "succeeded",
        connections: {
          "tcgplayer-main": {
            outcome: "succeeded",
            discoveredCount: 1,
            processedCount: 1,
          },
        },
      },
    });
    await expect(
      new JsonQualifiedPullListProgressStore(pullPath, {
        legacyConnectionId: "tcgplayer-main",
      }).load(),
    ).resolves.toEqual({
      version: 2,
      allocations: [
        {
          connectionId: "tcgplayer-main",
          remoteId: "LEGACY-TCG-100",
          lineKey: "legacy-sku-100",
          quantity: 2,
          pulledAt: "2026-08-24T11:05:00.000Z",
        },
      ],
    });
    await expect(
      new JsonShipmentTagRegistry(tagsPath, {
        legacyConnectionId: "tcgplayer-main",
      }).assigned([legacyRef]),
    ).resolves.toEqual([
      {
        ref: legacyRef,
        tagId: 100,
        assignedAt: "2026-08-24T11:10:00.000Z",
        assignedSequence: 1,
      },
    ]);
    await expect(
      new JsonShipmentScanStore(scansPath, {
        legacyConnectionId: "tcgplayer-main",
      }).load(),
    ).resolves.toEqual({
      version: 2,
      records: {
        [qualifiedKey]: {
          ref: legacyRef,
          tagId: 100,
          status: "review-required",
          updatedAt: "2026-08-24T11:11:00.000Z",
        },
      },
    });
    const notifications = new JsonNotificationStateStore(notificationsPath, {
      legacyConnectionId: "tcgplayer-main",
    });
    await expect(notifications.readReadyOrderRefs()).resolves.toEqual([
      legacyRef,
    ]);
    await expect(notifications.readMessages("tcgplayer-main")).resolves.toEqual(
      legacyMarketplaceStateFixtures.notifications.messages,
    );
    await expect(
      Promise.all(
        [workflowPath, pullPath, tagsPath, scansPath, notificationsPath].map(
          (path) => readFile(path, "utf8"),
        ),
      ),
    ).resolves.toEqual(originalFiles);
  });

  it("makes unsupported versions fail closed instead of resetting state", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "invalid-marketplace-state-"),
    );
    const paths = {
      workflow: join(directory, "workflow.json"),
      pull: join(directory, "pull.json"),
      tags: join(directory, "tags.json"),
      scans: join(directory, "scans.json"),
      notifications: join(directory, "notifications.json"),
    };
    await Promise.all(
      Object.values(paths).map((path) => writeFixture(path, { version: 999 })),
    );

    await expect(
      new JsonStateStore(paths.workflow, {
        legacyConnectionId: "tcgplayer-main",
      }).load(),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    await expect(
      new JsonQualifiedPullListProgressStore(paths.pull, {
        legacyConnectionId: "tcgplayer-main",
      }).load(),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(
      new JsonShipmentTagRegistry(paths.tags, {
        legacyConnectionId: "tcgplayer-main",
      }).assigned([]),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(
      new JsonShipmentScanStore(paths.scans, {
        legacyConnectionId: "tcgplayer-main",
      }).load(),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    await expect(
      new JsonNotificationStateStore(paths.notifications, {
        legacyConnectionId: "tcgplayer-main",
      }).readReadyOrderRefs(),
    ).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
  });
});

function writeFixture(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
