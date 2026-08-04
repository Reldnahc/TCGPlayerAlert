import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationService,
  immediateSyncLease,
  InventoryAdditionQueueStore,
  InventoryAdditionService,
  loadConfig,
  PriceUpdateQueueStore,
  RepricingService,
  startConfigurationUi,
  type AppConfig,
  type ConfigurationUiServer,
} from "../src/index.js";
import { CONFIG_UI_HTML, CONFIG_UI_JS } from "../src/config-ui-assets.js";

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
      inventoryAdditionQueue: {
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
      inventoryAdditionQueue: { enabled: true, delaySeconds: 0 },
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
    expect(CONFIG_UI_JS).not.toContain(
      ".filter((product) => product.sellerListable)",
    );
    expect(CONFIG_UI_JS).not.toContain("#inventory-sku");
    expect(CONFIG_UI_JS).toContain('refreshInventoryLanguages("English")');
    expect(CONFIG_UI_HTML).toContain(
      '<select id="inventory-basis"><option value="delivered">Item + shipping</option>',
    );
    expect(CONFIG_UI_JS).toContain("tcgplayer-alert.inventory-shipping");
    expect(CONFIG_UI_JS).toContain("localStorage.setItem");
    expect(CONFIG_UI_HTML).toContain('list="catalog-product-lines"');
    expect(CONFIG_UI_HTML).not.toContain('id="inventory-preview"');
    expect(CONFIG_UI_JS).toContain('text: "Load more"');
    expect(CONFIG_UI_JS).toContain('catalogSection("Exact name"');
    expect(CONFIG_UI_JS).toContain("state.catalogSearchToken");
    expect(CONFIG_UI_JS).toContain("state.catalogSearchController?.abort()");
    expect(CONFIG_UI_JS).toContain("signal: requestController.signal");
    expect(CONFIG_UI_JS).toContain(
      "new URLSearchParams({ q: query, offset: String(offset) })",
    );
    expect(CONFIG_UI_JS).toContain('text: "Back to results"');
    expect(CONFIG_UI_JS).toContain('text: "Add to queue"');
    expect(CONFIG_UI_JS).toContain("scheduleInventoryPreview(0)");
    expect(CONFIG_UI_JS).toContain("if (state.inventoryPreviewInFlight)");
    expect(CONFIG_UI_JS).toContain("scheduleInventoryPreview(delay = 350)");
    expect(CONFIG_UI_JS).toContain(
      'document.querySelector("#catalog-results").hidden = true',
    );
    expect(CONFIG_UI_JS).not.toContain(
      "message.textContent = products.length +",
    );
    expect(CONFIG_UI_JS).toContain(
      'text: isAddress ? "Print test label" : "Print test sheet"',
    );
    expect(CONFIG_UI_JS).toContain('"/api/print-tests/"');
    expect(CONFIG_UI_JS).toContain(
      "Synthetic data only. This sends a real print job.",
    );
  });

  it("prints synthetic output with the current unsaved printer settings", async () => {
    const fixture = await configurationFixture();
    const initial = await fixture.service.read();
    const originalFile = await readFile(fixture.path, "utf8");
    const executePrintTest = vi.fn<
      (config: AppConfig, actionId: string) => Promise<void>
    >(() => Promise.resolve());
    const address = initial.outputs.find(
      (output) => output.type === "print-address-label",
    );
    if (address === undefined) throw new Error("Address output is missing.");
    const outputs = initial.outputs.map((output) =>
      output.actionId === address.actionId
        ? {
            ...output,
            enabled: false,
            printerName: "Synthetic Label Printer",
            marginMm: 1,
            fontSize: 16,
          }
        : output,
    );
    server = await startConfigurationUi({
      configPath: fixture.path,
      port: 0,
      service: fixture.service,
      executePrintTest,
    });

    const response = await fetch(
      `${server.url}/api/print-tests/${address.actionId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.url,
        },
        body: JSON.stringify({ ...initial, outputs }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      printed: true,
      actionId: address.actionId,
      synthetic: true,
    });
    expect(executePrintTest).toHaveBeenCalledOnce();
    expect(executePrintTest.mock.calls[0]?.[1]).toBe(address.actionId);
    expect(executePrintTest.mock.calls[0]?.[0]).toMatchObject({
      actions: {
        [address.actionId]: {
          enabled: false,
          page: { marginMm: 1, fontSize: 16 },
        },
      },
      printers: {
        [address.printerId]: {
          printerName: "Synthetic Label Printer",
        },
      },
    });
    expect(await readFile(fixture.path, "utf8")).toBe(originalFile);
  });

  it("organizes the workspace into accessible persistent tabs", () => {
    const ids = [...CONFIG_UI_HTML.matchAll(/\sid="([^"]+)"/gu)].map(
      (match) => match[1],
    );

    expect(CONFIG_UI_HTML.match(/\srole="tab"/gu)).toHaveLength(4);
    expect(CONFIG_UI_HTML.match(/\srole="tabpanel"/gu)).toHaveLength(4);
    expect(CONFIG_UI_HTML).not.toContain('<header class="hero">');
    expect(CONFIG_UI_HTML).not.toContain('class="status-strip"');
    expect(CONFIG_UI_HTML).not.toContain('id="connection"');
    expect(CONFIG_UI_HTML).not.toContain('id="dry-run-status"');
    expect(CONFIG_UI_HTML.indexOf('role="tablist"')).toBeLessThan(
      CONFIG_UI_HTML.indexOf('role="tabpanel"'),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(CONFIG_UI_HTML).toContain(
      'id="panel-settings" class="tab-panel" role="tabpanel"',
    );
    expect(CONFIG_UI_HTML).toContain(
      'id="panel-add-cards" class="tab-panel" role="tabpanel" aria-labelledby="tab-add-cards" tabindex="0" data-panel="add-cards" hidden',
    );
    expect(CONFIG_UI_JS).toContain("tcgplayer-alert.active-tab");
    expect(CONFIG_UI_JS).toContain('value === "automation" ? "settings"');
    expect(CONFIG_UI_JS).not.toContain("#queue-health");
    expect(CONFIG_UI_JS).not.toContain("#inventory-queue-health");
    expect(CONFIG_UI_JS).toContain('event.key === "ArrowRight"');
    expect(CONFIG_UI_JS).toContain('window.addEventListener("popstate"');
  });

  it("keeps persistent configuration in Settings and job pages focused", () => {
    const settingsPanel = CONFIG_UI_HTML.slice(
      CONFIG_UI_HTML.indexOf('id="panel-settings"'),
      CONFIG_UI_HTML.indexOf('id="panel-add-cards"'),
    );
    const jobsPanel = CONFIG_UI_HTML.slice(
      CONFIG_UI_HTML.indexOf('id="panel-jobs"'),
      CONFIG_UI_HTML.indexOf('id="save-bar"'),
    );
    const persistentControlIds = [
      "poll-interval",
      "dry-run",
      "inventory-queue-enabled",
      "inventory-delay",
      "price-queue-enabled",
      "price-delay",
      "outputs",
    ];

    for (const id of persistentControlIds) {
      expect(settingsPanel).toContain(`id="${id}"`);
      expect(jobsPanel).not.toContain(`id="${id}"`);
    }
    expect(jobsPanel).toContain('id="inventory-queue-jobs"');
    expect(jobsPanel).toContain('id="queue-jobs"');
  });

  it("shows the save banner only for unsaved persistent settings", () => {
    expect(CONFIG_UI_HTML).toContain('id="save-bar" class="save-bar" hidden');
    expect(CONFIG_UI_JS).toContain("savedSettingsFingerprint");
    expect(CONFIG_UI_JS).toContain(
      "settingsFingerprint() !== state.savedSettingsFingerprint",
    );
    expect(CONFIG_UI_JS).toContain(
      'form.addEventListener("input", updateSaveBarVisibility)',
    );
    expect(CONFIG_UI_JS).toContain(
      'form.addEventListener("change", updateSaveBarVisibility)',
    );
    expect(CONFIG_UI_JS).not.toContain(
      'saveBar.hidden = selectedTab !== "settings"',
    );
  });

  it("serves the browser UI on loopback and accepts same-origin updates only", async () => {
    const fixture = await configurationFixture();
    const priceQueue = new PriceUpdateQueueStore({
      stateFile: join(dirname(fixture.path), "price-updates.json"),
      historyLimit: 25,
      lease: immediateSyncLease,
    });
    const inventoryQueue = new InventoryAdditionQueueStore({
      stateFile: join(dirname(fixture.path), "inventory-additions.json"),
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
    const catalogSummary = {
      productId: 123,
      imageUrl: "https://product-images.tcgplayer.com/fit-in/200x279/123.jpg",
      productName: "Synthetic Card",
      productLineName: "Synthetic Game",
      setName: "Synthetic Set",
      rarityName: "Rare",
      cardNumber: "42",
      marketPrice: 3.5,
      sellerListable: false,
    } as const;
    const catalogProduct = {
      ...catalogSummary,
      sellerListable: true,
      skus: [
        {
          productConditionId: 455,
          conditionId: 1,
          condition: "Near Mint",
          printing: "Normal",
          language: "Japanese",
        },
        {
          productConditionId: 456,
          conditionId: 1,
          condition: "Near Mint",
          printing: "Normal",
          language: "English",
        },
        {
          productConditionId: 457,
          conditionId: 1,
          condition: "Near Mint",
          printing: "Holofoil",
          language: "English",
        },
        {
          productConditionId: 458,
          conditionId: 2,
          condition: "Lightly Played",
          printing: "Normal",
          language: "Spanish",
        },
      ],
    } as const;
    const inventoryService = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({ totalProducts: 1, products: [catalogSummary] }),
        getCatalogProduct: () => Promise.resolve(catalogProduct),
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
      inventoryQueue,
      inventoryWorkerRunning: true,
      inventoryService,
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
    const catalogSearch = await fetch(
      `${server.url}/api/catalog/search?q=Synthetic`,
    );
    const invalidCatalogOffset = await fetch(
      `${server.url}/api/catalog/search?q=Synthetic&offset=-1`,
    );
    const catalogDetails = await fetch(
      `${server.url}/api/catalog/products/123`,
    );
    const inventoryPreviewResponse = await fetch(
      `${server.url}/api/inventory-additions/preview`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.url,
        },
        body: JSON.stringify({
          productId: 123,
          productConditionId: 456,
          addQuantity: 2,
          rules: {
            minimumPrice: 0.35,
            conditionPolicy: "same-or-better",
            priceBasis: "item",
            adjustmentCents: 0,
            estimatedShippingPrice: 0,
            noComparisonFallback: "market",
          },
        }),
      },
    );
    const inventoryPreview = (await inventoryPreviewResponse.json()) as {
      id: string;
      proposedPrice: number;
    };
    const queuedInventory = await fetch(
      `${server.url}/api/inventory-additions/previews/${inventoryPreview.id}/queue`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.url,
        },
        body: "{}",
      },
    );
    const inventoryStatus = await fetch(
      `${server.url}/api/inventory-additions`,
    );

    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).not.toContain("Seller workspace");
    expect(pageText).toContain('role="tablist"');
    expect(pageText).toContain("Add cards");
    expect(pageText).toContain('id="inventory-card-condition"');
    expect(pageText).toContain('id="inventory-printing"');
    expect(pageText).toContain('id="inventory-language"');
    expect(repricingPreview.status).toBe(200);
    expect(await repricingPreview.json()).toMatchObject({
      counts: { ready: 0, unchanged: 0, skipped: 0 },
      rows: [],
    });
    expect(settings.status).toBe(200);
    expect(catalogSearch.status).toBe(200);
    expect(await catalogSearch.json()).toMatchObject({
      totalProducts: 1,
      nextOffset: 1,
      hasMore: false,
      products: [{ productId: 123, matchKind: "variant" }],
    });
    expect(invalidCatalogOffset.status).toBe(400);
    expect(catalogDetails.status).toBe(200);
    expect(await catalogDetails.json()).toMatchObject({ productId: 123 });
    expect(inventoryPreviewResponse.status).toBe(200);
    expect(inventoryPreview.proposedPrice).toBe(3.5);
    expect(queuedInventory.status).toBe(202);
    expect(inventoryStatus.status).toBe(200);
    expect(await inventoryStatus.json()).toMatchObject({
      workerRunning: true,
      counts: { pending: 1 },
    });
    expect(forbidden.status).toBe(403);
    expect(queued.status).toBe(202);
    expect(await queueStatus.json()).toMatchObject({
      workerRunning: true,
      counts: { pending: 1 },
    });
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "img-src 'self' https://product-images.tcgplayer.com",
    );
  });
});
