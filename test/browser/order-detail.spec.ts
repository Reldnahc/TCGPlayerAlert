import { expect, test } from "@playwright/test";

test("opens the internal order workspace from an order number", async ({
  page,
}, testInfo) => {
  await page.goto("/#orders");

  const orderNumber = page.getByRole("link", { name: "123-4567890-001" });
  await expect(orderNumber).toHaveCSS("white-space", "nowrap");
  await orderNumber.click();

  await expect(
    page.getByRole("heading", { name: "Order 123-4567890-001" }),
  ).toBeVisible();
  await expect(page.getByText("125 Example Avenue")).toBeVisible();
  await expect(
    page.getByText("Lightning Bolt · Masters 25 · Lightly Played"),
  ).toBeVisible();
  await expect(page.getByText("No tracking has been added")).toBeVisible();
  await expect(page).toHaveURL(/#orders\/tcgplayer-main\/123-4567890-001$/u);
  await expect(
    page.getByText("Preview shop", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tracking", exact: true }).click();
  await expect(
    page.getByRole("textbox", {
      name: "Tracking number for order 123-4567890-001",
    }),
  ).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("order-detail.png"),
    fullPage: true,
  });
});
