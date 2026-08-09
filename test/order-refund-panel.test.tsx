// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { SellerOrderStatus } from "tcgplayer-private-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiApiError, uiApi } from "../src/web/api.js";
import { OrderRefundPanel } from "../src/web/components/OrderRefundPanel.js";
import type { OrderDetail, RefundOptions } from "../src/web/contracts.js";
import { ToastProvider } from "../src/web/state/ToastContext.js";

const options: RefundOptions = {
  origins: [{ name: "Seller initiated", value: "SellerInitiated" }],
  reasons: [{ name: "Inventory issue", value: "Product - Inventory Issue" }],
};

const order: OrderDetail = {
  createdAt: "2026-08-07T12:00:00.000Z",
  status: "Ready to Ship",
  statusCode: SellerOrderStatus.ReadyToShip,
  orderChannel: "Marketplace",
  orderFulfillment: "Seller",
  orderNumber: "SYNTHETIC-REFUND-ORDER",
  sellerName: "Synthetic Seller",
  buyerName: "Synthetic Buyer",
  paymentType: "Credit card",
  pickupStatus: "Not requested",
  shippingType: "Standard",
  estimatedDeliveryDate: "2026-08-12T12:00:00.000Z",
  transaction: {
    productAmount: 12,
    shippingAmount: 1.49,
    grossAmount: 13.49,
    feeAmount: 1.5,
    netAmount: 11.99,
    directFeeAmount: 0,
    taxes: [],
  },
  shippingAddress: {
    recipientName: "Synthetic Buyer",
    addressOne: "125 Example Avenue",
    city: "Test City",
    territory: "IL",
    country: "US",
    postalCode: "60000",
  },
  products: [
    {
      name: "Synthetic Card",
      unitPrice: 6,
      extendedPrice: 12,
      quantity: 2,
      url: "https://www.example.test/product",
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel() {
  const onClose = vi.fn();
  const onSubmitted = vi.fn(() => Promise.resolve());
  render(
    <ToastProvider>
      <OrderRefundPanel
        order={order}
        options={options}
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    </ToastProvider>,
  );
  return { onClose, onSubmitted };
}

describe("order refund panel", () => {
  it("reviews and confirms an exact partial refund in separate steps", async () => {
    const refundOrder = vi.spyOn(uiApi, "refundOrder").mockResolvedValue({
      orderNumber: order.orderNumber,
      refundType: "partial",
      outcome: "submitted",
    });
    const { onClose, onSubmitted } = renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Partial refund" }));
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Synthetic refund",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Shipping" }),
      "0.49",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Synthetic Card" }),
      "1.00",
    );
    await user.click(screen.getByRole("button", { name: "Review refund" }));

    expect(refundOrder).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm this partial refund")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Confirm $1.49 refund" }),
    );

    await waitFor(() => expect(refundOrder).toHaveBeenCalledOnce());
    expect(refundOrder).toHaveBeenCalledWith(order.orderNumber, {
      type: "partial",
      origin: "SellerInitiated",
      reason: "Product - Inventory Issue",
      reasonText: "Synthetic refund",
      shippingRefundAmount: 0.49,
      products: [{ skuId: "456", refundAmount: 1 }],
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmitted).toHaveBeenCalledOnce();
  });

  it("blocks resubmission when the provider result is ambiguous", async () => {
    const refundOrder = vi
      .spyOn(uiApi, "refundOrder")
      .mockRejectedValue(
        new UiApiError("The request result is unknown.", "AMBIGUOUS_RESULT"),
      );
    renderPanel();
    const user = userEvent.setup();

    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Synthetic refund",
    );
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm full refund" }),
    );

    expect(await screen.findByText(/refund result is uncertain/i)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Confirm full refund" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(refundOrder).toHaveBeenCalledOnce();
  });
});
