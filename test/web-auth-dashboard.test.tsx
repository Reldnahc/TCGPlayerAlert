// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/preact";
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
import { marketplaceOrder } from "./marketplace-ui-fixtures.js";

afterEach(resetWebUiTest);

describe("authentication and dashboard", () => {
  it("saves API marketplace credentials through Settings without retaining secrets in the browser", async () => {
    const savedBodies: unknown[] = [];
    const endpoint = "/api/marketplace-connections/manapool-main/credentials";
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        if (requestPath(input) === endpoint && options?.method === "PUT") {
          if (typeof options.body !== "string") {
            throw new Error("Expected a JSON request body.");
          }
          savedBodies.push(JSON.parse(options.body) as unknown);
          return Promise.resolve(
            json({
              connectionId: "manapool-main",
              configured: true,
              protectedStorage: true,
              fields: [
                {
                  id: "email",
                  label: "Seller email",
                  inputType: "email",
                  configured: true,
                  source: "settings",
                },
                {
                  id: "access-token",
                  label: "Seller API code",
                  inputType: "password",
                  configured: true,
                  source: "settings",
                },
              ],
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("link", { name: "Settings" }));
    const email = await screen.findByLabelText(/Seller email/u);
    const apiCode = screen.getByLabelText(/Seller API code/u);
    await user.type(email, "seller@example.com");
    await user.type(apiCode, "private-api-code");
    await user.click(screen.getByRole("button", { name: "Save credentials" }));

    expect(
      await screen.findByText(
        "Marketplace credentials saved securely and applied.",
      ),
    ).toBeTruthy();
    expect(savedBodies).toEqual([
      {
        values: {
          email: "seller@example.com",
          "access-token": "private-api-code",
        },
      },
    ]);
    expect(document.body.textContent).not.toContain("private-api-code");
    expect(document.body.textContent).not.toContain("seller@example.com");
  });

  it("configures Discord notifications without retaining the webhook in the browser", async () => {
    const fetchMock = vi.fn(baseFetch);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByText("disconnected");
    const webhook = screen.getByLabelText(/Webhook URL/u);
    if (!(webhook instanceof HTMLInputElement)) {
      throw new Error("Expected the Discord webhook input.");
    }
    const secret =
      "https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz012345";
    await user.type(webhook, secret);
    await user.click(screen.getByRole("button", { name: "Save webhook" }));

    expect(
      await screen.findByText("Discord webhook saved securely."),
    ).toBeTruthy();
    expect(webhook.value).toBe("");
    expect(document.body.textContent).not.toContain(secret);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    expect(
      await screen.findByText("Test notification delivered."),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("checkbox", {
        name: /^Enable Discord notifications/u,
      }),
    );
    expect(screen.getByText("Unsaved configuration changes")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/discord/connect",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps provider-neutral orders available while legacy TCG auth is disconnected", async () => {
    const requestedPaths: string[] = [];
    const intervalSpy = vi.spyOn(window, "setInterval");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      requestedPaths.push(path);
      if (path === "/api/auth/status") {
        return Promise.resolve(
          json({
            state: "disconnected",
            automaticRenewal: false,
            protectedStorage: true,
          }),
        );
      }
      if (path === "/api/marketplace-connections") {
        return Promise.resolve(
          json({
            connections: [],
            completedAt: "2026-08-07T12:00:00.000Z",
          }),
        );
      }
      if (path === "/api/orders/ready") {
        return Promise.resolve(
          json({
            data: [],
            issues: [],
            completedAt: "2026-08-07T12:00:00.000Z",
          }),
        );
      }
      if (path === "/api/settings") return Promise.resolve(json(settings));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText("No orders are ready to ship")).toBeTruthy();
    expect(
      requestedPaths.filter((path) => path === "/api/auth/status"),
    ).toHaveLength(1);
    expect(
      requestedPaths.filter((path) => path === "/api/orders/ready"),
    ).toHaveLength(1);
    expect(
      requestedPaths.filter((path) => path.startsWith("/api/messages")),
    ).toHaveLength(0);
    expect(
      intervalSpy.mock.calls.filter(([, timeout]) =>
        [2_000, 60_000].includes(Number(timeout)),
      ),
    ).toHaveLength(0);
  });

  it("disconnects a provider from its settings card", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        if (requestPath(input) === "/api/auth/disconnect") {
          return Promise.resolve(
            json({
              state: "disconnected",
              automaticRenewal: false,
              protectedStorage: true,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "TCGplayer connected" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(
      await screen.findByRole("heading", { name: "Connect TCGplayer" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/auth/disconnect",
      ),
    ).toHaveLength(1);
  });

  it("turns an authentication rejection into one stable non-blocking expired state", async () => {
    let statusReads = 0;
    let orderReads = 0;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/auth/status") {
          statusReads += 1;
          return Promise.resolve(
            json(
              statusReads === 1
                ? {
                    state: "connected",
                    source: "browser",
                    automaticRenewal: true,
                    protectedStorage: true,
                  }
                : {
                    state: "expired",
                    automaticRenewal: true,
                    protectedStorage: true,
                  },
            ),
          );
        }
        if (path.startsWith("/api/orders")) {
          orderReads += 1;
          return Promise.resolve(
            json(
              {
                code: "AUTHENTICATION_REQUIRED",
                message: "Synthetic expired session.",
              },
              401,
            ),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeTruthy();
    await waitFor(() => expect(statusReads).toBe(2));
    expect(orderReads).toBe(1);
    expect(screen.queryByText("Synthetic expired session.")).toBeNull();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", {
        name: "TCGplayer session expired",
      }),
    ).toBeTruthy();
  });

  it("does not globally block marketplace workspaces for a disconnected legacy session", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/auth/status") {
          return Promise.resolve(
            json({
              state: "disconnected",
              automaticRenewal: false,
              protectedStorage: true,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Orders" }));
    expect(await screen.findByRole("heading", { name: "Orders" })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "Connect TCGplayer" }),
    ).toBeTruthy();
  });

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
    const synchronizedOrder = marketplaceOrder({
      remoteId: "SYNTHETIC-SCHEDULED",
      subtotalMinorUnits: 1_000,
      shippingMinorUnits: 149,
      totalMinorUnits: 1_149,
    });
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders/ready") {
          readyReads += 1;
          return Promise.resolve(
            json({
              data: readyReads === 1 ? [] : [synchronizedOrder],
              issues: [],
              completedAt: `2026-08-07T12:0${String(readyReads)}:00.000Z`,
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
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/orders/sync",
      ),
    ).toBe(false);
  });

  it("refreshes all orders after the scanner changes the local ready snapshot", async () => {
    window.location.hash = "orders";
    let readyReads = 0;
    let allReads = 0;
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
    const readyOrder = marketplaceOrder({
      remoteId: "SYNTHETIC-SCANNER-SHIPMENT",
      subtotalMinorUnits: 1_000,
      shippingMinorUnits: 149,
      totalMinorUnits: 1_149,
    });
    const shippedOrder = marketplaceOrder({
      remoteId: readyOrder.ref.remoteId,
      providerStatus: "Shipped",
      providerStatusCode: "Shipped",
      lifecycle: "shipped",
      subtotalMinorUnits: 1_000,
      shippingMinorUnits: 149,
      totalMinorUnits: 1_149,
      availableActions: ["view-detail", "packing-slip", "pirate-ship"],
    });
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders/ready") {
          readyReads += 1;
          return Promise.resolve(
            json({
              data: readyReads === 1 ? [readyOrder] : [],
              issues: [],
              completedAt: `2026-08-07T12:0${String(readyReads)}:00.000Z`,
            }),
          );
        }
        if (path === "/api/orders?" || path === "/api/orders?refresh=1") {
          allReads += 1;
          return Promise.resolve(
            json({
              data: allReads === 1 ? [readyOrder] : [shippedOrder],
              issues: [],
              completedAt: `2026-08-07T12:1${String(allReads)}:00.000Z`,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const orderRow = () =>
      screen
        .getByRole("link", { name: readyOrder.displayOrderNumber })
        .closest("tr");
    await screen.findByText("Ready to Ship");
    await waitFor(() => expect(readyReads).toBe(1));
    await waitFor(() => expect(allReads).toBe(1));
    await waitFor(() => expect(snapshotTick).toBeDefined());

    await act(async () => {
      snapshotTick?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        within(orderRow() as HTMLElement).getByText("Shipped"),
      ).toBeTruthy(),
    );
    expect(allReads).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/orders?refresh=1",
      ),
    ).toHaveLength(1);

    await act(async () => {
      snapshotTick?.();
      await Promise.resolve();
    });
    expect(allReads).toBe(2);
  });

  it("starts fulfillment synchronization only after the operator selects Sync now", async () => {
    const synchronizedOrder = marketplaceOrder({
      remoteId: "SYNTHETIC-EXPLICIT-SYNC",
      subtotalMinorUnits: 1_000,
      shippingMinorUnits: 149,
      totalMinorUnits: 1_149,
    });
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders/ready") {
          return Promise.resolve(
            json({
              data: [],
              issues: [],
              completedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        if (path === "/api/orders/sync") {
          return Promise.resolve(
            json({
              data: [synchronizedOrder],
              issues: [],
              completedAt: "2026-08-07T12:05:00.000Z",
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
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) => requestPath(input) === "/api/orders/ready",
        ),
      ).toBe(true),
    );
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/orders/sync",
      ),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Sync now" }));

    expect(await screen.findByText("SYNTHETIC-EXPLICIT-SYNC")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input, options]) =>
          requestPath(input) === "/api/orders/sync" &&
          options?.method === "POST",
      ),
    ).toBe(true);
  });

  it("keeps the dashboard ready queue separate from the all-orders view", async () => {
    window.location.hash = "orders";
    const allOnlyOrder = marketplaceOrder({
      remoteId: "SYNTHETIC-ALL-ONLY",
      subtotalMinorUnits: 1_000,
      shippingMinorUnits: 149,
      totalMinorUnits: 1_149,
    });
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/orders?") {
          return Promise.resolve(
            json({
              data: [allOnlyOrder],
              issues: [],
              completedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        if (path === "/api/orders/ready") {
          return Promise.resolve(
            json({
              data: [],
              issues: [],
              completedAt: "2026-08-07T12:01:00.000Z",
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
    expect(
      screen
        .getByRole("link", { name: "Master pull list" })
        .getAttribute("href"),
    ).toBe("#orders/pull-list");
    await user.click(screen.getByRole("link", { name: "Dashboard" }));

    expect(await screen.findByText("No orders are ready to ship")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Master pull list" })
        .getAttribute("href"),
    ).toBe("#orders/pull-list");
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/orders/ready",
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
      "Inventory",
      "Repricing",
      "Orders",
      "Scanner",
      "Labels",
      "Messages",
      "Payments",
      "Feedback",
      "Jobs",
      "Settings",
    ]);
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "ManaPool" }),
    ).toBeTruthy();
    expect(await screen.findByLabelText(/Seller email/u)).toBeTruthy();
    expect(screen.getByLabelText(/Seller API code/u)).toBeTruthy();
    expect(
      screen.getAllByText("Using the test environment fallback"),
    ).toHaveLength(2);
    expect(screen.queryByText("Unsaved configuration changes")).toBeNull();
    await user.click(screen.getByRole("button", { name: "General" }));
    const shipmentConfirmation = screen.getByRole("checkbox", {
      name: /Confirm before marking shipped/u,
    });
    const interval = screen.getByRole("spinbutton");
    expect((shipmentConfirmation as HTMLInputElement).checked).toBe(true);
    await user.click(shipmentConfirmation);
    await user.clear(interval);
    await user.type(interval, "17");
    await user.click(screen.getByRole("button", { name: "Pull list" }));
    const landGrouping = screen.getByRole("checkbox", {
      name: /Group lands as Land/u,
    });
    const multicolorGrouping = screen.getByRole("checkbox", {
      name: /Group color pairs as Multicolored/u,
    });
    const binning = screen.getByRole("checkbox", {
      name: /Assign cards to bins/u,
    });
    expect((landGrouping as HTMLInputElement).checked).toBe(true);
    expect((multicolorGrouping as HTMLInputElement).checked).toBe(true);
    expect((binning as HTMLInputElement).checked).toBe(true);
    expect(screen.getByDisplayValue("Magic: The Gathering")).toBeTruthy();
    expect(screen.getByDisplayValue("power")).toBeTruthy();
    await user.click(landGrouping);
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
      masterPullList: {
        groupLands: false,
        groupMulticolored: true,
      },
    });
  });

  it("removes a tracked $50 order from Dashboard immediately after shipment", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const readyOrder = marketplaceOrder({
      remoteId: "SYNTHETIC-ORDER-1",
      subtotalMinorUnits: 4_851,
      shippingMinorUnits: 149,
      totalMinorUnits: 5_000,
    });
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
            "/api/connections/tcgplayer-main/orders/SYNTHETIC-ORDER-1/tracking" &&
          options?.method === "POST"
        ) {
          return Promise.resolve(
            json({
              ref: readyOrder.ref,
              outcome: "applied",
            }),
          );
        }
        if (
          path ===
            "/api/connections/tcgplayer-main/orders/SYNTHETIC-ORDER-1/mark-shipped" &&
          options?.method === "POST"
        ) {
          return Promise.resolve(
            json({ ref: readyOrder.ref, outcome: "applied" }),
          );
        }
        if (path === "/api/orders/ready") {
          return Promise.resolve(
            json({
              data: [readyOrder],
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

    await user.click(await screen.findByRole("button", { name: "Tracking" }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Tracking number for order SYNTHETIC-ORDER-1",
      }),
      "synthetic-tracking",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/connections/tcgplayer-main/orders/SYNTHETIC-ORDER-1/tracking",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    await user.click(
      await screen.findByRole("button", { name: "Mark shipped" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/connections/tcgplayer-main/orders/SYNTHETIC-ORDER-1/mark-shipped",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestPath(input) === "/api/orders/ready",
        ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByText("SYNTHETIC-ORDER-1")).toBeNull(),
    );
  });

  it("announces scanner shipments and removes them from Dashboard immediately", async () => {
    const readyOrder = marketplaceOrder({
      remoteId: "SCANNED-ORDER-1",
      displayOrderNumber: "SCANNED-ORDER-1",
    });
    let scannerReads = 0;
    const resultAt = new Date(Date.now() + 1_000).toISOString();
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/settings") {
          return Promise.resolve(
            json({
              ...settings,
              shipmentScanner: {
                ...settings.shipmentScanner,
                enabled: true,
                automaticallyMarkShipped: true,
              },
            }),
          );
        }
        if (path === "/api/orders/ready") {
          return Promise.resolve(
            json({
              data: [readyOrder],
              issues: [],
              completedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        if (path === "/api/shipment-scanner") {
          scannerReads += 1;
          return Promise.resolve(
            json({
              enabled: true,
              automaticallyMarkShipped: true,
              soundEnabled: false,
              readyOrderCount: scannerReads === 1 ? 1 : 0,
              readyTagIds: scannerReads === 1 ? [7] : [],
              conflictingTagCount: 0,
              reviewRequiredCount: 0,
              issues: [],
              backgroundCamera: {
                state: "running",
                deviceId: "synthetic-camera",
                consensus: {
                  tagId: null,
                  matchingReads: 0,
                  requiredReads: 0,
                },
                ...(scannerReads === 1
                  ? {}
                  : {
                      lastResultAt: resultAt,
                      lastResult: {
                        state: "shipped",
                        tagId: 7,
                        order: readyOrder,
                        outcome: "applied",
                      },
                    }),
              },
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const row = await screen.findByRole("row", { name: /SCANNED-ORDER-1/u });
    expect(row).toBeTruthy();
    expect(
      await screen.findByText(
        "Order SCANNED-ORDER-1 marked shipped from scanner.",
        {},
        { timeout: 2_000 },
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("row", { name: /SCANNED-ORDER-1/u }),
      ).toBeNull(),
    );
  });
});
