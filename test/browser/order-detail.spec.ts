import { expect, test } from "@playwright/test";

test("opens the internal order workspace from an order number", async ({
  page,
}, testInfo) => {
  await page.goto("/#orders");

  await page.getByRole("link", { name: "123-4567890-001" }).click();

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

  await page.screenshot({
    path: testInfo.outputPath("order-detail.png"),
    fullPage: true,
  });
});
