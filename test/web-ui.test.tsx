// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import type { Settings } from "../src/web/contracts.js";

const settings: Settings = {
  revision: "synthetic-revision",
  pollIntervalMinutes: 5,
  confirmBeforeMarkingShipped: true,
  priceUpdateQueue: { enabled: true, delaySeconds: 0 },
  inventoryAdditionQueue: { enabled: true, delaySeconds: 0 },
  merchandiseProfiles: [
    {
      id: "english-singles",
      name: "English singles",
      language: "English",
      estimatedShippingPrice: 1.49,
      defaultCondition: "Near Mint",
      defaultPrinting: "Normal",
      pricingProfileId: "match-lowest",
    },
  ],
  defaultMerchandiseProfileId: "english-singles",
  repricingProfiles: [
    {
      id: "match-lowest",
      name: "Conservative",
      minimumPrice: 0.25,
      conditionPolicy: "same-or-better",
      priceBasis: "delivered",
      adjustmentCents: 0,
      allowPriceIncreases: true,
      sparseMarketFallback: "higher-of-market-and-lowest",
      gamePricingModules: [],
      ranges: [
        {
          minimumListings: 2,
          priceSource: "lowest",
          percentage: 100,
          gapThresholdPercent: 10,
          gapAction: "use-next",
          supportMode: "cluster",
          minimumSellerSupport: 2,
          supportWindowPercent: 5,
        },
      ],
    },
  ],
  defaultRepricingProfileId: "match-lowest",
  outputs: [
    {
      actionId: "address-label",
      type: "print-address-label",
      enabled: true,
      printerId: "label",
      printerName: "Synthetic Label Printer",
      adapter: "windows-native-label",
      adapterLabel: "Windows label",
      widthMm: 89,
      heightMm: 28,
      marginMm: 3,
      fontSize: 14,
    },
    {
      actionId: "packing-slip",
      type: "print-packing-slip",
      enabled: true,
      printerId: "office",
      printerName: "Synthetic Office Printer",
      adapter: "windows-pdf",
      adapterLabel: "Windows PDF",
      dpi: 200,
      scale: "fit",
    },
  ],
  installedPrinters: [
    { name: "Synthetic Label Printer", isDefault: false },
    { name: "Synthetic Office Printer", isDefault: true },
  ],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function baseFetch(
  input: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  const path = requestPath(input);
  if (path === "/api/settings" && options?.method === "PUT") {
    if (typeof options.body !== "string")
      throw new Error("Expected a JSON request body.");
    const submitted = JSON.parse(options.body) as Settings;
    return Promise.resolve(
      json({ ...settings, ...submitted, revision: "saved-revision" }),
    );
  }
  if (path === "/api/settings") return Promise.resolve(json(settings));
  if (path.startsWith("/api/orders"))
    return Promise.resolve(
      json({ orders: [], fetchedAt: "2026-08-07T12:00:00.000Z" }),
    );
  if (path.startsWith("/api/payments"))
    return Promise.resolve(
      json({
        experience: "money-movement",
        totalPayouts: 0,
        page: 1,
        pageSize: 25,
        payouts: [],
        unpaidBalance: { totalBalance: 0, transactions: [] },
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  if (path.startsWith("/api/feedback"))
    return Promise.resolve(
      json({
        page: 1,
        pageSize: 25,
        totalPages: 1,
        totalFeedback: 0,
        feedback: [],
        aggregation: {
          totalRatings: 0,
          fiveStar: 0,
          fourStar: 0,
          threeStar: 0,
          twoStar: 0,
          oneStar: 0,
          arrivedWhenExpected: { positive: 0, negative: 0, unanswered: 0 },
          asDescribed: { positive: 0, negative: 0, unanswered: 0 },
          goodCommunication: { positive: 0, negative: 0, unanswered: 0 },
          totalAdditionalRatings: 0,
        },
        storefrontUrl:
          "https://store.tcgplayer.com/sellerfeedback/synthetic-seller",
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  throw new Error(`Unexpected request: ${path}`);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.location.hash = "";
});

describe("operator console", () => {
  it("updates an open dashboard from the local synchronized snapshot", async () => {
    let readyReads = 0;
    let snapshotTick: (() => void) | undefined;
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(
      (handler, timeout): NodeJS.Timeout => {
        if (timeout === 5_000 && typeof handler === "function") {
          snapshotTick = handler;
          return realSetInterval(
            () => undefined,
            60_000,
          ) as unknown as NodeJS.Timeout;
        }
        return realSetInterval(handler, timeout) as unknown as NodeJS.Timeout;
      },
    );
    const synchronizedOrder = {
      orderNumber: "SYNTHETIC-SCHEDULED",
      buyerName: "Synthetic Buyer",
      orderDate: "2026-08-07T12:00:00.000Z",
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      shippingType: "Standard",
      productAmount: 10,
      shippingAmount: 1.49,
      totalAmount: 11.49,
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders?status=ready-to-ship") {
          readyReads += 1;
          return Promise.resolve(
            json({
              orders: readyReads === 1 ? [] : [synchronizedOrder],
              fetchedAt: `2026-08-07T12:0${String(readyReads)}:00.000Z`,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText("No orders are ready to ship")).toBeTruthy();
    await waitFor(() => expect(snapshotTick).toBeDefined());
    await act(async () => {
      snapshotTick?.();
      await Promise.resolve();
    });

    expect(await screen.findByText("SYNTHETIC-SCHEDULED")).toBeTruthy();
    expect(readyReads).toBe(2);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestPath(input).includes("refresh=1"),
      ),
    ).toBe(false);
  });

  it("keeps the dashboard ready queue separate from the all-orders view", async () => {
    window.location.hash = "orders";
    const allOnlyOrder = {
      orderNumber: "SYNTHETIC-ALL-ONLY",
      buyerName: "Synthetic Buyer",
      orderDate: "2026-08-07T12:00:00.000Z",
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      shippingType: "Standard",
      productAmount: 10,
      shippingAmount: 1.49,
      totalAmount: 11.49,
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders?") {
          return Promise.resolve(
            json({
              orders: [allOnlyOrder],
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        if (path === "/api/orders?status=ready-to-ship") {
          return Promise.resolve(
            json({
              orders: [],
              fetchedAt: "2026-08-07T12:01:00.000Z",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("SYNTHETIC-ALL-ONLY")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Dashboard" }));

    expect(await screen.findByText("No orders are ready to ship")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/orders?status=ready-to-ship",
      ),
    ).toBe(true);
  });

  it("prints a pasted address from the dashboard", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        if (
          requestPath(input) === "/api/address-labels/print" &&
          options?.method === "POST"
        ) {
          return Promise.resolve(json({ printed: true }));
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const address = await screen.findByRole("textbox", {
      name: "Paste address",
    });
    await user.type(
      address,
      "Synthetic Recipient{enter}123 Example Street{enter}Example City, IL 00000",
    );
    await user.click(screen.getByRole("button", { name: "Print label" }));

    const request = fetchMock.mock.calls.find(
      ([input]) => requestPath(input) === "/api/address-labels/print",
    );
    expect(request?.[1]).toMatchObject({ method: "POST" });
    const body = request?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected the address to be submitted as JSON.");
    }
    expect(JSON.parse(body) as unknown).toEqual({
      address:
        "Synthetic Recipient\n123 Example Street\nExample City, IL 00000",
    });
    expect(
      await screen.findByText("Address label sent to the printer."),
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved configuration changes")).toBeNull();
  });

  it("navigates all work areas and only offers Save after a persistent change", async () => {
    const fetchMock = vi.fn(baseFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeTruthy();
    expect(screen.queryByText("TCGplayer seller operations")).toBeNull();
    expect(screen.queryByText("Local only")).toBeNull();
    expect(
      [
        ...screen
          .getByRole("navigation", { name: "Primary navigation" })
          .querySelectorAll("a"),
      ].map((link) => link.textContent.trim()),
    ).toEqual([
      "Dashboard",
      "Add cards",
      "Orders",
      "Payments",
      "Feedback",
      "Inventory",
      "Settings",
      "Jobs",
    ]);
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved configuration changes")).toBeNull();
    const shipmentConfirmation = screen.getByRole("checkbox", {
      name: /Confirm before marking shipped/u,
    });
    expect((shipmentConfirmation as HTMLInputElement).checked).toBe(true);
    await user.click(shipmentConfirmation);
    const interval = screen.getByRole("spinbutton");
    await user.clear(interval);
    await user.type(interval, "17");
    expect(screen.getByText("Unsaved configuration changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(screen.queryByText("Unsaved configuration changes")).toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ method: "PUT" }),
    );
    const settingsSave = fetchMock.mock.calls.find(
      ([input, options]) =>
        requestPath(input) === "/api/settings" && options?.method === "PUT",
    );
    expect(settingsSave).toBeDefined();
    const settingsBody = settingsSave?.[1]?.body;
    if (typeof settingsBody !== "string") {
      throw new Error("Expected settings to be submitted as JSON.");
    }
    expect(JSON.parse(settingsBody) as Record<string, unknown>).toMatchObject({
      confirmBeforeMarkingShipped: false,
    });
  });

  it("marks an order shipped immediately when confirmation is disabled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/settings") {
          return Promise.resolve(
            json({ ...settings, confirmBeforeMarkingShipped: false }),
          );
        }
        if (
          path === "/api/orders/SYNTHETIC-ORDER-1/mark-shipped" &&
          options?.method === "POST"
        ) {
          return Promise.resolve(
            json({ orderNumber: "SYNTHETIC-ORDER-1", outcome: "applied" }),
          );
        }
        if (path.startsWith("/api/orders?")) {
          return Promise.resolve(
            json({
              orders: [
                {
                  orderNumber: "SYNTHETIC-ORDER-1",
                  buyerName: "Synthetic Buyer",
                  orderDate: "2026-08-07T12:00:00.000Z",
                  status: "Ready to Ship",
                  statusCode: "ReadyToShip",
                  canMarkShipped: true,
                  shippingType: "Standard",
                  productAmount: 10,
                  shippingAmount: 1.49,
                  totalAmount: 11.49,
                },
              ],
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Mark shipped" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/orders/SYNTHETIC-ORDER-1/mark-shipped",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          requestPath(input).startsWith("/api/orders?"),
        ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByText("SYNTHETIC-ORDER-1")).toBeNull(),
    );
  });

  it("adds an exact catalog SKU directly from the search row", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/catalog/search"))
          return Promise.resolve(
            json({
              totalProducts: 1,
              productLines: [{ name: "Magic: The Gathering", count: 1 }],
              sets: [{ name: "Synthetic Set", count: 1 }],
              products: [
                {
                  productId: 123,
                  imageUrl: "https://product-images.tcgplayer.com/123.jpg",
                  productName: "Synthetic Card",
                  productLineName: "Magic: The Gathering",
                  setName: "Synthetic Set",
                  rarityName: "Rare",
                  cardNumber: "42",
                  marketPrice: 3.5,
                  foilMarketPrice: 8.25,
                  sellerListable: true,
                  matchKind: "exact",
                  matchRank: [0],
                },
              ],
              nextOffset: 1,
              hasMore: false,
            }),
          );
        if (path === "/api/catalog/products/123")
          return Promise.resolve(
            json({
              productId: 123,
              imageUrl: "https://product-images.tcgplayer.com/123.jpg",
              productName: "Synthetic Card",
              productLineName: "Magic: The Gathering",
              setName: "Synthetic Set",
              rarityName: "Rare",
              cardNumber: "42",
              marketPrice: 3.5,
              foilMarketPrice: 8.25,
              sellerListable: true,
              skus: [
                {
                  productConditionId: 456,
                  conditionId: 1,
                  condition: "Near Mint",
                  printing: "Normal",
                  language: "English",
                },
              ],
            }),
          );
        if (path === "/api/inventory-additions/preview")
          return Promise.resolve(
            json({
              id: "00000000-0000-4000-8000-000000000001",
              proposedPrice: 3.49,
              queueable: true,
              reason: "Uses the marketplace reference.",
            }),
          );
        if (path.includes("/api/inventory-additions/previews/"))
          return Promise.resolve(json({ jobs: [{ id: "job" }] }, 202));
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Synthetic Card")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "+1" }));
    expect((await screen.findAllByText("Queued +1 at $3.49.")).length).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/inventory-additions/preview",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports inventory loading progress and filters to proposed changes", async () => {
    let emitPreviewEvent:
      | ((value: unknown, options?: { readonly close?: boolean }) => void)
      | undefined;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/repricing/preview" && options?.method === "POST") {
          const encoder = new TextEncoder();
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  emitPreviewEvent = (value, eventOptions) => {
                    controller.enqueue(
                      encoder.encode(`${JSON.stringify(value)}\n`),
                    );
                    if (eventOptions?.close === true) controller.close();
                  };
                },
              }),
              {
                headers: {
                  "Content-Type": "application/x-ndjson; charset=utf-8",
                },
              },
            ),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Inventory" }));

    await user.click(screen.getByRole("button", { name: "Update preview" }));

    expect(
      screen.getByRole("progressbar", { name: "Building inventory preview" }),
    ).toBeTruthy();
    if (emitPreviewEvent === undefined) {
      throw new Error("Expected the inventory preview request to start.");
    }
    emitPreviewEvent({
      type: "progress",
      progress: {
        phase: "inventory",
        completed: 200,
        total: 400,
        unit: "products",
        detail: "Loading seller inventory",
      },
    });
    expect(await screen.findByText("200 / 400 products")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Building inventory preview" })
        .getAttribute("aria-valuenow"),
    ).toBe("200");
    emitPreviewEvent(
      {
        type: "complete",
        preview: {
          id: "00000000-0000-4000-8000-000000000002",
          createdAt: "2026-08-07T12:00:00.000Z",
          expiresAt: "2026-08-07T12:15:00.000Z",
          rules: settings.repricingProfiles[0],
          rows: [
            {
              id: "change-row",
              productId: 1,
              productConditionId: 11,
              productName: "Price Change Card",
              productLineName: "Magic: The Gathering",
              setName: "Synthetic Set",
              condition: "Near Mint",
              printing: "Normal",
              language: "English",
              quantity: 1,
              currentPrice: 2,
              currentShipping: 1.49,
              proposedPrice: 1.75,
              marketPrice: 2,
              minimumApplied: false,
              status: "ready",
              reason: "Uses the marketplace reference.",
              queueable: true,
              removable: true,
            },
            {
              id: "stable-row",
              productId: 2,
              productConditionId: 22,
              productName: "Stable Card",
              productLineName: "Magic: The Gathering",
              setName: "Synthetic Set",
              condition: "Near Mint",
              printing: "Normal",
              language: "English",
              quantity: 2,
              currentPrice: 3,
              currentShipping: 1.49,
              proposedPrice: 3,
              marketPrice: 3,
              minimumApplied: false,
              status: "unchanged",
              reason: "The current price already matches.",
              queueable: false,
              removable: true,
            },
          ],
          counts: { ready: 1, unchanged: 1, skipped: 0 },
          totals: {
            listingCount: 2,
            totalQuantity: 3,
            currentListingValue: 8,
          },
          marketplaceSnapshot: {
            capturedAt: "2026-08-07T12:00:00.000Z",
            expiresAt: "2026-08-07T12:10:00.000Z",
            source: "fresh",
          },
        },
      },
      { close: true },
    );

    expect(await screen.findByText("Price Change Card")).toBeTruthy();
    expect(screen.getByText("Stable Card")).toBeTruthy();
    const table = screen.getByRole("table");
    const changedRow = screen.getByText("Price Change Card").closest("tr");
    if (changedRow === null) throw new Error("Missing changed inventory row.");
    expect(changedRow.classList.contains("is-large-price-change")).toBe(true);
    expect(within(changedRow).getByText("-$0.25")).toBeTruthy();
    expect(within(changedRow).getByText("-12.5%")).toBeTruthy();
    expect(
      within(changedRow)
        .getByText("$1.75")
        .classList.contains("price-change--decrease"),
    ).toBe(true);
    const inventoryOrder = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) =>
          row.textContent.includes("Price Change Card") ? "changed" : "stable",
        );
    await user.click(
      screen.getByRole("button", { name: "Sort by price change" }),
    );
    expect(inventoryOrder()).toEqual(["stable", "changed"]);
    await user.click(
      screen.getByRole("button", {
        name: "Sort by price change, currently descending",
      }),
    );
    expect(inventoryOrder()).toEqual(["changed", "stable"]);
    await user.click(
      screen.getByRole("button", { name: "Proposed changes (1)" }),
    );
    expect(screen.getByText("Price Change Card")).toBeTruthy();
    expect(screen.queryByText("Stable Card")).toBeNull();
    expect(screen.getByText("1 of 2 listings")).toBeTruthy();
  });

  it("shows read-only payout history and loads transaction details", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/payments/SYNTHETIC-PAYOUT-1")
          return Promise.resolve(
            json({
              payoutId: "synthetic-payout",
              referenceId: "SYNTHETIC-PAYOUT-1",
              createdAt: "2026-08-01T12:00:00.000Z",
              lastSentAt: "2026-08-04T12:00:00.000Z",
              amount: 12_345,
              status: "Succeeded",
              totalSales: 13_000,
              totalRefunds: 0,
              totalFees: -655,
              totalAdjustments: 0,
              transactions: [
                {
                  createdAt: "2026-08-01T12:00:00.000Z",
                  type: "SettleOrder",
                  orderNumber: "SYNTHETIC-ORDER-1",
                  amount: 13_000,
                  feeAmount: -655,
                  netAmount: 12_345,
                },
              ],
            }),
          );
        if (path === "/api/payments?page=1")
          return Promise.resolve(
            json({
              experience: "money-movement",
              totalPayouts: 1,
              page: 1,
              pageSize: 25,
              payouts: [
                {
                  payoutId: "synthetic-payout",
                  referenceId: "SYNTHETIC-PAYOUT-1",
                  createdAt: "2026-08-01T12:00:00.000Z",
                  lastSentAt: "2026-08-04T12:00:00.000Z",
                  amount: 12_345,
                  ordersCount: 3,
                  status: "Succeeded",
                },
              ],
              unpaidBalance: {
                totalBalance: 2_500,
                transactions: [
                  {
                    createdAt: "2026-08-07T11:30:00.000Z",
                    type: "SettleOrder",
                    orderNumber: "SYNTHETIC-UPCOMING-1",
                    amount: 3_000,
                    feeAmount: -500,
                    netAmount: 2_500,
                  },
                ],
              },
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });

    await user.click(screen.getByRole("link", { name: "Payments" }));

    expect(
      await screen.findByRole("heading", { name: "Payments" }),
    ).toBeTruthy();
    expect(screen.getByText("$25.00")).toBeTruthy();
    expect(screen.getAllByText("$123.45").length).toBeGreaterThan(0);
    await user.click(
      screen.getByRole("button", {
        name: "View upcoming payment transactions",
      }),
    );
    expect(screen.getByText("Upcoming payments")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "SYNTHETIC-UPCOMING-1" }),
    ).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText("Transaction type"),
      "ApplyRefund",
    );
    expect(screen.getByText("No matching transactions")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Transaction type"), "All");
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestPath(input).startsWith("/api/payments"),
      ),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("Payout SYNTHETIC-PAYOUT-1")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "SYNTHETIC-ORDER-1" }),
    ).toBeTruthy();
    expect(screen.queryByText(/bank|payment account/iu)).toBeNull();
    expect(
      fetchMock.mock.calls
        .filter(([input]) => requestPath(input).startsWith("/api/payments"))
        .every(([, options]) => options?.method === undefined),
    ).toBe(true);
  });

  it("shows the legacy estimated future payments and past payment history", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/payments?page=")) {
          const page = Number(
            new URL(path, "http://localhost").searchParams.get("page"),
          );
          return Promise.resolve(
            json({
              experience: "legacy",
              page,
              totalPages: 2,
              upcomingPayments: [
                {
                  estimatedArrivalDate: "2026-08-15",
                  initiatedDate: "2026-08-13",
                  ordersCount: 2,
                  totalSales: 6_000,
                  totalFees: 300,
                  refundedOrders: 0,
                  refundedFees: 0,
                  adjustments: 0,
                  amount: 5_700,
                },
              ],
              pastPayments: [
                {
                  estimatedArrivalDate: "2026-08-12",
                  initiatedDate: "2026-08-10",
                  ordersCount: 4,
                  totalSales: 13_000,
                  totalFees: 655,
                  refundedOrders: 0,
                  refundedFees: 0,
                  adjustments: 0,
                  amount: 12_345,
                },
              ],
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });

    await user.click(screen.getByRole("link", { name: "Payments" }));

    expect(await screen.findByText("Estimated future payments")).toBeTruthy();
    expect(screen.getByText("Past payment history")).toBeTruthy();
    expect(screen.getAllByText("$57.00").length).toBeGreaterThan(0);
    expect(screen.getByText("$123.45")).toBeTruthy();
    expect(screen.queryByLabelText("Payout status")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open Seller Portal" })
        .getAttribute("href"),
    ).toBe("https://store.tcgplayer.com/admin/payment/sellerpayment");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText("Page 2 of 2", {
        selector: ".payment-pagination span",
      }),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/payments?page=2",
      ),
    ).toBe(true);
  });

  it("shows filtered read-only feedback without exposing raw buyer nicknames", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/feedback?")) {
          return Promise.resolve(
            json({
              page: 1,
              pageSize: 25,
              totalPages: 1,
              totalFeedback: 1,
              feedback: [
                {
                  rating: 5,
                  comment: "Synthetic feedback comment.",
                  buyerDisplayName: "Synthetic B*",
                  createdAt: "2026-08-07T12:00:00.000Z",
                  active: true,
                  arrivedWhenExpected: true,
                  asDescribed: true,
                  goodCommunication: false,
                },
              ],
              aggregation: {
                totalRatings: 10,
                fiveStar: 8,
                fourStar: 1,
                threeStar: 0,
                twoStar: 0,
                oneStar: 1,
                arrivedWhenExpected: {
                  positive: 9,
                  negative: 1,
                  unanswered: 0,
                },
                asDescribed: { positive: 9, negative: 1, unanswered: 0 },
                goodCommunication: {
                  positive: 8,
                  negative: 1,
                  unanswered: 1,
                },
                totalAdditionalRatings: 28,
              },
              storefrontUrl:
                "https://store.tcgplayer.com/sellerfeedback/synthetic-seller",
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });

    await user.click(screen.getByRole("link", { name: "Feedback" }));

    expect(
      await screen.findByRole("heading", { name: "Feedback" }),
    ).toBeTruthy();
    expect(screen.getByText("Synthetic feedback comment.")).toBeTruthy();
    expect(screen.getByText("Synthetic B*")).toBeTruthy();
    expect(screen.queryByText("Synthetic Buyer")).toBeNull();
    expect(screen.getByLabelText("5 out of 5 stars")).toBeTruthy();
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open TCGplayer" }).getAttribute("href"),
    ).toBe("https://store.tcgplayer.com/sellerfeedback/synthetic-seller");

    await user.selectOptions(screen.getByLabelText("Rating"), "1");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) => requestPath(input) === "/api/feedback?page=1&rating=1",
        ),
      ).toBe(true),
    );
  });
});
