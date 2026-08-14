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
      metadata: [{ label: "Color", values: ["Blue"] }],
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
});
