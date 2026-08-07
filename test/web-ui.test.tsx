// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import type { Settings } from "../src/web/contracts.js";

const settings: Settings = {
  revision: "synthetic-revision",
  pollIntervalMinutes: 5,
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
        totalPayouts: 0,
        page: 1,
        pageSize: 25,
        payouts: [],
        unpaidBalance: { totalBalance: 0, transactions: [] },
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
  it("navigates all work areas and only offers Save after a persistent change", async () => {
    const fetchMock = vi.fn(baseFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved configuration changes")).toBeNull();
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
});
