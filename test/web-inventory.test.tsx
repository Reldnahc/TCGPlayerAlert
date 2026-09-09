// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/preact";
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

const completedAt = "2026-08-07T12:00:00.000Z";

describe("provider-neutral inventory", () => {
  it("derives workspaces from a ManaPool-only connection's facets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (
          path === "/api/marketplace-connections" ||
          path === "/api/marketplace-connections?refresh=1"
        ) {
          return Promise.resolve(
            json({
              connections: [
                connection(
                  "manapool-main",
                  "manapool",
                  "ManaPool",
                  "ManaPool Store",
                  ["order-pages", "inventory-reader", "inventory-mutator"],
                ),
              ],
              completedAt,
            }),
          );
        }
        if (path === "/api/auth/status") {
          return Promise.resolve(
            json({
              state: "disconnected",
              automaticRenewal: false,
              protectedStorage: true,
            }),
          );
        }
        return inventoryFetch(input, options);
      }),
    );
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.getByRole("link", { name: "Orders" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Scanner" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Inventory" })).toBeTruthy();
    for (const hidden of [
      "Add cards",
      "Repricing",
      "Jobs",
      "Payments",
      "Messages",
      "Feedback",
    ]) {
      expect(screen.queryByRole("link", { name: hidden })).toBeNull();
    }
  });

  it("shows local stock and filters it independently from marketplace observations", async () => {
    vi.stubGlobal("fetch", vi.fn(inventoryFetch));
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Inventory" }));

    const localStock = screen
      .getByRole("heading", { name: "Local stock" })
      .closest("section");
    if (localStock === null) throw new Error("Missing local stock section.");
    expect(await within(localStock).findByText("Lightning Bolt")).toBeTruthy();
    expect(screen.getByText("Unlisted Card")).toBeTruthy();
    expect(screen.queryByText("Booster Box")).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Listing status"),
      "unlisted",
    );
    expect(within(localStock).queryByText("Lightning Bolt")).toBeNull();
    expect(screen.getByText("Unlisted Card")).toBeTruthy();

    await user.type(screen.getByLabelText("Search inventory"), "missing");
    expect(
      screen.getByText("No local inventory matches these filters"),
    ).toBeTruthy();

    await user.clear(screen.getByLabelText("Search inventory"));
    await user.click(
      screen.getByRole("tab", { name: /Marketplace listings/u }),
    );
    expect(screen.queryByRole("heading", { name: "Local stock" })).toBeNull();
    expect(screen.getByText("Marketplace observations")).toBeTruthy();
    expect(screen.getByText("Booster Box")).toBeTruthy();
    expect(screen.queryByLabelText("Listing status")).toBeNull();
    await user.type(screen.getByLabelText("Search inventory"), "missing");
    expect(screen.getByText("No marketplace listings observed")).toBeTruthy();
  });

  it("exposes TCGplayer repricing as its own workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(inventoryFetch));
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Repricing" }));

    expect(screen.getByRole("heading", { name: "Repricing" })).toBeTruthy();
    expect(screen.getByLabelText("Pricing profile")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Local stock" })).toBeNull();
    expect(window.location.hash).toBe("#repricing");
  });

  it("updates only the exact local inventory item and refreshes", async () => {
    const fetchMock = vi.fn(inventoryFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Inventory" }));
    const localStock = screen
      .getByRole("heading", { name: "Local stock" })
      .closest("section");
    if (localStock === null) throw new Error("Missing local stock section.");
    const item = await within(localStock).findByText("Lightning Bolt");
    const row = item.closest("tr");
    if (row === null) throw new Error("Missing local inventory row.");
    const quantity = within(row).getByLabelText(
      "Local on-hand quantity for Lightning Bolt",
    );
    await user.clear(quantity);
    await user.type(quantity, "5");
    await user.click(within(row).getByRole("button", { name: "Save local" }));

    expect(await within(row).findByText("Local stock saved.")).toBeTruthy();
    const mutation = fetchMock.mock.calls.find(
      ([input]) =>
        requestPath(input) ===
        "/api/local-inventory/items/00000000-0000-4000-8000-000000000001",
    );
    expect(mutation?.[1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ onHand: 5 }),
      }),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/inventory",
      ),
    ).toHaveLength(2);
  });

  it("keeps a partial provider failure visible without hiding good data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
        if (requestPath(input) === "/api/inventory") {
          const payload = inventoryPayload();
          return Promise.resolve(
            json({
              ...payload,
              listings: payload.listings.filter(
                (listing) =>
                  listing.descriptor.connectionId === "tcgplayer-main",
              ),
              issues: [
                {
                  connectionId: "manapool-main",
                  operation: "inventory",
                  code: "PROVIDER_UNAVAILABLE",
                  retryable: true,
                },
              ],
            }),
          );
        }
        return inventoryFetch(input, options);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Inventory" }));

    const localStock = screen
      .getByRole("heading", { name: "Local stock" })
      .closest("section");
    if (localStock === null) throw new Error("Missing local stock section.");
    expect(await within(localStock).findByText("Lightning Bolt")).toBeTruthy();
    expect(
      screen.getByText(/manapool-main inventory is unavailable/u),
    ).toBeTruthy();
  });

  it("reviews and confirms a conservative one-time marketplace import", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/local-inventory/import-preview") {
          return Promise.resolve(json(importPreviewPayload()));
        }
        if (
          path === "/api/local-inventory/import" &&
          options?.method === "POST"
        ) {
          return Promise.resolve(
            json({
              createdCount: 1,
              createdItems: [inventoryPayload().items[1]],
              preview: importPreviewPayload(),
            }),
          );
        }
        return inventoryFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Inventory" }));
    await user.click(
      screen.getByRole("tab", { name: /Marketplace listings/u }),
    );

    await user.click(
      screen.getByRole("button", { name: "Import marketplace stock" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Import marketplace stock" }),
    ).toBeTruthy();
    expect(await screen.findByText("Cross-listed Card")).toBeTruthy();
    expect(
      screen.getByText("Cross-listed; using highest quantity"),
    ).toBeTruthy();
    expect(screen.getByText("First store: 4 · Second store: 2")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Import missing stock" }),
    );

    expect(
      await screen.findByText(
        "Imported 1 local stock item. No marketplace was changed.",
      ),
    ).toBeTruthy();
    const request = fetchMock.mock.calls.find(
      ([input]) => requestPath(input) === "/api/local-inventory/import",
    );
    expect(request?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ confirmation: "IMPORT_MARKETPLACE_STOCK" }),
    });
  });
});

function importPreviewPayload() {
  return {
    candidates: [
      {
        candidateKey: '["shared.sku","42","exact-variant"]',
        displayName: "Cross-listed Card",
        suggestedOnHand: 4,
        catalogIdentities: [
          {
            namespace: "shared.sku",
            value: "42",
            precision: "exact-variant",
          },
        ],
        attributes: { set: "Synthetic Set", condition: "Near Mint" },
        observations: [
          {
            connectionId: "first-main",
            connectionLabel: "First store",
            inventoryKey: "first-listing",
            quantity: 4,
          },
          {
            connectionId: "second-main",
            connectionLabel: "Second store",
            inventoryKey: "second-listing",
            quantity: 2,
          },
        ],
        crossListed: true,
      },
    ],
    alreadyLinkedCount: 1,
    skippedWithoutExactIdentityCount: 0,
    skippedZeroQuantityCount: 0,
    conflictingIdentityCount: 0,
    issues: [],
    completedAt,
  };
}

function inventoryFetch(
  input: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  const path = requestPath(input);
  if (
    path === "/api/marketplace-connections" ||
    path === "/api/marketplace-connections?refresh=1"
  ) {
    return Promise.resolve(json(connectionPayload()));
  }
  if (path === "/api/inventory") {
    return Promise.resolve(json(inventoryPayload()));
  }
  if (
    path ===
      "/api/local-inventory/items/00000000-0000-4000-8000-000000000001" &&
    options?.method === "PUT"
  ) {
    return Promise.resolve(
      json({
        item: {
          ...inventoryPayload().items[0],
          onHand: 5,
          updatedAt: completedAt,
        },
      }),
    );
  }
  return baseFetch(input, options);
}

function connectionPayload() {
  return {
    connections: [
      connection(
        "tcgplayer-main",
        "tcgplayer",
        "TCGplayer",
        "TCGplayer Store",
        ["order-pages", "inventory-reader", "inventory-mutator", "repricing"],
      ),
      connection("manapool-main", "manapool", "ManaPool", "ManaPool Store", [
        "order-pages",
        "inventory-reader",
        "inventory-mutator",
      ]),
    ],
    completedAt,
  };
}

function connection(
  connectionId: string,
  providerId: string,
  providerLabel: string,
  connectionLabel: string,
  supportedFacets: readonly string[],
) {
  return {
    descriptor: {
      connectionId,
      providerId,
      providerLabel,
      connectionLabel,
    },
    enabled: true,
    supportedFacets,
    health: { state: "connected", checkedAt: completedAt },
  };
}

function inventoryPayload() {
  const connections = connectionPayload().connections;
  const tcgplayer = connections[0];
  const manapool = connections[1];
  if (tcgplayer === undefined || manapool === undefined) {
    throw new Error("Expected two synthetic marketplace connections.");
  }
  return {
    items: [
      {
        localInventoryId: "00000000-0000-4000-8000-000000000001",
        displayName: "Lightning Bolt",
        onHand: 3,
        catalogIdentities: [
          {
            namespace: "tcgplayer.sku",
            value: "101",
            precision: "exact-variant",
          },
        ],
        attributes: {
          productLine: "Magic: The Gathering",
          set: "Masters",
          condition: "Near Mint",
        },
        createdAt: completedAt,
        updatedAt: completedAt,
      },
      {
        localInventoryId: "00000000-0000-4000-8000-000000000002",
        displayName: "Unlisted Card",
        onHand: 1,
        catalogIdentities: [
          {
            namespace: "tcgplayer.sku",
            value: "999",
            precision: "exact-variant",
          },
        ],
        attributes: { set: "Local Set", condition: "Near Mint" },
        createdAt: completedAt,
        updatedAt: completedAt,
      },
    ],
    listings: [
      {
        descriptor: tcgplayer.descriptor,
        localInventoryId: "00000000-0000-4000-8000-000000000001",
        item: {
          inventoryKey: "sku/101/channel/0",
          displayName: "Lightning Bolt",
          quantity: 3,
          price: { currency: "USD", minorUnits: 199 },
          catalogIdentities: [
            {
              namespace: "tcgplayer.sku",
              value: "101",
              precision: "exact-variant",
            },
          ],
          attributes: {
            productLine: "Magic: The Gathering",
            set: "Masters",
            condition: "Near Mint",
          },
          quantityMutation: "increase-or-clear",
          priceMutable: true,
        },
      },
      {
        descriptor: manapool.descriptor,
        item: {
          inventoryKey: "sku/MP-SKU/item/22",
          displayName: "Booster Box",
          quantity: 2,
          price: { currency: "USD", minorUnits: 11999 },
          catalogIdentities: [
            {
              namespace: "manapool.sku",
              value: "MP-SKU",
              precision: "exact-variant",
            },
          ],
          attributes: { productType: "Sealed", set: "Synthetic Set" },
          quantityMutation: "absolute",
          priceMutable: true,
        },
      },
    ],
    issues: [],
    completedAt,
  };
}
