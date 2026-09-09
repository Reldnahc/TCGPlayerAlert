// @vitest-environment jsdom

import { render, screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import {
  baseFetch,
  json,
  requestPath,
  resetWebUiTest,
} from "./web-ui-fixtures.js";

afterEach(resetWebUiTest);

describe("local Add cards workflow", () => {
  it("adds locally and immediately prepares ManaPool when the top toggle is enabled", async () => {
    const fetchMock = vi.fn(localAddFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    await user.selectOptions(screen.getByLabelText("List on"), "manapool-main");
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Synthetic Card")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "+1" }));

    expect(
      (
        await screen.findAllByText(
          "Added 1 to local stock. Preparing the ManaPool listing.",
        )
      ).length,
    ).toBeGreaterThan(0);
    const addition = fetchMock.mock.calls.find(
      ([input]) =>
        requestPath(input) ===
        "/api/local-inventory/catalog-items?connectionId=tcgplayer-main",
    );
    expect(addition?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        productId: 123,
        productConditionId: 456,
        quantity: 1,
      }),
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestPath(input).startsWith("/api/inventory-additions"),
      ),
    ).toBe(false);

    expect(
      await screen.findByRole("heading", { name: "List on ManaPool" }),
    ).toBeTruthy();
    expect(
      await screen.findByText(/This creates a new live listing/u),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    expect(
      (await screen.findAllByText(/Published 1 on ManaPool at/u)).length,
    ).toBeGreaterThan(0);

    const publish = fetchMock.mock.calls.find(
      ([input]) =>
        requestPath(input) ===
        "/api/local-inventory/publications/previews/00000000-0000-4000-8000-000000000002/publish",
    );
    expect(publish?.[1]).toMatchObject({ method: "POST" });
  });

  it("adds only local stock when Local inventory only is selected", async () => {
    window.localStorage.setItem(
      "seller-tools.add-card-listing-destination",
      "local",
    );
    const fetchMock = vi.fn(localAddFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    expect(listOnValue()).toBe("local");
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByRole("button", { name: "+1" }));

    expect(
      (await screen.findAllByText("Added 1 to local stock. On hand: 1."))
        .length,
    ).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          requestPath(input) === "/api/local-inventory/publications/preview",
      ),
    ).toBe(false);
  });

  it("adds locally and queues the selected exact SKU on TCGplayer", async () => {
    const fetchMock = vi.fn(localAddFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    await user.selectOptions(
      screen.getByLabelText("List on"),
      "tcgplayer-main",
    );
    expect(listOnValue()).toBe("tcgplayer-main");
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Show listing price for Synthetic Card",
      }),
    );
    expect(await screen.findByText("$2.40")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "+1" }));

    expect(
      (await screen.findAllByText(/queued \+1 on TCGplayer at \$2\.40/u))
        .length,
    ).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          requestPath(input) ===
          "/api/inventory-additions/preview?connectionId=tcgplayer-main",
      ),
    ).toBe(true);
  });

  it("compares both exact-SKU prices and auto-selects the higher marketplace", async () => {
    const fetchMock = vi.fn(localAddFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    expect(listOnValue()).toBe("auto");
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Show listing price for Synthetic Card",
      }),
    );
    await screen.findByText("$2.50");
    const priceButton = screen.getByRole("button", {
      name: "Refresh listing price for Synthetic Card",
    });
    expect(priceButton.textContent).toContain("TCGplayer $2.40");
    expect(priceButton.textContent).toContain("ManaPool $2.50 ✓");

    await user.click(screen.getByRole("button", { name: "+1" }));
    expect(
      (await screen.findAllByText(/Auto selected ManaPool at \$2\.50/u)).length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByRole("heading", { name: "List on ManaPool" }),
    ).toBeTruthy();
  });

  it("keeps Auto usable when one price catalogue is unavailable", async () => {
    const fetchMock = vi.fn(autoFallbackFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    expect(listOnValue()).toBe("auto");
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByRole("button", { name: "+1" }));

    expect(
      (await screen.findAllByText(/queued \+1 on TCGplayer at \$2\.40/u))
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("heading", { name: "List on ManaPool" }),
    ).toBeNull();
  });

  it("forces Foil when the product only has foil SKUs", async () => {
    const fetchMock = vi.fn(foilOnlyFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Add cards" }));
    await user.selectOptions(screen.getByLabelText("List on"), "local");
    await user.type(
      screen.getByLabelText("Card name or product #"),
      "Synthetic Card",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    const foil = await screen.findByTitle("This product is foil only");
    expect(foil).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "+1" }));

    const addition = fetchMock.mock.calls.find(
      ([input]) =>
        requestPath(input) ===
        "/api/local-inventory/catalog-items?connectionId=tcgplayer-main",
    );
    const body = addition?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected the local inventory request body.");
    }
    expect(JSON.parse(body)).toMatchObject({
      productConditionId: 457,
    });
  });
});

function foilOnlyFetch(
  input: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  if (
    requestPath(input) ===
    "/api/catalog/products/123?connectionId=tcgplayer-main"
  ) {
    return Promise.resolve(
      json({
        ...product(),
        skus: [
          {
            productConditionId: 457,
            conditionId: 1,
            condition: "Near Mint",
            printing: "Foil",
            language: "English",
          },
        ],
      }),
    );
  }
  return localAddFetch(input, options);
}

function autoFallbackFetch(
  input: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  if (
    requestPath(input) === "/api/local-inventory/publications/quote" &&
    options?.method === "POST"
  ) {
    return Promise.resolve(json({ message: "Pricing unavailable" }, 503));
  }
  return localAddFetch(input, options);
}

function localAddFetch(
  input: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  const path = requestPath(input);
  if (
    path ===
    "/api/catalog/search?connectionId=tcgplayer-main&q=Synthetic+Card&offset=0"
  ) {
    return Promise.resolve(
      json({
        totalProducts: 1,
        productLines: [],
        sets: [],
        products: [{ ...product(), matchKind: "exact", matchRank: [0] }],
        nextOffset: 1,
        hasMore: false,
      }),
    );
  }
  if (
    path === "/api/local-inventory/publications/quote" &&
    options?.method === "POST"
  ) {
    return Promise.resolve(
      json({
        quote: {
          connectionId: "manapool-main",
          connectionLabel: "ManaPool",
          exactIdentity: {
            namespace: "tcgplayer.sku",
            value: "456",
            precision: "exact-variant",
          },
          price: { currency: "USD", minorUnits: 250 },
          source: "market-low",
          availableQuantity: 3,
          asOf: "2026-08-25T20:00:00.000Z",
        },
      }),
    );
  }
  if (
    path === "/api/local-inventory/publications/preview" &&
    options?.method === "POST"
  ) {
    return Promise.resolve(
      json({
        preview: {
          id: "00000000-0000-4000-8000-000000000002",
          expiresAt: "2026-08-25T20:15:00.000Z",
          connectionId: "manapool-main",
          connectionLabel: "ManaPool",
          localInventoryId: "00000000-0000-4000-8000-000000000001",
          displayName: "Synthetic Card",
          quantity: 1,
          price: { currency: "USD", minorUnits: 250 },
          exactIdentity: {
            namespace: "tcgplayer.sku",
            value: "456",
            precision: "exact-variant",
          },
        },
      }),
    );
  }
  if (
    path === "/api/inventory-additions/preview?connectionId=tcgplayer-main" &&
    options?.method === "POST"
  ) {
    return Promise.resolve(json(additionPreview()));
  }
  if (
    path ===
      "/api/inventory-additions/previews/00000000-0000-4000-8000-000000000010/queue?connectionId=tcgplayer-main" &&
    options?.method === "POST"
  ) {
    return Promise.resolve(
      json({
        jobs: [
          {
            id: "00000000-0000-4000-8000-000000000011",
            status: "pending",
            operation: "add",
            addition: {
              productId: 123,
              productName: "Synthetic Card",
              productConditionId: 456,
              conditionId: 1,
              channelId: 0,
              categoryName: "Magic",
              currentQuantity: 0,
              addQuantity: 1,
              price: 2.4,
              storePriceCustomId: null,
              reserveQuantity: 0,
            },
            createdAt: "2026-08-25T20:00:00.000Z",
            updatedAt: "2026-08-25T20:00:00.000Z",
            attempts: 0,
          },
        ],
      }),
    );
  }
  if (
    path ===
      "/api/local-inventory/publications/previews/00000000-0000-4000-8000-000000000002/publish" &&
    options?.method === "POST"
  ) {
    return Promise.resolve(
      json({
        job: {
          id: "00000000-0000-4000-8000-000000000003",
          connectionId: "manapool-main",
          localInventoryId: "00000000-0000-4000-8000-000000000001",
          displayName: "Synthetic Card",
          quantity: 1,
          price: { currency: "USD", minorUnits: 250 },
          exactIdentity: {
            namespace: "tcgplayer.sku",
            value: "456",
            precision: "exact-variant",
          },
          status: "submitted",
          createdAt: "2026-08-25T20:00:00.000Z",
          updatedAt: "2026-08-25T20:00:01.000Z",
        },
      }),
    );
  }
  if (path === "/api/catalog/products/123?connectionId=tcgplayer-main") {
    return Promise.resolve(
      json({
        ...product(),
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
    path === "/api/local-inventory/catalog-items?connectionId=tcgplayer-main" &&
    options?.method === "POST"
  ) {
    return Promise.resolve(
      json({
        item: {
          localInventoryId: "00000000-0000-4000-8000-000000000001",
          displayName: "Synthetic Card",
          onHand: 1,
          catalogIdentities: [
            {
              namespace: "tcgplayer.sku",
              value: "456",
              precision: "exact-variant",
            },
          ],
          attributes: {
            condition: "Near Mint",
            printing: "Normal",
            language: "English",
          },
          createdAt: "2026-08-25T20:00:00.000Z",
          updatedAt: "2026-08-25T20:00:00.000Z",
        },
      }),
    );
  }
  return baseFetch(input, options);
}

function product() {
  return {
    productId: 123,
    imageUrl: "https://example.invalid/card.jpg",
    productName: "Synthetic Card",
    productLineName: "Magic: The Gathering",
    setName: "Synthetic Set",
    rarityName: "Rare",
    cardNumber: "1",
    marketPrice: 2.5,
    sellerListable: true,
  };
}

function listOnValue(): string {
  const select = screen.getByLabelText("List on");
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("Expected a listing destination selector.");
  }
  return select.value;
}

function additionPreview() {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    createdAt: "2026-08-25T20:00:00.000Z",
    expiresAt: "2026-08-25T20:15:00.000Z",
    product: product(),
    sku: {
      productConditionId: 456,
      conditionId: 1,
      condition: "Near Mint",
      printing: "Normal",
      language: "English",
    },
    currentQuantity: 0,
    addQuantity: 1,
    proposedPrice: 2.4,
    minimumApplied: false,
    queueable: true,
    reason: "Ready",
    rules: {
      minimumPrice: 0.01,
      conditionPolicy: "same",
      priceBasis: "item",
      adjustmentCents: -1,
      allowPriceIncreases: true,
      ranges: [
        {
          minimumListings: 0,
          priceSource: "lowest",
          percentage: 100,
          gapThresholdPercent: 10,
          gapAction: "follow-lowest",
        },
      ],
      estimatedShippingPrice: 0,
    },
  };
}
