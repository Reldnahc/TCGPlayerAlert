// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import {
  baseFetch,
  json,
  requestPath,
  settings,
  resetWebUiTest,
} from "./web-ui-fixtures.js";

afterEach(resetWebUiTest);

describe("catalog and inventory", () => {
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
                {
                  productConditionId: 457,
                  conditionId: 2,
                  condition: "Lightly Played",
                  printing: "Normal",
                  language: "English",
                },
              ],
            }),
          );
        if (path === "/api/inventory-additions/preview") {
          if (typeof options?.body !== "string")
            throw new Error("Expected an addition preview body.");
          const request = JSON.parse(options.body) as {
            productConditionId: number;
          };
          const lightlyPlayed = request.productConditionId === 457;
          return Promise.resolve(
            json({
              id: "00000000-0000-4000-8000-000000000001",
              createdAt: "2026-08-07T12:00:00.000Z",
              expiresAt: "2026-08-07T12:10:00.000Z",
              product: {
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
              },
              sku: {
                productConditionId: lightlyPlayed ? 457 : 456,
                conditionId: lightlyPlayed ? 2 : 1,
                condition: lightlyPlayed ? "Lightly Played" : "Near Mint",
                printing: "Normal",
                language: "English",
              },
              currentQuantity: 0,
              addQuantity: 1,
              proposedPrice: lightlyPlayed ? 2.99 : 3.49,
              effectiveShippingPrice: 1.49,
              proposedDeliveredPrice: lightlyPlayed ? 4.48 : 4.98,
              competitorPrice: lightlyPlayed ? 2.99 : 3.49,
              competitorShipping: 1.49,
              competitorCondition: "Near Mint",
              minimumApplied: false,
              queueable: true,
              reason: "Uses the marketplace reference.",
              rules: {
                ...settings.repricingProfiles[0],
                estimatedShippingPrice: 1.49,
              },
            }),
          );
        }
        if (path.includes("/api/inventory-additions/previews/"))
          return Promise.resolve(
            json(
              {
                jobs: [
                  {
                    id: "job",
                    createdAt: "2026-08-07T12:00:00.000Z",
                    updatedAt: "2026-08-07T12:00:00.000Z",
                    attempts: 0,
                    status: "pending",
                    operation: "add",
                    addition: {
                      productId: 123,
                      productName: "Synthetic Card",
                      productConditionId: 456,
                      conditionId: 1,
                      channelId: 0,
                      categoryName: "Magic: The Gathering",
                      currentQuantity: 0,
                      addQuantity: 1,
                      price: 3.49,
                      storePriceCustomId: null,
                      reserveQuantity: 0,
                    },
                  },
                ],
              },
              202,
            ),
          );
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

    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/inventory-additions/preview",
      ),
    ).toHaveLength(0);
    await user.click(
      screen.getByRole("button", {
        name: "Show listing price for Synthetic Card",
      }),
    );
    expect(await screen.findByText("$3.49")).toBeTruthy();

    await user.selectOptions(
      screen.getByLabelText("Condition for Synthetic Card"),
      "Damaged",
    );
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/inventory-additions/preview",
      ),
    ).toHaveLength(1);

    await user.selectOptions(
      screen.getByLabelText("Condition for Synthetic Card"),
      "Lightly Played",
    );
    expect(await screen.findByText("$2.99")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "+1" }));
    expect((await screen.findAllByText("Queued +1 at $2.99.")).length).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/inventory-additions/preview",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("schedules an exact catalog SKU without pricing or queueing it immediately", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/catalog/search")) {
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
        }
        if (path === "/api/catalog/products/123") {
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
        }
        if (
          path === "/api/internal-jobs/listings" &&
          options?.method === "POST"
        ) {
          if (typeof options.body !== "string")
            throw new Error("Expected a scheduled listing body.");
          const submitted = JSON.parse(options.body) as {
            runAt: string;
            merchandiseProfileId: string;
            item: Record<string, unknown>;
          };
          return Promise.resolve(
            json(
              {
                schedule: {
                  id: "00000000-0000-4000-8000-000000000200",
                  name: "List 1 card",
                  enabled: true,
                  timing: { kind: "once", runAt: submitted.runAt },
                  payload: {
                    type: "list-inventory",
                    merchandiseProfileId: submitted.merchandiseProfileId,
                    items: [submitted.item],
                  },
                  createdAt: "2026-08-10T12:00:00.000Z",
                  updatedAt: "2026-08-10T12:00:00.000Z",
                  nextRunAt: submitted.runAt,
                },
              },
              202,
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
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    await user.selectOptions(
      screen.getByLabelText("Listing time"),
      "scheduled",
    );
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Synthetic Card");
    await user.click(screen.getByRole("button", { name: "+1" }));

    expect((await screen.findAllByText(/Scheduled \+1 for/u)).length).toBe(2);
    const call = fetchMock.mock.calls.find(
      ([input]) => requestPath(input) === "/api/internal-jobs/listings",
    );
    expect(call).toBeDefined();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/inventory-additions/preview",
      ),
    ).toBe(false);
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
});
