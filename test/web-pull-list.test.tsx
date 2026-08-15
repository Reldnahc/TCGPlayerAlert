// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import {
  baseFetch,
  json,
  requestPath,
  resetWebUiTest,
} from "./web-ui-fixtures.js";

afterEach(resetWebUiTest);

const pullList = {
  orderCount: 1,
  rows: [
    {
      productLine: "Magic: The Gathering",
      productName: "Synthetic Cached Card",
      condition: "Near Mint",
      number: "42",
      setName: "Synthetic Set",
      rarity: "Rare",
      quantity: 10,
      mainPhotoUrl: "",
      setReleaseDate: "2026-01-01",
      skuId: "synthetic-sku",
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
  totalQuantity: 2,
  pulledQuantity: 0,
  remainingQuantity: 2,
  fetchedAt: "2026-08-07T12:00:00.000Z",
};

describe("master pull list", () => {
  it("keeps the loaded list mounted when window focus refreshes authentication", async () => {
    window.location.hash = "orders/pull-list";
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        if (requestPath(input) === "/api/orders/pull-list") {
          return Promise.resolve(json(pullList));
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const pullListReads = () =>
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/orders/pull-list",
      ).length;
    render(<App />);

    expect(await screen.findByText("Synthetic Cached Card")).toBeTruthy();
    expect(pullListReads()).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestPath(input) === "/api/auth/status",
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByText("Synthetic Cached Card")).toBeTruthy();
    expect(pullListReads()).toBe(1);
  });

  it("reloads the mounted list when an order leaves the ready queue", async () => {
    window.location.hash = "orders/pull-list";
    let readyOrderReads = 0;
    let pullListReads = 0;
    let runReadyOrderPoll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout) => {
      if (timeout === 5_000 && typeof handler === "function") {
        runReadyOrderPoll = handler;
      }
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    const readyOrder = {
      orderNumber: "SYNTHETIC-READY-ORDER",
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
    const emptyPullList = {
      ...pullList,
      orderCount: 0,
      rows: [],
      totalQuantity: 0,
      pulledQuantity: 0,
      remainingQuantity: 0,
      fetchedAt: "2026-08-07T12:00:05.000Z",
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/orders/pull-list")) {
          pullListReads += 1;
          return Promise.resolve(
            json(pullListReads === 1 ? pullList : emptyPullList),
          );
        }
        if (path === "/api/orders?status=ready-to-ship") {
          readyOrderReads += 1;
          return Promise.resolve(
            json({
              snapshot: {
                orders: readyOrderReads === 1 ? [readyOrder] : [],
                fetchedAt: "2026-08-07T12:00:00.000Z",
              },
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText("Synthetic Cached Card")).toBeTruthy();
    await waitFor(() => expect(readyOrderReads).toBe(1));
    expect(runReadyOrderPoll).toBeDefined();

    await act(async () => {
      runReadyOrderPoll?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(pullListReads).toBe(2);
      expect(screen.queryByText("Synthetic Cached Card")).toBeNull();
    });
    expect(screen.getByText("There are no cards to pull")).toBeTruthy();
  });
});
