// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import { copyTextToClipboard } from "../src/web/components/OrderActions.js";
import {
  marketplaceOrder,
  marketplaceOrderDetail,
} from "./marketplace-ui-fixtures.js";
import {
  baseFetch,
  json,
  requestPath,
  settings,
  resetWebUiTest,
} from "./web-ui-fixtures.js";

afterEach(resetWebUiTest);

describe("order workspaces", () => {
  it("copies Pirate Ship addresses without a manual-copy dialog when clipboard permission expires", async () => {
    const executeCopy = vi.fn(() => true);
    const prompt = vi.spyOn(window, "prompt");

    await copyTextToClipboard("Synthetic Buyer\n123 Example Street", {
      clipboard: {
        writeText: () => Promise.reject(new Error("permission expired")),
      },
      document,
      executeCopy,
    });

    expect(executeCopy).toHaveBeenCalledWith("copy");
    expect(prompt).not.toHaveBeenCalled();
    expect(document.querySelector("textarea[aria-hidden='true']")).toBeNull();
  });

  it("requires tracking for a $50 order and opens its internal workspace", async () => {
    window.location.hash = "orders";
    const order = {
      ...marketplaceOrder({
        remoteId: "SYNTHETIC-ORDER-DETAIL",
        subtotalMinorUnits: 4_851,
        shippingMinorUnits: 149,
        totalMinorUnits: 5_000,
      }),
      orderNumber: "SYNTHETIC-ORDER-DETAIL",
      buyerName: "Synthetic Buyer",
      orderDate: "2026-08-07T12:00:00.000Z",
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      shippingType: "Standard",
      productAmount: 48.51,
      shippingAmount: 1.49,
      totalAmount: 50,
    };
    const detail = {
      ...marketplaceOrderDetail({
        remoteId: "SYNTHETIC-ORDER-DETAIL",
        subtotalMinorUnits: 4_851,
        shippingMinorUnits: 149,
        totalMinorUnits: 5_000,
        description: "Synthetic Card Â· Test Set Â· Near Mint",
      }),
      createdAt: order.orderDate,
      status: order.status,
      statusCode: order.statusCode,
      orderChannel: "Marketplace",
      orderFulfillment: "Seller",
      orderNumber: order.orderNumber,
      sellerName: "Synthetic Seller",
      buyerName: "Third Provider Buyer",
      paymentType: "Credit card",
      pickupStatus: "Not requested",
      shippingType: order.shippingType,
      estimatedDeliveryDate: "2026-08-12T12:00:00.000Z",
      transaction: {
        productAmount: 48.51,
        shippingAmount: 1.49,
        grossAmount: 50,
        feeAmount: 1.5,
        netAmount: 48.5,
        directFeeAmount: 0,
        taxes: [],
      },
      shippingAddress: {
        recipientName: "Synthetic Buyer",
        addressOne: "125 Example Avenue",
        addressTwo: "Unit 4",
        city: "Test City",
        territory: "IL",
        country: "US",
        postalCode: "60000",
      },
      products: [
        {
          name: "Synthetic Card · Test Set · Near Mint",
          unitPrice: 24.255,
          extendedPrice: 48.51,
          quantity: 2,
          url: "https://www.tcgplayer.com/",
          productId: "123",
          skuId: "456",
          listoId: 789,
        },
      ],
      trackingNumbers: [],
      canMarkShipped: true,
      fetchedAt: "2026-08-07T12:01:00.000Z",
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        const detailPath = `/api/connections/tcgplayer-main/orders/${order.orderNumber}`;
        if (path.startsWith(`${detailPath}?`)) {
          return Promise.resolve(json(detail));
        }
        if (path === detailPath) {
          return Promise.resolve(json(detail));
        }
        if (path === "/api/settings") {
          return Promise.resolve(
            json({ ...settings, confirmBeforeMarkingShipped: false }),
          );
        }
        if (path === "/api/orders?") {
          return Promise.resolve(
            json({
              data: [order],
              issues: [],
              completedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("link", {
      name: order.orderNumber,
    });
    await user.click(screen.getByRole("button", { name: "Mark shipped" }));
    expect(
      await screen.findByRole("textbox", {
        name: `Tracking number for order ${order.orderNumber}`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Add tracking before marking an order of $50 or more shipped.",
      ),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestPath(input).endsWith("/mark-shipped"),
      ),
    ).toBe(false);

    await user.click(
      screen.getByRole("link", {
        name: order.orderNumber,
      }),
    );

    await screen.findByRole("heading", {
      name: `Order ${order.orderNumber}`,
    });
    await screen.findByText("No tracking has been added");
    const detailCommandBar = document.querySelector(
      ".order-detail-command-bar",
    );
    if (!(detailCommandBar instanceof HTMLElement)) {
      throw new Error("Expected the order detail command bar.");
    }
    const detailMarkShipped = within(detailCommandBar).getByRole("button", {
      name: "Mark shipped",
    });
    expect(detailMarkShipped.hasAttribute("disabled")).toBe(true);
    expect(detailMarkShipped.getAttribute("title")).toBe(
      "Add tracking before marking an order of $50 or more shipped.",
    );

    expect(
      await screen.findByRole("heading", {
        name: `Order ${order.orderNumber}`,
      }),
    ).toBeTruthy();
    expect(await screen.findByText("125 Example Avenue")).toBeTruthy();
    expect(
      screen.getByText("Synthetic Card · Test Set · Near Mint"),
    ).toBeTruthy();
    expect(screen.getByText("No tracking has been added")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          requestPath(input) ===
          "/api/connections/tcgplayer-main/orders/SYNTHETIC-ORDER-DETAIL",
      ),
    ).toBe(true);
  });

  it("copies the Pirate Ship address before opening the new tab", async () => {
    window.location.hash = "orders";
    const order = {
      ...marketplaceOrder({
        remoteId: "SYNTHETIC-PIRATE-SHIP",
        subtotalMinorUnits: 1_200,
        shippingMinorUnits: 149,
        totalMinorUnits: 1_349,
      }),
      orderNumber: "SYNTHETIC-PIRATE-SHIP",
      buyerName: "Synthetic Buyer",
      orderDate: "2026-08-07T12:00:00.000Z",
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      shippingType: "Standard",
      productAmount: 12,
      shippingAmount: 1.49,
      totalAmount: 13.49,
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders?") {
          return Promise.resolve(
            json({
              data: [order],
              issues: [],
              completedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        if (
          path ===
          `/api/connections/tcgplayer-main/orders/${order.orderNumber}/pirate-ship`
        ) {
          return Promise.resolve(
            json({
              url: "https://ship.pirateship.com/ship/single",
              pasteAddress:
                "Synthetic Buyer\n123 Example Street\nExample City, IL 00000",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const sequence: string[] = [];
    const write = vi.fn(() => {
      sequence.push("copy");
      return Promise.resolve();
    });
    Object.defineProperty(navigator.clipboard, "write", {
      configurable: true,
      value: write,
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly items: Record<string, ClipboardItemData>) {}
      },
    );
    const assign = vi.fn();
    const close = vi.fn();
    const opened = {
      opener: window,
      location: { assign },
      close,
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      sequence.push("open");
      return opened;
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText(order.orderNumber);
    await user.click(
      screen.getByRole("button", { name: "More order actions" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open in Pirate Ship" }),
    );

    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "https://ship.pirateship.com/ship/single",
      ),
    );
    expect(sequence).toEqual(["copy", "open"]);
    expect(opened.opener).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#orders");
    Reflect.deleteProperty(navigator.clipboard, "write");
  });

  it("keeps an accepted shipment non-actionable while provider status catches up", async () => {
    window.location.hash = "orders";
    const readyOrder = {
      ...marketplaceOrder({
        remoteId: "SYNTHETIC-SYNCHRONOUS-SHIPMENT",
        subtotalMinorUnits: 1_200,
        shippingMinorUnits: 149,
        totalMinorUnits: 1_349,
      }),
      orderNumber: "SYNTHETIC-SYNCHRONOUS-SHIPMENT",
      buyerName: "Synthetic Buyer",
      orderDate: "2026-08-07T12:00:00.000Z",
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      shippingType: "Standard",
      productAmount: 12,
      shippingAmount: 1.49,
      totalAmount: 13.49,
    };
    const shippedOrder = {
      ...readyOrder,
      ...marketplaceOrder({
        remoteId: readyOrder.orderNumber,
        providerStatus: "Shipped - In Transit",
        providerStatusCode: "Shipped",
        lifecycle: "shipped",
        subtotalMinorUnits: 1_200,
        shippingMinorUnits: 149,
        totalMinorUnits: 1_349,
        availableActions: ["view-detail", "packing-slip", "pirate-ship"],
      }),
      status: "Shipped - In Transit",
      statusCode: "Shipped",
      canMarkShipped: false,
    };
    let allOrderReads = 0;
    let providerCaughtUp = false;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/settings") {
          return Promise.resolve(
            json({ ...settings, confirmBeforeMarkingShipped: false }),
          );
        }
        if (
          path ===
            `/api/connections/tcgplayer-main/orders/${readyOrder.orderNumber}/mark-shipped` &&
          options?.method === "POST"
        ) {
          return Promise.resolve(
            json({
              ref: readyOrder.ref,
              outcome: "applied",
            }),
          );
        }
        if (path === "/api/orders?" || path === "/api/orders?refresh=1") {
          allOrderReads += 1;
          return Promise.resolve(
            json({
              data: providerCaughtUp ? [shippedOrder] : [readyOrder],
              issues: [],
              completedAt: `2026-08-07T12:0${String(allOrderReads)}:00.000Z`,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const orderRow = () =>
      screen
        .getByRole("link", { name: readyOrder.orderNumber })
        .closest("tr") as HTMLElement;
    await screen.findByText(readyOrder.orderNumber);
    await user.click(
      within(orderRow()).getByRole("button", { name: "Mark shipped" }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, options]) =>
            requestPath(input).endsWith("/mark-shipped") &&
            options?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(
      within(orderRow()).getByText("Shipment accepted · syncing status"),
    ).toBeTruthy();
    expect(within(orderRow()).getByText("Ready to Ship")).toBeTruthy();
    expect(
      within(orderRow()).queryByRole("button", { name: "Mark shipped" }),
    ).toBeNull();

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Refresh" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    providerCaughtUp = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(within(orderRow()).getByText(/Shipped\s+In Transit/)).toBeTruthy(),
    );
    expect(
      within(orderRow()).queryByText("Shipment accepted · syncing status"),
    ).toBeNull();
    expect(
      within(orderRow()).queryByRole("button", { name: "Mark shipped" }),
    ).toBeNull();
  });

  it("displays and prints a master pull list with optional color metadata", async () => {
    window.location.hash = "orders/pull-list";
    const pullList = {
      orderCount: 2,
      totalQuantity: 3,
      pulledQuantity: 0,
      remainingQuantity: 3,
      fetchedAt: "2026-08-07T12:01:00.000Z",
      issues: [],
      rows: [
        {
          rowKey: "456",
          productLine: "Magic: The Gathering",
          productName: "Synthetic Red Card",
          condition: "Near Mint",
          number: "42",
          setName: "Synthetic Set",
          rarity: "Rare",
          quantity: 8,
          mainPhotoUrl: "https://www.example.test/red.jpg",
          setReleaseDate: "2026-01-01",
          skuId: "456",
          orderQuantity: 2,
          productId: 123,
          attributes: { color: ["Red"], cardType: ["Creature"] },
          metadata: [{ label: "Color", values: ["Red"] }],
          bin: "MTG / Red / Creature / No power",
          pulledQuantity: 0,
          remainingQuantity: 2,
          pulled: false,
          canTrackPullProgress: true,
        },
        {
          rowKey: "789",
          productLine: "Synthetic Game",
          productName: "Product Without Color",
          condition: "Near Mint",
          number: "7",
          setName: "Synthetic Set",
          rarity: "Common",
          quantity: 4,
          mainPhotoUrl: "https://www.example.test/colorless.jpg",
          setReleaseDate: "2026-01-01",
          skuId: "789",
          orderQuantity: 1,
          productId: 124,
          attributes: {},
          metadata: [],
          bin: "Unsorted",
          pulledQuantity: 0,
          remainingQuantity: 1,
          pulled: false,
          canTrackPullProgress: true,
        },
      ],
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders/pull-list") {
          return Promise.resolve(json(pullList));
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tcgplayer-alert.master-pull-list-sort.v1",
      JSON.stringify({ field: "unsupported", direction: "sideways" }),
    );
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Master pull list" }),
    ).toBeTruthy();
    expect(await screen.findByText("Synthetic Red Card")).toBeTruthy();
    expect(screen.getByText("Red")).toBeTruthy();
    expect(screen.getByText("MTG / Red / Creature / No power")).toBeTruthy();
    expect(screen.getByText("Unsorted")).toBeTruthy();
    expect(screen.getByText("Product Without Color")).toBeTruthy();
    expect(screen.queryByText("Unknown")).toBeNull();
    expect(
      screen.getByText("Cards to pull").nextElementSibling?.textContent,
    ).toBe("3");
    expect(
      screen.getByText("2 ready orders · 3 cards · 2 exact variants"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "All orders" }).getAttribute("href"),
    ).toBe("#orders");

    const productOrder = () =>
      within(screen.getByRole("table"))
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[3]?.textContent);

    expect(productOrder()).toEqual([
      "Synthetic Red CardMagic: The Gathering",
      "Product Without ColorSynthetic Game",
    ]);
    expect(screen.getByRole("button", { name: "Sort by qty" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sort by bin, currently ascending" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sort by set / #" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sort by condition" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by rarity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by color" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sort by product" }));
    expect(productOrder()).toEqual([
      "Product Without ColorSynthetic Game",
      "Synthetic Red CardMagic: The Gathering",
    ]);
    expect(
      screen
        .getByRole("button", {
          name: "Sort by product, currently ascending",
        })
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("ascending");

    cleanup();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Master pull list" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Sort by product, currently ascending",
        }),
      ).toBeTruthy(),
    );
    expect(productOrder()).toEqual([
      "Product Without ColorSynthetic Game",
      "Synthetic Red CardMagic: The Gathering",
    ]);

    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledOnce();
  });

  it("marks a card pulled, hides it by default, and restores it prechecked", async () => {
    window.location.hash = "orders/pull-list";
    const row = {
      rowKey: "456",
      productLine: "Magic: The Gathering",
      productName: "Synthetic Pull Card",
      condition: "Near Mint",
      number: "42",
      setName: "Synthetic Set",
      rarity: "Rare",
      quantity: 8,
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
    };
    const pullList = {
      orderCount: 1,
      totalQuantity: 2,
      pulledQuantity: 0,
      remainingQuantity: 2,
      fetchedAt: "2026-08-07T12:01:00.000Z",
      issues: [],
      rows: [row],
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders/pull-list") {
          return Promise.resolve(json(pullList));
        }
        if (path === "/api/orders/pull-list/items/456") {
          if (typeof options?.body !== "string") {
            throw new Error("Expected a synthetic JSON request body");
          }
          const body = JSON.parse(options.body) as { pulled: boolean };
          return Promise.resolve(
            json({
              ...row,
              pulledQuantity: body.pulled ? 2 : 0,
              remainingQuantity: body.pulled ? 0 : 2,
              pulled: body.pulled,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const markPulled = await screen.findByRole("checkbox", {
      name: "Mark Synthetic Pull Card as pulled",
    });
    await user.click(markPulled);

    const markNotPulled = await screen.findByRole("checkbox", {
      name: "Mark Synthetic Pull Card as not pulled",
    });
    expect((markNotPulled as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText("Cards to pull").nextElementSibling?.textContent,
    ).toBe("0");
    expect(
      screen.getByText("Pulled", { selector: ".pull-list-summary span" })
        .nextElementSibling?.textContent,
    ).toBe("2");

    await user.click(screen.getByRole("checkbox", { name: "Show pulled (1)" }));
    expect(screen.queryByText("Synthetic Pull Card")).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Show pulled (1)" }));
    const restored = screen.getByRole("checkbox", {
      name: "Mark Synthetic Pull Card as not pulled",
    });
    expect((restored as HTMLInputElement).checked).toBe(true);

    await user.click(restored);
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", {
          name: "Mark Synthetic Pull Card as pulled",
        }),
      ).toBeTruthy(),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/orders/pull-list/items/456",
      ),
    ).toHaveLength(2);
  });

  it("runs the orders workspace with ManaPool as the only connected provider", async () => {
    window.location.hash = "orders";
    const providerOrderId = "018f4c5a-6b7c-7d8e-8f90-123456789abc";
    const capabilities = {
      viewDetail: true,
      addTracking: true,
      markShipped: true,
      pirateShip: true,
      printAddressLabel: true,
      packingSlip: true,
      refund: false,
    };
    const order = {
      ...marketplaceOrder({
        connectionId: "manapool-main",
        remoteId: providerOrderId,
        displayOrderNumber: "MP-100",
        buyerName: "ManaPool Buyer",
        createdAt: "2026-08-24T12:00:00.000Z",
        shippingMethod: "Ground Advantage",
        subtotalMinorUnits: 1_200,
        shippingMinorUnits: 224,
        totalMinorUnits: 1_424,
        availableActions: [
          "view-detail",
          "add-tracking",
          "mark-shipped",
          "pirate-ship",
          "print-address-label",
          "packing-slip",
        ],
      }),
      provider: "manapool",
      providerOrderId,
      capabilities,
      orderNumber: "MP-100",
      buyerName: "ManaPool Buyer",
      orderDate: "2026-08-24T12:00:00.000Z",
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      shippingType: "Ground Advantage",
      productAmount: 12,
      shippingAmount: 2.24,
      totalAmount: 14.24,
    };
    const detail = {
      ...marketplaceOrderDetail({
        connectionId: "manapool-main",
        remoteId: providerOrderId,
        displayOrderNumber: "MP-100",
        buyerName: "ManaPool Buyer",
        createdAt: "2026-08-24T12:00:00.000Z",
        shippingMethod: "Ground Advantage",
        subtotalMinorUnits: 1_200,
        shippingMinorUnits: 224,
        totalMinorUnits: 1_424,
        availableActions: [
          "view-detail",
          "add-tracking",
          "mark-shipped",
          "pirate-ship",
          "print-address-label",
          "packing-slip",
        ],
        addressOne: "123 Provider Avenue",
        description: "ManaPool Card",
        orderChannel: "ManaPool",
        sellerName: "ManaPool seller",
        paymentMethod: "ManaPool payment",
      }),
      provider: "manapool",
      providerOrderId,
      capabilities,
      createdAt: order.orderDate,
      status: order.status,
      statusCode: order.statusCode,
      orderChannel: "ManaPool",
      orderFulfillment: "Seller",
      orderNumber: order.orderNumber,
      sellerName: "ManaPool seller",
      buyerName: order.buyerName,
      paymentType: "ManaPool payment",
      pickupStatus: "Not requested",
      shippingType: order.shippingType,
      estimatedDeliveryDate: "2026-08-29T12:00:00.000Z",
      transaction: {
        productAmount: 12,
        shippingAmount: 2.24,
        grossAmount: 14.24,
        feeAmount: 1,
        netAmount: 13.24,
        directFeeAmount: 0,
        taxes: [],
      },
      shippingAddress: {
        recipientName: "ManaPool Buyer",
        addressOne: "123 Provider Avenue",
        city: "Testville",
        territory: "IL",
        country: "US",
        postalCode: "60000",
      },
      products: [
        {
          name: "ManaPool Card",
          unitPrice: 6,
          extendedPrice: 12,
          quantity: 2,
          url: "https://manapool.com/",
          productId: "product-id",
          skuId: "123",
        },
      ],
      trackingNumbers: [],
      canMarkShipped: true,
      fetchedAt: "2026-08-24T13:00:00.000Z",
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/marketplace-connections") {
          return Promise.resolve(
            json({
              connections: [
                {
                  descriptor: {
                    connectionId: "manapool-main",
                    providerId: "manapool",
                    providerLabel: "ManaPool",
                    connectionLabel: "ManaPool",
                  },
                  enabled: true,
                  supportedFacets: [
                    "order-pages",
                    "order-details",
                    "fulfillment",
                  ],
                  health: {
                    state: "connected",
                    checkedAt: "2026-08-24T13:00:00.000Z",
                  },
                },
              ],
              completedAt: "2026-08-24T13:00:00.000Z",
            }),
          );
        }
        if (path === "/api/auth/status") {
          return Promise.resolve(
            json({
              state: "connected",
              source: "environment",
              automaticRenewal: false,
              protectedStorage: false,
              updatedAt: "2026-08-24T13:00:00.000Z",
              providers: {
                tcgplayer: "disconnected",
                manapool: "connected",
              },
            }),
          );
        }
        if (path === "/api/orders?") {
          return Promise.resolve(
            json({
              data: [order],
              issues: [],
              completedAt: "2026-08-24T13:00:00.000Z",
            }),
          );
        }
        if (
          path === `/api/connections/manapool-main/orders/${providerOrderId}`
        ) {
          return Promise.resolve(json(detail));
        }
        if (
          path ===
            `/api/connections/manapool-main/orders/${providerOrderId}/print` &&
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

    const orderLink = await screen.findByRole("link", {
      name: order.orderNumber,
    });
    expect(orderLink.getAttribute("href")).toBe(
      `#orders/manapool-main/${providerOrderId}`,
    );
    expect(screen.getByText("ManaPool connected")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Master pull list" })).toBeNull();

    const row = orderLink.closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("Expected order row.");
    expect(within(row).getByRole("button", { name: "Tracking" })).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "Mark shipped" }),
    ).toBeTruthy();
    await user.click(
      within(row).getByRole("button", { name: "More order actions" }),
    );
    await user.click(
      within(row).getByRole("button", { name: "Print address label" }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/connections/manapool-main/orders/${providerOrderId}/print`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ actionType: "print-address-label" }),
        }),
      ),
    );
    await user.click(
      within(row).getByRole("button", { name: "More order actions" }),
    );
    await user.click(
      within(row).getByRole("button", { name: "Print packing slip" }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/connections/manapool-main/orders/${providerOrderId}/print`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ actionType: "print-packing-slip" }),
        }),
      ),
    );
    await user.click(
      within(row).getByRole("button", { name: "More order actions" }),
    );
    expect(
      within(row)
        .getByRole("link", { name: "Download packing slip" })
        .getAttribute("href"),
    ).toBe(
      `/api/connections/manapool-main/orders/${providerOrderId}/packing-slip`,
    );
    expect(
      within(row).getByRole("button", { name: "Open in Pirate Ship" }),
    ).toBeTruthy();

    await user.click(orderLink);
    expect(
      await screen.findByRole("heading", { name: "Order MP-100" }),
    ).toBeTruthy();
    expect(await screen.findByText("123 Provider Avenue")).toBeTruthy();
    expect(screen.getByText("ManaPool Card")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Open in TCGplayer" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          requestPath(input) ===
          `/api/connections/manapool-main/orders/${providerOrderId}`,
      ),
    ).toBe(true);
  });

  it("renders an unrecognized third provider through the unchanged list and detail pages", async () => {
    window.location.hash = "orders";
    const order = marketplaceOrder({
      connectionId: "synthetic-third-main",
      remoteId: "third-remote-id",
      displayOrderNumber: "THIRD-100",
      buyerName: "Third Provider Buyer",
      availableActions: ["view-detail"],
    });
    const detail = marketplaceOrderDetail({
      connectionId: order.ref.connectionId,
      remoteId: order.ref.remoteId,
      displayOrderNumber: order.displayOrderNumber,
      buyerName: "Third Provider Buyer",
      addressOne: "300 Extensible Avenue",
      description: "Third Provider Product",
      availableActions: ["view-detail"],
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === "/api/marketplace-connections") {
        return Promise.resolve(
          json({
            connections: [
              {
                descriptor: {
                  connectionId: "synthetic-third-main",
                  providerId: "synthetic-third",
                  providerLabel: "Synthetic Third",
                  connectionLabel: "Third Store",
                },
                enabled: true,
                supportedFacets: ["order-pages", "order-details"],
                health: {
                  state: "connected",
                  checkedAt: "2026-08-25T12:00:00.000Z",
                },
              },
            ],
            completedAt: "2026-08-25T12:00:00.000Z",
          }),
        );
      }
      if (path === "/api/orders?") {
        return Promise.resolve(
          json({
            data: [order],
            issues: [],
            completedAt: "2026-08-25T12:00:00.000Z",
          }),
        );
      }
      if (
        path === "/api/connections/synthetic-third-main/orders/third-remote-id"
      ) {
        return Promise.resolve(json(detail));
      }
      return baseFetch(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const link = await screen.findByRole("link", { name: "THIRD-100" });
    expect(link.getAttribute("href")).toBe(
      "#orders/synthetic-third-main/third-remote-id",
    );
    expect(screen.getByText("Third Store connected")).toBeTruthy();

    await user.click(link);
    expect(
      await screen.findByRole("heading", { name: "Order THIRD-100" }),
    ).toBeTruthy();
    expect(await screen.findByText("300 Extensible Avenue")).toBeTruthy();
    expect(screen.getByText("Third Provider Product")).toBeTruthy();
  });
});
