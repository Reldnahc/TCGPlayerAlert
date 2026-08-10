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

describe("payments", () => {
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
              experience: "money-movement",
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

  it("shows the legacy estimated future payments and past payment history", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/payments?page=")) {
          const page = Number(
            new URL(path, "http://localhost").searchParams.get("page"),
          );
          return Promise.resolve(
            json({
              experience: "legacy",
              page,
              totalPages: 2,
              upcomingPayments: [
                {
                  estimatedArrivalDate: null,
                  initiatedDate: null,
                  ordersCount: 1,
                  totalSales: 2_000,
                  totalFees: 100,
                  refundedOrders: 0,
                  refundedFees: 0,
                  adjustments: 0,
                  amount: 1_900,
                },
                {
                  estimatedArrivalDate: "2026-08-15",
                  initiatedDate: "2026-08-13",
                  ordersCount: 2,
                  totalSales: 6_000,
                  totalFees: 300,
                  refundedOrders: 0,
                  refundedFees: 0,
                  adjustments: 0,
                  amount: 5_700,
                },
              ],
              pastPayments: [
                {
                  estimatedArrivalDate: "2026-08-12",
                  initiatedDate: "2026-08-10",
                  ordersCount: 4,
                  totalSales: 13_000,
                  totalFees: 655,
                  refundedOrders: 0,
                  refundedFees: 0,
                  adjustments: 0,
                  amount: 12_345,
                },
              ],
              fetchedAt: "2026-08-07T12:00:00.000Z",
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

    await user.click(screen.getByRole("link", { name: "Payments" }));

    expect(await screen.findByText("Estimated future payments")).toBeTruthy();
    expect(screen.getByText("Past payment history")).toBeTruthy();
    expect(screen.getAllByText("$57.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not scheduled").length).toBeGreaterThan(0);
    expect(screen.getByText("1 scheduled · 1 not scheduled")).toBeTruthy();
    expect(screen.getByText("$123.45")).toBeTruthy();
    expect(screen.queryByLabelText("Payout status")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open Seller Portal" })
        .getAttribute("href"),
    ).toBe("https://store.tcgplayer.com/admin/payment/sellerpayment");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText("Page 2 of 2", {
        selector: ".payment-pagination span",
      }),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/payments?page=2",
      ),
    ).toBe(true);
  });
});
