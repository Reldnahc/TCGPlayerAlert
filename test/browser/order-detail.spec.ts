import { expect, test } from "@playwright/test";

test("opens the internal order workspace from an order number", async ({
  page,
}, testInfo) => {
  await page.goto("/#orders");

  const orderNumber = page.getByRole("link", { name: "123-4567890-001" });
  await expect(orderNumber).toHaveCSS("white-space", "nowrap");
  await expect(page.locator(".orders-col-number")).toHaveCSS("width", "145px");
  await orderNumber.click();

  await expect(
    page.getByRole("heading", { name: "Order 123-4567890-001" }),
  ).toBeVisible();
  await expect(page.getByText("125 Example Avenue")).toBeVisible();
  await expect(
    page.getByText("Lightning Bolt · Masters 25 · Lightly Played"),
  ).toBeVisible();
  await expect(page.getByText("No tracking has been added")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open in TCGplayer" }),
  ).toHaveAttribute(
    "href",
    "https://sellerportal.tcgplayer.com/orders/123-4567890-001",
  );
  await expect(page.locator(".order-detail-layout")).toHaveCSS(
    "overflow-x",
    "auto",
  );

  await page.getByRole("button", { name: "Refund" }).click();
  await expect(
    page.getByText("Review is always required before money is returned."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Partial refund" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Synthetic refund");
  await page.getByRole("spinbutton", { name: "Shipping" }).fill("0.49");
  await page
    .getByRole("spinbutton", {
      name: /Lightning Bolt/u,
    })
    .fill("1.00");
  await page.getByRole("button", { name: "Review refund" }).click();

  await expect(page.getByText("Confirm this partial refund")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm $1.49 refund" }),
  ).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("order-detail.png"),
    fullPage: true,
  });
});
