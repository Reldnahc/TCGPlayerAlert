import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigurationService,
  immediateSyncLease,
  loadConfig,
  PriceUpdateQueueStore,
  RepricingService,
  startConfigurationUi,
  type ConfigurationUiServer,
} from "../src/index.js";
import { CONFIG_UI_JS } from "../src/config-ui-assets.js";

const discovery = () =>
  Promise.resolve({
    supported: true,
    printers: [
      { name: "Synthetic Label Printer", isDefault: false },
      { name: "Synthetic Office Printer", isDefault: true },
    ],
  });

async function configurationFixture(): Promise<{
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
    }),
  };
}

describe("configuration UI service", () => {
  let server: ConfigurationUiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("discovers printers and atomically saves independently enabled outputs", async () => {
    const fixture = await configurationFixture();
    const initial = await fixture.service.read();
    const address = initial.outputs.find(
      (output) => output.type === "print-address-label",
    );
    const packingSlip = initial.outputs.find(
      (output) => output.type === "print-packing-slip",
    );
    if (address === undefined || packingSlip === undefined) {
      throw new Error("The fixture is missing print actions.");
    }

    const saved = await fixture.service.save({
      revision: initial.revision,
      pollIntervalMinutes: 15,
      dryRun: false,
      priceUpdateQueue: {
        enabled: true,
        delaySeconds: 0,
      },
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
          actionId: packingSlip.actionId,
          enabled: true,
          printerName: "Synthetic Office Printer",
          dpi: 200,
          scale: "fit",
        },
      ],
    });
    const config = await loadConfig(fixture.path);

    expect(saved.revision).not.toBe(initial.revision);
    expect(config).toMatchObject({
      pollIntervalMinutes: 15,
      dryRun: false,
      priceUpdateQueue: { enabled: true, delaySeconds: 0 },
    });
    expect(config.actions[address.actionId]?.enabled).toBe(false);
    expect(config.actions[packingSlip.actionId]?.enabled).toBe(true);
    expect(config.printers[address.printerId]?.printerName).toBe(
      "Synthetic Label Printer",
    );
    expect(config.printers[packingSlip.printerId]).toMatchObject({
      printerName: "Synthetic Office Printer",
      dpi: 200,
      scale: "fit",
    });
  });

  it("rejects a stale browser revision without overwriting newer settings", async () => {
    const fixture = await configurationFixture();
    const initial = await fixture.service.read();
    await writeFile(fixture.path, `${await readFile(fixture.path, "utf8")} `);

    await expect(
      fixture.service.save({
        ...initial,
        pollIntervalMinutes: 30,
      }),
    ).rejects.toThrow("Settings changed on disk.");

    expect(await readFile(fixture.path, "utf8")).toMatch(/\s $/u);
  });

  it("ships syntactically valid browser JavaScript", () => {
    expect(() => new Script(CONFIG_UI_JS)).not.toThrow();
  });

  it("serves the browser UI on loopback and accepts same-origin updates only", async () => {
    const fixture = await configurationFixture();
    const priceQueue = new PriceUpdateQueueStore({
      stateFile: join(dirname(fixture.path), "price-updates.json"),
      historyLimit: 25,
      lease: immediateSyncLease,
    });
    const repricingService = new RepricingService({
      sellerKey: "synthetic-seller",
      client: {
        listSellerInventory: () => Promise.resolve([]),
        searchMarketplaceProducts: () =>
          Promise.resolve({ totalProducts: 0, products: [] }),
      },
    });
    server = await startConfigurationUi({
      configPath: fixture.path,
      port: 0,
      service: fixture.service,
      priceQueue,
      priceWorkerRunning: true,
      repricingService,
    });

    const page = await fetch(server.url);
    const settings = await fetch(`${server.url}/api/settings`);
    const forbidden = await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.test",
      },
      body: "{}",
    });
    const queued = await fetch(`${server.url}/api/price-updates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: server.url,
      },
      body: JSON.stringify({
        productId: 123,
        productName: "Synthetic Card",
        productConditionId: 456,
        conditionId: 1,
        channelId: 0,
        categoryName: "Synthetic Game",
        quantity: 7,
        price: 1.15,
        storePriceCustomId: null,
        reserveQuantity: 2,
      }),
    });
    const queueStatus = await fetch(`${server.url}/api/price-updates`);
    const repricingPreview = await fetch(
      `${server.url}/api/repricing/preview`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.url,
        },
        body: JSON.stringify({
          minimumPrice: 0.35,
          conditionPolicy: "same-or-better",
          priceBasis: "delivered",
          adjustmentCents: 0,
          allowPriceIncreases: false,
        }),
      },
    );

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Choose what prints");
    expect(repricingPreview.status).toBe(200);
    expect(await repricingPreview.json()).toMatchObject({
      counts: { ready: 0, unchanged: 0, skipped: 0 },
      rows: [],
    });
    expect(settings.status).toBe(200);
    expect(forbidden.status).toBe(403);
    expect(queued.status).toBe(202);
    expect(await queueStatus.json()).toMatchObject({
      workerRunning: true,
      counts: { pending: 1 },
    });
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});
