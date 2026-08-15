import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationService,
  InternalJobStore,
  loadConfig,
  startConfigurationUi,
  type AppConfig,
  type BackgroundShipmentScanner,
  type ConfigurationUiServer,
  type FeedbackManagementService,
  type MessageManagementService,
  type OrderManagementService,
  type OrderSyncCoordinator,
  type PaymentManagementService,
  type RepricingService,
  type SellerSessionService,
  type ShipmentScannerService,
} from "../src/index.js";
import { DEFAULT_PULL_LIST_BINNING_CONFIG } from "../src/pull-list-binning.js";

const discovery = () =>
  Promise.resolve({
    supported: true,
    printers: [
      { name: "Synthetic Label Printer", isDefault: false },
      { name: "Synthetic Office Printer", isDefault: true },
    ],
  });

async function fixture(): Promise<{
  readonly path: string;
  readonly service: ConfigurationService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-ui-"));
  const path = join(directory, "local.json");
  await writeFile(path, await readFile("config/local.example.json", "utf8"));
  return {
    path,
    service: new ConfigurationService({
      configPath: path,
      discoverPrinters: discovery,
      discoverCameras: () =>
        Promise.resolve({
          cameras: [
            {
              id: "synthetic-camera",
              label: "Synthetic Camera",
              isDefault: true,
            },
          ],
        }),
    }),
  };
}

describe("configuration UI", () => {
  let server: ConfigurationUiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reads and atomically saves profile, queue, and printer settings", async () => {
    const current = await fixture();
    const initial = await current.service.read();
    const address = initial.outputs.find(
      (output) => output.type === "print-address-label",
    );
    const packing = initial.outputs.find(
      (output) => output.type === "print-packing-slip",
    );
    const merchandise = initial.merchandiseProfiles[0];
    const pricing = initial.repricingProfiles[0];
    if (
      address === undefined ||
      packing === undefined ||
      merchandise === undefined ||
      pricing === undefined
    )
      throw new Error("The fixture is incomplete.");

    const saved = await current.service.save({
      revision: initial.revision,
      pollIntervalMinutes: 15,
      confirmBeforeMarkingShipped: false,
      masterPullList: {
        groupLands: false,
        groupMulticolored: false,
        binning: initial.masterPullList.binning,
      },
      shipmentScanner: {
        enabled: true,
        automaticallyMarkShipped: false,
        soundEnabled: false,
        camera: { enabled: true, deviceId: "synthetic-camera" },
      },
      priceUpdateQueue: { enabled: true, delaySeconds: 0 },
      inventoryAdditionQueue: { enabled: true, delaySeconds: 0 },
      notifications: initial.notifications,
      merchandiseProfiles: [
        {
          ...merchandise,
          estimatedShippingPrice: 0.99,
          defaultCondition: "Lightly Played",
        },
      ],
      defaultMerchandiseProfileId: merchandise.id,
      repricingProfiles: [{ ...pricing, name: "Operator profile" }],
      defaultRepricingProfileId: pricing.id,
      outputs: [
        {
          actionId: address.actionId,
          enabled: false,
          printerName: "Synthetic Label Printer",
          widthMm: 89,
          heightMm: 28,
          marginMm: 3,
          fontSize: 14,
        },
        {
          actionId: packing.actionId,
          enabled: true,
          printerName: "Synthetic Office Printer",
          dpi: 200,
          scale: "fit",
        },
      ],
    });
    const config = await loadConfig(current.path);

    expect(saved.revision).not.toBe(initial.revision);
    expect(config).toMatchObject({
      pollIntervalMinutes: 15,
      confirmBeforeMarkingShipped: false,
      masterPullList: {
        groupLands: false,
        groupMulticolored: false,
      },
      shipmentScanner: {
        enabled: true,
        automaticallyMarkShipped: false,
        soundEnabled: false,
        camera: { enabled: true, deviceId: "synthetic-camera" },
      },
      merchandiseProfiles: [
        { estimatedShippingPrice: 0.99, defaultCondition: "Lightly Played" },
      ],
      repricingProfiles: [{ name: "Operator profile" }],
    });
    expect(config.actions[address.actionId]?.enabled).toBe(false);
    expect(config.printers[packing.printerId]).toMatchObject({
      printerName: "Synthetic Office Printer",
      dpi: 200,
      scale: "fit",
    });
  });

  it("leaves version-one files untouched until a successful settings save", async () => {
    const current = await fixture();
    const source = JSON.parse(await readFile(current.path, "utf8")) as Record<
      string,
      unknown
    >;
    source.version = 1;
    delete source.confirmBeforeMarkingShipped;
    delete source.masterPullList;
    await writeFile(current.path, `${JSON.stringify(source, null, 2)}\n`);

    const initial = await current.service.read();
    const afterRead = JSON.parse(
      await readFile(current.path, "utf8"),
    ) as Record<string, unknown>;

    expect(afterRead.version).toBe(1);
    expect(afterRead.confirmBeforeMarkingShipped).toBeUndefined();
    expect(initial.confirmBeforeMarkingShipped).toBe(true);
    expect(initial.masterPullList).toEqual({
      groupLands: true,
      groupMulticolored: true,
      binning: DEFAULT_PULL_LIST_BINNING_CONFIG,
    });

    await current.service.save(initial);
    const afterSave = JSON.parse(
      await readFile(current.path, "utf8"),
    ) as Record<string, unknown>;

    expect(afterSave.version).toBe(5);
    expect(afterSave.confirmBeforeMarkingShipped).toBe(true);
    expect(afterSave.masterPullList).toEqual({
      groupLands: true,
      groupMulticolored: true,
      binning: DEFAULT_PULL_LIST_BINNING_CONFIG,
    });
  });

  it("rejects stale revisions and dependent pricing-profile removal", async () => {
    const current = await fixture();
    const initial = await current.service.read();
    await writeFile(current.path, `${await readFile(current.path, "utf8")} `);
    await expect(
      current.service.save({ ...initial, pollIntervalMinutes: 30 }),
    ).rejects.toThrow("Settings changed on disk.");

    const fresh = await current.service.read();
    const pricing = fresh.repricingProfiles[0];
    if (pricing === undefined) throw new Error("Missing pricing profile.");
    await expect(
      current.service.save({
        ...fresh,
        repricingProfiles: [{ ...pricing, id: "replacement" }],
        defaultRepricingProfileId: "replacement",
      }),
    ).rejects.toMatchObject({
      issues: [
        expect.stringContaining("must reference an existing pricing profile"),
      ],
    });
  });

  it("serves the compiled application and hashed assets with local security headers", async () => {
    const current = await fixture();
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
    });
    const page = await fetch(server.url);
    const html = await page.text();
    const assetPath = /src="(\/assets\/[^"]+\.js)"/u.exec(html)?.[1];
    if (assetPath === undefined)
      throw new Error("The compiled JavaScript asset is missing.");
    const asset = await fetch(`${server.url}${assetPath}`);
    const wasm = await fetch(
      `${server.url}/vendor/apriltag-js/apriltag_wasm.wasm`,
    );

    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    expect(html).toContain('<div id="app"></div>');
    expect(html).not.toContain("Seller workspace");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("text/javascript");
    expect((await asset.text()).length).toBeGreaterThan(1_000);
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("Content-Type")).toBe("application/wasm");
    expect(new Uint8Array(await wasm.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([0, 97, 115, 109]),
    );
  });

  it("manages and tests the Discord webhook without returning its secret", async () => {
    const current = await fixture();
    let configured = false;
    const connect = vi.fn((webhookUrl: string) => {
      expect(webhookUrl).toContain("discord.com/api/webhooks");
      configured = true;
      return Promise.resolve({
        configured: true,
        source: "protected" as const,
        protectedStorage: true,
      });
    });
    const disconnect = vi.fn(() => {
      configured = false;
      return Promise.resolve({ configured: false, protectedStorage: true });
    });
    const sendTest = vi.fn(() => Promise.resolve());
    const discordWebhook = {
      status: () => ({ configured, protectedStorage: true }),
      connect,
      disconnect,
      sendTest,
    };
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      discordWebhook,
    });
    const mutationHeaders = {
      "content-type": "application/json",
      origin: server.url,
    };
    const secret =
      "https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz012345";

    const initial = await fetch(`${server.url}/api/notifications/discord`);
    const connected = await fetch(
      `${server.url}/api/notifications/discord/connect`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ webhookUrl: secret }),
      },
    );
    const tested = await fetch(`${server.url}/api/notifications/discord/test`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    const removed = await fetch(
      `${server.url}/api/notifications/discord/disconnect`,
      { method: "POST", headers: mutationHeaders, body: "{}" },
    );

    expect(await initial.json()).toEqual({
      configured: false,
      protectedStorage: true,
    });
    expect(JSON.stringify(await connected.json())).not.toContain(secret);
    expect(await tested.json()).toEqual({ delivered: true });
    expect(await removed.json()).toEqual({
      configured: false,
      protectedStorage: true,
    });
    expect(connect).toHaveBeenCalledWith(secret);
    expect(sendTest).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("serves aggregate seller request metrics without request targets", async () => {
    const current = await fixture();
    const sellerRequestMetrics = vi.fn(() => ({
      maximumConcurrency: 2,
      minimumStartSpacingMs: 250,
      requestAttempts: 12,
      successfulResponses: 10,
      errorResponses: 1,
      networkFailures: 1,
      abortedRequests: 0,
      inFlightRequests: 2,
      queuedRequests: 3,
      peakInFlightRequests: 2,
      lastStartedAt: "2026-08-10T12:00:00.000Z",
      lastCompletedAt: "2026-08-10T11:59:59.000Z",
    }));
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      sellerRequestMetrics,
    });

    const response = await fetch(`${server.url}/api/provider/requests`);
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      requestAttempts: 12,
      maximumConcurrency: 2,
      minimumStartSpacingMs: 250,
      inFlightRequests: 2,
      queuedRequests: 3,
      peakInFlightRequests: 2,
    });
    expect(JSON.stringify(body)).not.toMatch(/url|path|seller|order/iu);
    expect(sellerRequestMetrics).toHaveBeenCalledOnce();
  });

  it("accepts same-origin settings updates and rejects cross-origin mutations", async () => {
    const current = await fixture();
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
    });
    const initial = (await (
      await fetch(`${server.url}/api/settings`)
    ).json()) as Record<string, unknown>;
    const update = { ...initial, pollIntervalMinutes: 17 };
    const serverUrl = server.url;
    const request = (origin: string) =>
      fetch(`${serverUrl}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(update),
      });

    const forbidden = await request("https://example.test");
    const accepted = await request(server.url);
    expect(forbidden.status).toBe(403);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ pollIntervalMinutes: 17 });
  });

  it("manages internal schedules and manual runs through the loopback API", async () => {
    const current = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-jobs-ui-"));
    const internalJobs = new InternalJobStore({
      stateFile: join(directory, "jobs.json"),
    });
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      internalJobs,
      internalJobRunnerRunning: true,
      port: 0,
    });
    const mutate = (path: string, method: string, body: unknown) =>
      fetch(`${server?.url ?? ""}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: server?.url ?? "",
        },
        body: JSON.stringify(body),
      });
    const input = {
      name: "Nightly review",
      enabled: true,
      timing: {
        kind: "daily",
        timeOfDay: "03:00",
        timeZone: "America/Chicago",
      },
      payload: {
        type: "reprice-inventory",
        pricingProfileId: "match-lowest",
        mode: "review",
        scope: "all",
        limits: {
          maximumUpdates: 200,
          maximumDecreasePercent: 20,
          maximumDecreaseAmount: 20,
          maximumIncreasePercent: 100,
          maximumBlockedPercent: 20,
        },
      },
    };

    const createdResponse = await mutate(
      "/api/internal-jobs/schedules",
      "POST",
      input,
    );
    const created = (await createdResponse.json()) as {
      schedule: { id: string };
    };
    const runResponse = await mutate(
      `/api/internal-jobs/schedules/${created.schedule.id}/run`,
      "POST",
      {},
    );
    const run = (await runResponse.json()) as { run: { id: string } };
    const canceledResponse = await mutate(
      `/api/internal-jobs/runs/${run.run.id}`,
      "DELETE",
      {},
    );
    const snapshotResponse = await fetch(`${server.url}/api/internal-jobs`);
    const snapshot = (await snapshotResponse.json()) as {
      runnerRunning: boolean;
      schedules: readonly unknown[];
      runs: readonly { status: string }[];
    };

    expect(createdResponse.status).toBe(201);
    expect(runResponse.status).toBe(202);
    expect(canceledResponse.status).toBe(200);
    expect(snapshot).toMatchObject({
      runnerRunning: true,
      schedules: [expect.objectContaining({ name: "Nightly review" })],
      runs: [expect.objectContaining({ status: "canceled" })],
    });
  });

  it("pairs a browser session through the loopback UI without returning the cookie", async () => {
    const current = await fixture();
    const connectedStatus = {
      state: "connected" as const,
      source: "browser" as const,
      automaticRenewal: true,
      protectedStorage: true,
      updatedAt: "2026-08-08T12:00:00.000Z",
    };
    const connect = vi.fn(() =>
      Promise.resolve({
        connectorToken: "a".repeat(64),
        status: connectedStatus,
      }),
    );
    const renew = vi.fn(() => Promise.resolve(connectedStatus));
    const sessionManager: SellerSessionService = {
      connectionStatus: () => ({
        state: "disconnected",
        automaticRenewal: false,
        protectedStorage: true,
      }),
      startPairing: () => ({
        pairingCode: "ABCD-EF01-2345-6789",
        expiresAt: "2026-08-08T12:10:00.000Z",
      }),
      connect,
      renew,
      disconnect: () =>
        Promise.resolve({
          state: "disconnected",
          automaticRenewal: false,
          protectedStorage: true,
        }),
    };
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      sessionManager,
      port: 0,
    });
    const challenge = await fetch(`${server.url}/api/auth/pairing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: "{}",
    });
    const challengeBody = (await challenge.json()) as Record<string, unknown>;
    const connected = await fetch(`${server.url}/api/auth/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "moz-extension://00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({
        pairingCode: challengeBody.pairingCode,
        authCookie: "synthetic-browser-cookie",
      }),
    });
    const body = (await connected.json()) as Record<string, unknown>;
    const renewed = await fetch(`${server.url}/api/auth/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "moz-extension://00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({
        connectorToken: "a".repeat(64),
        authCookie: "synthetic-renewed-cookie",
      }),
    });
    const preflight = await fetch(`${server.url}/api/auth/session`, {
      method: "OPTIONS",
      headers: {
        Origin: "moz-extension://00000000-0000-4000-8000-000000000001",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });

    expect(challenge.status).toBe(201);
    expect(challengeBody).toMatchObject({
      pairingCode: "ABCD-EF01-2345-6789",
      port: Number(new URL(server.url).port),
    });
    expect(connected.status).toBe(200);
    expect(connected.headers.get("Access-Control-Allow-Origin")).toBe(
      "moz-extension://00000000-0000-4000-8000-000000000001",
    );
    expect(connect).toHaveBeenCalledWith("ABCD-EF01-2345-6789", {
      authCookie: "synthetic-browser-cookie",
    });
    expect(renewed.status).toBe(200);
    expect(renew).toHaveBeenCalledWith("a".repeat(64), {
      authCookie: "synthetic-renewed-cookie",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe(
      "true",
    );
    expect(JSON.stringify(body)).not.toContain("synthetic-browser-cookie");
    expect(body).toMatchObject({ connectorToken: "a".repeat(64) });
  });

  it("keeps ready-order reads pure and synchronizes only through an explicit mutation", async () => {
    const current = await fixture();
    const ready = {
      orders: [],
      fetchedAt: "2026-08-07T12:00:00.000Z",
    };
    const listReadyOrders = vi.fn(() => ready);
    const synchronizeReadyOrders = vi
      .fn<
        (options: { readonly signal: AbortSignal }) => Promise<typeof ready>
      >()
      .mockResolvedValue(ready);
    const listOrders = vi.fn(() => Promise.resolve(ready));
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      orderService: { listOrders } as unknown as OrderManagementService,
      orderSync: {
        listReadyOrders,
        synchronizeReadyOrders,
      } as unknown as OrderSyncCoordinator,
    });

    const response = await fetch(
      `${server.url}/api/orders?status=ready-to-ship`,
    );
    const rejectedImplicitSync = await fetch(
      `${server.url}/api/orders?status=ready-to-ship&refresh=1`,
    );
    const synchronized = await fetch(`${server.url}/api/orders/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: server.url,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshot: ready });
    expect(rejectedImplicitSync.status).toBe(400);
    expect(await rejectedImplicitSync.json()).toEqual({
      message: "Ready-order synchronization requires the explicit sync action.",
    });
    expect(synchronized.status).toBe(200);
    expect(await synchronized.json()).toEqual(ready);
    expect(listReadyOrders).toHaveBeenCalledOnce();
    expect(synchronizeReadyOrders).toHaveBeenCalledOnce();
    expect(synchronizeReadyOrders.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(listOrders).not.toHaveBeenCalled();
  });

  it("reports an unavailable ready-order snapshot without starting work", async () => {
    const current = await fixture();
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      orderService: {} as OrderManagementService,
    });

    const response = await fetch(
      `${server.url}/api/orders?status=ready-to-ship`,
    );
    const synchronization = await fetch(`${server.url}/api/orders/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: server.url,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshot: null });
    expect(synchronization.status).toBe(503);
    expect(await synchronization.json()).toEqual({
      message: "Order synchronization is unavailable.",
    });
  });

  it("serves an exact internal order detail with explicit refresh control", async () => {
    const current = await fixture();
    const detail = {
      orderNumber: "SYNTHETIC-ORDER-1",
      buyerName: "Synthetic Buyer",
      status: "Ready to Ship",
      fetchedAt: "2026-08-07T12:00:00.000Z",
    };
    const getOrder = vi
      .fn<
        (
          orderNumber: string,
          options: { readonly force: boolean; readonly signal: AbortSignal },
        ) => Promise<typeof detail>
      >()
      .mockResolvedValue(detail);
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      orderService: { getOrder } as unknown as OrderManagementService,
    });

    const response = await fetch(
      `${server.url}/api/orders/SYNTHETIC-ORDER-1?refresh=1`,
    );
    const invalid = await fetch(`${server.url}/api/orders/${"A".repeat(129)}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
    expect(getOrder).toHaveBeenCalledOnce();
    expect(getOrder.mock.calls[0]?.[0]).toBe("SYNTHETIC-ORDER-1");
    expect(getOrder.mock.calls[0]?.[1].force).toBe(true);
    expect(getOrder.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      issues: ["The order number is invalid."],
    });
  });

  it("serves the master ready-order pull list with explicit refresh control", async () => {
    const current = await fixture();
    const pullList = {
      orderCount: 2,
      totalQuantity: 2,
      pulledQuantity: 0,
      remainingQuantity: 2,
      fetchedAt: "2026-08-07T12:00:00.000Z",
      rows: [
        {
          productLine: "Magic: The Gathering",
          productName: "Synthetic Card",
          condition: "Near Mint",
          number: "42",
          setName: "Synthetic Set",
          rarity: "Rare",
          quantity: 3,
          mainPhotoUrl: "https://www.example.test/card.jpg",
          setReleaseDate: "2026-01-01",
          skuId: "456",
          orderQuantity: 2,
          productId: 123,
          attributes: { color: ["Blue"], cardType: ["Creature"] },
          metadata: [{ label: "Color", values: ["Blue"] }],
          bin: "MTG / Blue / Creature / No power",
          pulledQuantity: 0,
          remainingQuantity: 2,
          pulled: false,
          canTrackPullProgress: true,
        },
      ],
    };
    const getMasterPullList = vi
      .fn<
        (options: {
          readonly force: boolean;
          readonly signal: AbortSignal;
        }) => Promise<typeof pullList>
      >()
      .mockResolvedValue(pullList);
    const setPullListRowPulled = vi
      .fn((skuId: string, pulled: boolean, signal?: AbortSignal) => {
        void skuId;
        void pulled;
        void signal;
        return Promise.resolve(pullList.rows[0]);
      })
      .mockName("setPullListRowPulled");
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      orderService: {
        getMasterPullList,
        setPullListRowPulled,
      } as unknown as OrderManagementService,
    });

    const response = await fetch(
      `${server.url}/api/orders/pull-list?refresh=1`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(pullList);
    expect(getMasterPullList).toHaveBeenCalledOnce();
    expect(getMasterPullList.mock.calls[0]?.[0].force).toBe(true);
    expect(getMasterPullList.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );

    const update = await fetch(`${server.url}/api/orders/pull-list/items/456`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.url,
      },
      body: JSON.stringify({ pulled: true }),
    });

    expect(update.status).toBe(200);
    expect(await update.json()).toEqual(pullList.rows[0]);
    expect(setPullListRowPulled).toHaveBeenCalledOnce();
    expect(setPullListRowPulled.mock.calls[0]?.[0]).toBe("456");
    expect(setPullListRowPulled.mock.calls[0]?.[1]).toBe(true);
    expect(setPullListRowPulled.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);

    const invalid = await fetch(
      `${server.url}/api/orders/pull-list/items/456`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: server.url,
        },
        body: JSON.stringify({ pulled: "yes" }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(setPullListRowPulled).toHaveBeenCalledOnce();
  });

  it("routes validated order refunds through the injected order service", async () => {
    const current = await fixture();
    const refundOptions = {
      origins: [{ name: "Seller initiated", value: "SellerInitiated" }],
      reasons: [
        { name: "Inventory issue", value: "Product - Inventory Issue" },
      ],
    };
    const getRefundOptions = vi
      .fn<
        (options: {
          readonly force?: boolean;
          readonly signal?: AbortSignal;
        }) => Promise<typeof refundOptions>
      >()
      .mockResolvedValue(refundOptions);
    const refundOrder = vi.fn(() =>
      Promise.resolve({
        orderNumber: "SYNTHETIC-ORDER-1",
        refundType: "partial" as const,
        outcome: "submitted" as const,
      }),
    );
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      orderService: {
        getRefundOptions,
        refundOrder,
      } as unknown as OrderManagementService,
    });

    const options = await fetch(
      `${server.url}/api/orders/refunds/options?refresh=1`,
    );
    const response = await fetch(
      `${server.url}/api/orders/SYNTHETIC-ORDER-1/refund`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: server.url,
        },
        body: JSON.stringify({
          type: "partial",
          origin: "SellerInitiated",
          reason: "Product - Inventory Issue",
          reasonText: "Synthetic refund explanation",
          shippingRefundAmount: 0.49,
          products: [{ skuId: "synthetic-sku", refundAmount: 2 }],
        }),
      },
    );

    expect(options.status).toBe(200);
    expect(await options.json()).toEqual(refundOptions);
    expect(getRefundOptions).toHaveBeenCalledOnce();
    expect(getRefundOptions.mock.calls[0]?.[0].force).toBe(true);
    expect(getRefundOptions.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "submitted" });
    expect(refundOrder).toHaveBeenCalledWith(
      "SYNTHETIC-ORDER-1",
      {
        type: "partial",
        origin: "SellerInitiated",
        reason: "Product - Inventory Issue",
        reasonText: "Synthetic refund explanation",
        shippingRefundAmount: 0.49,
        products: [{ skuId: "synthetic-sku", refundAmount: 2 }],
      },
      expect.any(AbortSignal),
    );
  });

  it("routes confirmed shipment tags through the injected scanner service", async () => {
    const current = await fixture();
    const status = vi.fn(() =>
      Promise.resolve({
        enabled: true,
        automaticallyMarkShipped: false,
        soundEnabled: true,
        readyOrderCount: 1,
        readyTagIds: [42],
        conflictingTagCount: 0,
        reviewRequiredCount: 0,
      }),
    );
    const scan = vi.fn(() =>
      Promise.resolve({ state: "no-match" as const, tagId: 42 }),
    );
    const markShipped = vi.fn(() =>
      Promise.resolve({
        state: "already-processed" as const,
        tagId: 42,
        orderNumber: "SYNTHETIC-ORDER",
      }),
    );
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      shipmentScannerService: {
        status,
        scan,
        markShipped,
      } as unknown as ShipmentScannerService,
    });
    const mutationHeaders = {
      "Content-Type": "application/json",
      Origin: server.url,
    };

    const statusResponse = await fetch(`${server.url}/api/shipment-scanner`);
    const scanResponse = await fetch(
      `${server.url}/api/shipment-scanner/scan`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ tagId: 42 }),
      },
    );
    const markResponse = await fetch(
      `${server.url}/api/shipment-scanner/mark-shipped`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ tagId: 42, orderNumber: "SYNTHETIC-ORDER" }),
      },
    );

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({
      enabled: true,
      automaticallyMarkShipped: false,
      soundEnabled: true,
      readyOrderCount: 1,
      readyTagIds: [42],
      conflictingTagCount: 0,
      reviewRequiredCount: 0,
      backgroundCamera: {
        state: "unavailable",
        deviceId: "",
        consensus: { tagId: null, matchingReads: 0, requiredReads: 0 },
        issue: "Background capture is available while the service is running.",
      },
    });
    expect(status).toHaveBeenCalledOnce();
    expect(await scanResponse.json()).toEqual({ state: "no-match", tagId: 42 });
    expect(await markResponse.json()).toEqual({
      state: "already-processed",
      tagId: 42,
      orderNumber: "SYNTHETIC-ORDER",
    });
    expect(scan).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    expect(markShipped).toHaveBeenCalledWith(
      42,
      "SYNTHETIC-ORDER",
      expect.any(AbortSignal),
    );
  });

  it("serves the latest service-owned camera frame without caching it", async () => {
    const current = await fixture();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const cameraPreview = vi
      .fn()
      .mockResolvedValueOnce({
        capturedAt: "2026-08-10T12:00:00.000Z",
        mediaType: "image/jpeg" as const,
        bytes,
      })
      .mockResolvedValueOnce(undefined);
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      backgroundShipmentScanner: {
        cameraPreview,
      } as unknown as BackgroundShipmentScanner,
    });

    const response = await fetch(
      `${server.url}/api/shipment-scanner/camera-frame`,
    );
    const missing = await fetch(
      `${server.url}/api/shipment-scanner/camera-frame`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Camera-Frame-At")).toBe(
      "2026-08-10T12:00:00.000Z",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      message: "No background camera frame is available.",
    });
    expect(cameraPreview).toHaveBeenCalledTimes(2);
  });

  it("streams concrete repricing progress before the completed preview", async () => {
    const current = await fixture();
    const preview = vi.fn(
      (
        _rules: unknown,
        options: {
          readonly onProgress?: (progress: unknown) => void;
        },
      ) => {
        options.onProgress?.({
          phase: "inventory",
          completed: 200,
          total: 400,
          unit: "products",
          detail: "Loading seller inventory",
        });
        return Promise.resolve({ id: "synthetic-preview" });
      },
    );
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      repricingService: { preview } as unknown as RepricingService,
    });

    const response = await fetch(`${server.url}/api/repricing/preview`, {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
        Origin: server.url,
      },
      body: "{}",
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      "application/x-ndjson",
    );
    expect(events).toEqual([
      {
        type: "progress",
        progress: {
          phase: "inventory",
          completed: 200,
          total: 400,
          unit: "products",
          detail: "Loading seller inventory",
        },
      },
      { type: "complete", preview: { id: "synthetic-preview" } },
    ]);
  });

  it("serves paginated read-only payments and payout details", async () => {
    const current = await fixture();
    const list = vi.fn(() =>
      Promise.resolve({
        experience: "money-movement" as const,
        totalPayouts: 26,
        page: 2,
        pageSize: 25,
        payouts: [],
        unpaidBalance: { totalBalance: 1_250, transactions: [] },
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
    const get = vi.fn((referenceId: string) =>
      Promise.resolve({
        payoutId: "synthetic-payout",
        referenceId,
        createdAt: "2026-08-01T12:00:00.000Z",
        amount: 10_000,
        status: "Succeeded",
        totalSales: 11_000,
        totalRefunds: 0,
        totalFees: -1_000,
        totalAdjustments: 0,
        transactions: [],
      }),
    );
    const paymentService = { list, get } as unknown as PaymentManagementService;
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      paymentService,
    });

    const page = await fetch(
      `${server.url}/api/payments?page=2&status=Succeeded&refresh=1`,
    );
    const detail = await fetch(
      `${server.url}/api/payments/SYNTHETIC%20PAYOUT%2F1`,
    );
    const invalid = await fetch(`${server.url}/api/payments?status=Invented`);
    const invalidPage = await fetch(`${server.url}/api/payments?page=0`);

    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      totalPayouts: 26,
      unpaidBalance: { totalBalance: 1_250 },
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        status: "Succeeded",
        force: true,
      }),
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      referenceId: "SYNTHETIC PAYOUT/1",
    });
    expect(get).toHaveBeenCalledWith(
      "SYNTHETIC PAYOUT/1",
      expect.objectContaining({ force: false }),
    );
    expect(invalid.status).toBe(400);
    expect(invalidPage.status).toBe(400);
    expect(await invalidPage.json()).toEqual({
      message: "The payment page is invalid.",
    });
  });

  it("serves filtered read-only seller feedback", async () => {
    const current = await fixture();
    const list = vi.fn(() =>
      Promise.resolve({
        page: 2,
        pageSize: 25,
        totalPages: 3,
        totalFeedback: 51,
        feedback: [],
        aggregation: {
          totalRatings: 75,
          fiveStar: 70,
          fourStar: 3,
          threeStar: 1,
          twoStar: 0,
          oneStar: 1,
          arrivedWhenExpected: { positive: 60, negative: 1, unanswered: 14 },
          asDescribed: { positive: 62, negative: 1, unanswered: 12 },
          goodCommunication: { positive: 58, negative: 1, unanswered: 16 },
          totalAdditionalRatings: 183,
        },
        storefrontUrl:
          "https://store.tcgplayer.com/sellerfeedback/synthetic-seller",
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
    const feedbackService = {
      list,
    } as unknown as FeedbackManagementService;
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      feedbackService,
    });

    const page = await fetch(
      `${server.url}/api/feedback?page=2&rating=4&comments=1&days=90&refresh=1`,
    );
    const invalid = await fetch(`${server.url}/api/feedback?rating=6`);

    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      totalFeedback: 51,
      aggregation: { totalRatings: 75 },
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        rating: 4,
        commentsOnly: true,
        days: 90,
        force: true,
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it("serves the read-only seller inbox, unread count, and thread detail", async () => {
    const current = await fixture();
    const unreadCount = vi.fn(() => Promise.resolve(2));
    const list = vi.fn(() =>
      Promise.resolve({
        page: 2,
        pageSize: 25,
        totalPages: 3,
        totalThreads: 51,
        unreadCount: 2,
        threads: [],
        portalUrl: "https://sellerportal.tcgplayer.com/messages",
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
    const get = vi.fn((threadId: number) =>
      Promise.resolve({
        threadId,
        subject: "Synthetic conversation",
        totalMessageCount: 1,
        messages: [],
        orderType: "SellerOrder",
        orderNumber: "SYNTHETIC-ORDER-1",
        deleted: false,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        portalUrl: `https://sellerportal.tcgplayer.com/messages/${String(threadId)}`,
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
    const markRead = vi.fn(() => Promise.resolve());
    const markAllRead = vi.fn(() => Promise.resolve({ markedThreadCount: 2 }));
    const reply = vi.fn(() => Promise.resolve());
    const messageService = {
      unreadCount,
      list,
      get,
      markRead,
      markAllRead,
      reply,
    } as unknown as MessageManagementService;
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      messageService,
    });

    const count = await fetch(
      `${server.url}/api/messages/unread-count?refresh=1`,
    );
    const page = await fetch(
      `${server.url}/api/messages?page=2&orderNumber=SYNTHETIC-ORDER-1&deleted=1&refresh=1`,
    );
    const detail = await fetch(`${server.url}/api/messages/123?page=2`);
    const mutationHeaders = {
      "content-type": "application/json",
      origin: server.url,
    };
    const markedRead = await fetch(`${server.url}/api/messages/123/mark-read`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    const markedAllRead = await fetch(
      `${server.url}/api/messages/mark-all-read`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: "{}",
      },
    );
    const replied = await fetch(`${server.url}/api/messages/123/reply`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ body: "Synthetic reply." }),
    });
    const crossOriginHeaders = {
      "content-type": "text/plain",
      origin: "https://malicious.example",
    };
    const rejectedMarkRead = await fetch(
      `${server.url}/api/messages/123/mark-read`,
      {
        method: "POST",
        headers: crossOriginHeaders,
        body: "{}",
      },
    );
    const rejectedMarkAllRead = await fetch(
      `${server.url}/api/messages/mark-all-read`,
      {
        method: "POST",
        headers: crossOriginHeaders,
        body: "{}",
      },
    );
    const rejectedReply = await fetch(`${server.url}/api/messages/123/reply`, {
      method: "POST",
      headers: crossOriginHeaders,
      body: JSON.stringify({ body: "Cross-origin reply." }),
    });
    const rejectedContentType = await fetch(
      `${server.url}/api/messages/123/reply`,
      {
        method: "POST",
        headers: { "content-type": "text/plain", origin: server.url },
        body: JSON.stringify({ body: "Wrong content type." }),
      },
    );
    const invalid = await fetch(`${server.url}/api/messages/not-a-thread`);
    const wrongMethod = await fetch(`${server.url}/api/messages`, {
      method: "DELETE",
      headers: mutationHeaders,
      body: "{}",
    });

    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ unreadCount: 2 });
    expect(unreadCount).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      totalThreads: 51,
      unreadCount: 2,
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        orderNumber: "SYNTHETIC-ORDER-1",
        includeDeleted: true,
        force: true,
      }),
    );
    expect(detail.status).toBe(200);
    expect(get).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ page: 2, force: false }),
    );
    expect(markedRead.status).toBe(200);
    expect(await markedRead.json()).toEqual({ threadId: 123 });
    expect(markRead).toHaveBeenCalledWith(123, expect.any(AbortSignal));
    expect(markedAllRead.status).toBe(200);
    expect(await markedAllRead.json()).toEqual({ markedThreadCount: 2 });
    expect(markAllRead).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(replied.status).toBe(200);
    expect(await replied.json()).toEqual({ threadId: 123 });
    expect(reply).toHaveBeenCalledWith(
      123,
      "Synthetic reply.",
      expect.any(AbortSignal),
    );
    expect(rejectedMarkRead.status).toBe(403);
    expect(rejectedMarkAllRead.status).toBe(403);
    expect(rejectedReply.status).toBe(403);
    expect(rejectedContentType.status).toBe(415);
    expect(markRead).toHaveBeenCalledOnce();
    expect(markAllRead).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect(invalid.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
  });

  it("prints synthetic output using the submitted unsaved printer settings", async () => {
    const current = await fixture();
    const initial = await current.service.read();
    const address = initial.outputs.find(
      (output) => output.type === "print-address-label",
    );
    if (address === undefined) throw new Error("Address output is missing.");
    const executePrintTest = vi.fn<
      (config: AppConfig, actionId: string) => Promise<void>
    >(() => Promise.resolve());
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      executePrintTest,
    });
    const candidate = {
      ...initial,
      outputs: initial.outputs.map((output) =>
        output.actionId === address.actionId
          ? {
              ...output,
              enabled: false,
              printerName: "Synthetic Label Printer",
              marginMm: 1,
              fontSize: 16,
            }
          : output,
      ),
    };
    const response = await fetch(
      `${server.url}/api/print-tests/${address.actionId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: server.url },
        body: JSON.stringify(candidate),
      },
    );

    expect(response.status).toBe(200);
    expect(executePrintTest).toHaveBeenCalledOnce();
    expect(
      executePrintTest.mock.calls[0]?.[0].actions[address.actionId],
    ).toMatchObject({ enabled: false, page: { marginMm: 1, fontSize: 16 } });
    expect(await readFile(current.path, "utf8")).not.toContain(
      '"fontSize": 16',
    );
  });

  it("validates and prints a pasted address without returning it", async () => {
    const current = await fixture();
    const executeAddressLabel = vi
      .fn<(lines: readonly string[], signal?: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    server = await startConfigurationUi({
      configPath: current.path,
      service: current.service,
      port: 0,
      executeAddressLabel,
    });
    const serverUrl = server.url;
    const print = (address: string) =>
      fetch(`${serverUrl}/api/address-labels/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: serverUrl },
        body: JSON.stringify({ address }),
      });

    const response = await print(
      " Synthetic Recipient\r\n123 Example Street\n\nExample City, IL 00000 ",
    );
    const invalid = await print("1\n2\n3\n4\n5\n6\n7\n8\n9");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ printed: true });
    expect(executeAddressLabel).toHaveBeenCalledWith(
      ["Synthetic Recipient", "123 Example Street", "Example City, IL 00000"],
      expect.any(AbortSignal),
    );
    expect(invalid.status).toBe(400);
    expect(executeAddressLabel).toHaveBeenCalledOnce();
  });
});
