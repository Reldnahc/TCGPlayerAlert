import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationService,
  loadConfig,
  startConfigurationUi,
  type AppConfig,
  type ConfigurationUiServer,
  type FeedbackManagementService,
  type PaymentManagementService,
  type RepricingService,
} from "../src/index.js";

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
      priceUpdateQueue: { enabled: true, delaySeconds: 0 },
      inventoryAdditionQueue: { enabled: true, delaySeconds: 0 },
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

    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
    expect(html).toContain('<div id="app"></div>');
    expect(html).not.toContain("Seller workspace");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("text/javascript");
    expect((await asset.text()).length).toBeGreaterThan(1_000);
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
