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
import { uiApi } from "../src/web/api.js";
import {
  baseFetch,
  json,
  requestPath,
  settings,
  resetWebUiTest,
} from "./web-ui-fixtures.js";

afterEach(resetWebUiTest);

describe("order workspaces", () => {
  it("requires tracking for a $50 order and opens its internal workspace", async () => {
    window.location.hash = "orders";
    const order = {
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
      createdAt: order.orderDate,
      status: order.status,
      statusCode: order.statusCode,
      orderChannel: "Marketplace",
      orderFulfillment: "Seller",
      orderNumber: order.orderNumber,
      sellerName: "Synthetic Seller",
      buyerName: order.buyerName,
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
      refunds: [],
      refundStatus: "None",
      refundCapabilities: { full: true, partial: true },
      trackingNumbers: [],
      canMarkShipped: true,
      fetchedAt: "2026-08-07T12:01:00.000Z",
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith(`/api/orders/${order.orderNumber}?`)) {
          return Promise.resolve(json(detail));
        }
        if (path === `/api/orders/${order.orderNumber}`) {
          return Promise.resolve(json(detail));
        }
        if (
          path === `/api/orders/${order.orderNumber}/refund` &&
          options?.method === "POST"
        ) {
          return Promise.resolve(
            json({
              orderNumber: order.orderNumber,
              refundType: "full",
              outcome: "submitted",
            }),
          );
        }
        if (path === "/api/settings") {
          return Promise.resolve(
            json({ ...settings, confirmBeforeMarkingShipped: false }),
          );
        }
        if (path === "/api/orders?") {
          return Promise.resolve(
            json({
              orders: [order],
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const refundOptions = vi.spyOn(uiApi, "refundOptions").mockResolvedValue({
      origins: [{ name: "Seller initiated", value: "SellerInitiated" }],
      reasons: [
        { name: "Inventory issue", value: "Product - Inventory Issue" },
      ],
    });
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
      screen
        .getByRole("link", { name: "Open in TCGplayer" })
        .getAttribute("href"),
    ).toBe("https://sellerportal.tcgplayer.com/orders/SYNTHETIC-ORDER-DETAIL");
    expect(
      screen
        .getByRole("link", { name: "Open in TCGplayer" })
        .getAttribute("target"),
    ).toBe("_blank");
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          requestPath(input) === "/api/orders/SYNTHETIC-ORDER-DETAIL",
      ),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Refund" }));
    await screen.findByText(
      "Review is always required before money is returned.",
    );
    await waitFor(() => expect(refundOptions).toHaveBeenCalledOnce());
    await user.type(
      await screen.findByRole("textbox", { name: "Message" }),
      "Synthetic refund",
    );
    await user.click(screen.getByRole("button", { name: "Review refund" }));

    expect(screen.getByText("Confirm this full refund")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([input, options]) =>
          requestPath(input).endsWith("/refund") && options?.method === "POST",
      ),
    ).toHaveLength(0);

    await user.click(
      screen.getByRole("button", { name: "Confirm full refund" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input, options]) =>
            requestPath(input).endsWith("/refund") &&
            options?.method === "POST",
        ),
      ).toHaveLength(1),
    );
    const refundCall = fetchMock.mock.calls.find(([input]) =>
      requestPath(input).endsWith("/refund"),
    );
    const refundBody = refundCall?.[1]?.body;
    if (typeof refundBody !== "string") {
      throw new Error("Expected the refund to be submitted as JSON.");
    }
    expect(JSON.parse(refundBody) as unknown).toEqual({
      type: "full",
      origin: "SellerInitiated",
      reason: "Product - Inventory Issue",
      reasonText: "Synthetic refund",
    });
  });

  it("prepares the address before opening Pirate Ship directly", async () => {
    window.location.hash = "orders";
    const order = {
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
              orders: [order],
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        if (path === `/api/orders/${order.orderNumber}/pirate-ship`) {
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
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    render(<App />);

    await screen.findByText(order.orderNumber);
    await user.click(
      screen.getByRole("button", { name: "More order actions" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open in Pirate Ship" }),
    );

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://ship.pirateship.com/ship/single",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(writeText).toHaveBeenCalledWith(
      "Synthetic Buyer\n123 Example Street\nExample City, IL 00000",
    );
    expect(window.location.hash).toBe("#orders");
  });

  it("keeps an accepted shipment non-actionable while provider status catches up", async () => {
    window.location.hash = "orders";
    const readyOrder = {
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
      status: "Shipped - In Transit",
      statusCode: "Shipped",
      canMarkShipped: false,
    };
    let allOrderReads = 0;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/settings") {
          return Promise.resolve(
            json({ ...settings, confirmBeforeMarkingShipped: false }),
          );
        }
        if (
          path === `/api/orders/${readyOrder.orderNumber}/mark-shipped` &&
          options?.method === "POST"
        ) {
          return Promise.resolve(
            json({
              orderNumber: readyOrder.orderNumber,
              outcome: "applied",
            }),
          );
        }
        if (path === "/api/orders?" || path === "/api/orders?refresh=1") {
          allOrderReads += 1;
          return Promise.resolve(
            json({
              orders: allOrderReads < 3 ? [readyOrder] : [shippedOrder],
              fetchedAt: `2026-08-07T12:0${String(allOrderReads)}:00.000Z`,
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

    await waitFor(() => expect(allOrderReads).toBe(2));
    expect(
      within(orderRow()).getByText("Shipment accepted · syncing status"),
    ).toBeTruthy();
    expect(within(orderRow()).getByText("Ready to Ship")).toBeTruthy();
    expect(
      within(orderRow())
        .getByRole("button", {
          name: "Mark shipped",
        })
        .hasAttribute("disabled"),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(within(orderRow()).getByText(/Shipped\s+In Transit/)).toBeTruthy(),
    );
    expect(
      within(orderRow()).queryByText("Shipment accepted · syncing status"),
    ).toBeNull();
    expect(
      within(orderRow())
        .getByRole("button", {
          name: "Mark shipped",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("displays and prints a master pull list with optional color metadata", async () => {
    window.location.hash = "orders/pull-list";
    const pullList = {
      orderCount: 2,
      totalQuantity: 3,
      pulledQuantity: 0,
      remainingQuantity: 3,
      fetchedAt: "2026-08-07T12:01:00.000Z",
      rows: [
        {
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
      screen.getByText("2 ready orders · 3 cards · 2 unique SKUs"),
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
});
