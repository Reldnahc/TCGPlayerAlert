import { describe, expect, it, vi } from "vitest";
import { PaymentManagementService } from "../src/payment-management.js";

function fixture() {
  const getSellerPaymentExperience = vi.fn(() =>
    Promise.resolve("money-movement" as const),
  );
  const listLegacySellerPayments = vi.fn(() =>
    Promise.resolve({ page: 1, totalPages: 1, payments: [] }),
  );
  const listLegacyUpcomingSellerPayments = vi.fn(() =>
    Promise.resolve({ payments: [] }),
  );
  const listSellerPayouts = vi.fn((input: { readonly page?: number }) =>
    Promise.resolve({
      totalPayouts: 30,
      page: input.page ?? 1,
      pageSize: 25,
      payouts: [
        {
          payoutId: `payout-${String(input.page ?? 1)}`,
          referenceId: `SYNTHETIC-${String(input.page ?? 1)}`,
          createdAt: "2026-08-01T12:00:00.000Z",
          amount: 12_345,
          ordersCount: 4,
          status: "Succeeded",
        },
      ],
    }),
  );
  const getSellerUnpaidBalance = vi.fn(() =>
    Promise.resolve({ totalBalance: 2_500, transactions: [] }),
  );
  const getSellerPayout = vi.fn((input: { readonly referenceId: string }) =>
    Promise.resolve({
      payoutId: "payout-1",
      referenceId: input.referenceId,
      createdAt: "2026-08-01T12:00:00.000Z",
      amount: 12_345,
      status: "Succeeded",
      totalSales: 13_000,
      totalRefunds: 0,
      totalFees: -655,
      totalAdjustments: 0,
      transactions: [],
    }),
  );
  return {
    client: {
      getSellerPaymentExperience,
      listLegacySellerPayments,
      listLegacyUpcomingSellerPayments,
      listSellerPayouts,
      getSellerUnpaidBalance,
      getSellerPayout,
    },
    getSellerPaymentExperience,
    listLegacySellerPayments,
    listLegacyUpcomingSellerPayments,
    listSellerPayouts,
    getSellerUnpaidBalance,
    getSellerPayout,
  };
}

describe("PaymentManagementService", () => {
  it("caches payout pages and the shared unpaid balance independently", async () => {
    const current = fixture();
    const service = new PaymentManagementService({
      client: current.client,
      sellerKey: "seller_test",
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    });

    const first = await service.list();
    const cached = await service.list();
    const secondPage = await service.list({ page: 2 });

    expect(first).toMatchObject({
      experience: "money-movement",
      totalPayouts: 30,
      page: 1,
      unpaidBalance: { totalBalance: 2_500 },
      fetchedAt: "2026-08-07T12:00:00.000Z",
    });
    expect(cached).toEqual(first);
    expect(secondPage.page).toBe(2);
    expect(current.listSellerPayouts).toHaveBeenCalledTimes(2);
    expect(current.getSellerUnpaidBalance).toHaveBeenCalledOnce();
    expect(current.getSellerPaymentExperience).toHaveBeenCalledOnce();
    expect(current.listSellerPayouts).toHaveBeenLastCalledWith(
      {
        sellerKey: "seller_test",
        page: 2,
        pageSize: 25,
      },
      undefined,
    );
  });

  it("refreshes both overview reads only when explicitly forced", async () => {
    const current = fixture();
    const service = new PaymentManagementService({
      client: current.client,
      sellerKey: "seller_test",
    });

    await service.list();
    await service.list({ force: true });

    expect(current.listSellerPayouts).toHaveBeenCalledTimes(2);
    expect(current.getSellerUnpaidBalance).toHaveBeenCalledTimes(2);
    expect(current.getSellerPaymentExperience).toHaveBeenCalledTimes(2);
  });

  it("caches payout details and supports an explicit detail refresh", async () => {
    const current = fixture();
    const service = new PaymentManagementService({
      client: current.client,
      sellerKey: "seller_test",
    });

    await service.get("SYNTHETIC-1");
    await service.get("SYNTHETIC-1");
    await service.get("SYNTHETIC-1", { force: true });

    expect(current.getSellerPayout).toHaveBeenCalledTimes(2);
    expect(current.getSellerPaymentExperience).toHaveBeenCalledTimes(2);
    expect(current.getSellerPayout).toHaveBeenLastCalledWith(
      { sellerKey: "seller_test", referenceId: "SYNTHETIC-1" },
      undefined,
    );
  });

  it("rejects invalid paging and status values before a remote read", async () => {
    const current = fixture();
    const service = new PaymentManagementService({
      client: current.client,
      sellerKey: "seller_test",
    });

    await expect(service.list({ page: 0 })).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    await expect(
      service.list({ status: "Invented" as "Succeeded" }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(current.listSellerPayouts).not.toHaveBeenCalled();
    expect(current.getSellerPaymentExperience).not.toHaveBeenCalled();
  });

  it("loads and independently caches legacy upcoming and past payments", async () => {
    const getSellerPaymentExperience = vi.fn(() =>
      Promise.resolve("legacy" as const),
    );
    const listLegacySellerPayments = vi.fn(
      (input: { readonly page?: number }) =>
        Promise.resolve({
          page: input.page ?? 1,
          totalPages: 3,
          payments: [
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
        }),
    );
    const listLegacyUpcomingSellerPayments = vi.fn(() =>
      Promise.resolve({
        payments: [
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
      }),
    );
    const current = fixture();
    const service = new PaymentManagementService({
      client: {
        ...current.client,
        getSellerPaymentExperience,
        listLegacySellerPayments,
        listLegacyUpcomingSellerPayments,
      },
      sellerKey: "seller_test",
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    });

    const first = await service.list();
    const secondPage = await service.list({ page: 2 });

    expect(first).toMatchObject({
      experience: "legacy",
      page: 1,
      totalPages: 3,
      upcomingPayments: [{ amount: 5_700 }],
      pastPayments: [{ amount: 12_345 }],
    });
    expect(secondPage).toMatchObject({ experience: "legacy", page: 2 });
    expect(getSellerPaymentExperience).toHaveBeenCalledOnce();
    expect(listLegacySellerPayments).toHaveBeenCalledTimes(2);
    expect(listLegacyUpcomingSellerPayments).toHaveBeenCalledOnce();
    expect(current.listSellerPayouts).not.toHaveBeenCalled();
    expect(current.getSellerUnpaidBalance).not.toHaveBeenCalled();
  });

  it("does not invent Money Movement filters or details for legacy payments", async () => {
    const current = fixture();
    const service = new PaymentManagementService({
      client: {
        ...current.client,
        getSellerPaymentExperience: vi.fn(() =>
          Promise.resolve("legacy" as const),
        ),
      },
      sellerKey: "seller_test",
    });

    await expect(service.list({ status: "Succeeded" })).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    await expect(service.get("SYNTHETIC-1")).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(current.getSellerPayout).not.toHaveBeenCalled();
  });
});
