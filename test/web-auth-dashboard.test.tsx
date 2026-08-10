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

afterEach(resetWebUiTest);

describe("authentication and dashboard", () => {
  it("keeps seller requests idle while disconnected", async () => {
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
      if (path === "/api/settings") return Promise.resolve(json(settings));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(
      await screen.findByText("Connect TCGplayer to load orders"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      requestedPaths.filter((path) => path === "/api/auth/status"),
    ).toHaveLength(1);
    expect(
      requestedPaths.filter(
        (path) =>
          path.startsWith("/api/orders") || path.startsWith("/api/messages"),
      ),
    ).toHaveLength(0);
    expect(
      intervalSpy.mock.calls.filter(([, timeout]) =>
        [2_000, 5_000, 60_000].includes(Number(timeout)),
      ),
    ).toHaveLength(0);
  });

  it("logs out from the authenticated sidebar footer", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByText("Disconnected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === "/api/auth/disconnect",
      ),
    ).toHaveLength(1);
  });

  it("turns an authentication rejection into one stable expired state", async () => {
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
    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "TCGplayer session expired",
      }),
    ).toBeTruthy();
    await waitFor(() => expect(statusReads).toBe(2));
    expect(orderReads).toBe(1);
    expect(screen.queryByText("Synthetic expired session.")).toBeNull();
  });

  it("starts browser pairing from a disconnected connection banner", async () => {
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
        if (path === "/api/auth/pairing") {
          return Promise.resolve(
            json({
              pairingCode: "ABCD-EF01-2345-6789",
              expiresAt: "2026-08-08T12:10:00.000Z",
              port: 47831,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const heading = await screen.findByRole("heading", {
      name: "Connect TCGplayer",
    });
    const panel = heading.closest("section");
    if (panel === null) throw new Error("Missing seller connection panel.");
    await user.click(within(panel).getByRole("button", { name: "Connect" }));

    expect(await within(panel).findByText("ABCD-EF01-2345-6789")).toBeTruthy();
    expect(within(panel).getByText("47831")).toBeTruthy();
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
              snapshot: {
                orders: readyReads === 1 ? [] : [synchronizedOrder],
                fetchedAt: `2026-08-07T12:0${String(readyReads)}:00.000Z`,
              },
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

  it("starts fulfillment synchronization only after the operator selects Sync now", async () => {
    const synchronizedOrder = {
      orderNumber: "SYNTHETIC-EXPLICIT-SYNC",
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
          return Promise.resolve(json({ snapshot: null }));
        }
        if (path === "/api/orders/sync") {
          return Promise.resolve(
            json({
              orders: [synchronizedOrder],
              fetchedAt: "2026-08-07T12:05:00.000Z",
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
          ([input]) =>
            requestPath(input) === "/api/orders?status=ready-to-ship",
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
              snapshot: {
                orders: [],
                fetchedAt: "2026-08-07T12:01:00.000Z",
              },
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
      "Scanner",
      "Messages",
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
        if (path === "/api/orders?status=ready-to-ship") {
          return Promise.resolve(
            json({
              snapshot: {
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
              },
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
});
