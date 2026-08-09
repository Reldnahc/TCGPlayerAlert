import { expect, test } from "@playwright/test";

test("shows a printable ready-order pull list with card metadata", async ({
  page,
}, testInfo) => {
  await page.goto("/#orders/123-4567890-001/pull-list");

  await expect(page.getByRole("heading", { name: "Pull list" })).toBeVisible();
  await expect(page.getByText("Lightning Bolt", { exact: true })).toBeVisible();
  await expect(page.getByText("Counterspell", { exact: true })).toBeVisible();
  await expect(page.getByText("Red", { exact: true })).toBeVisible();
  await expect(page.getByText("Blue", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print" })).toBeEnabled();

  await page.screenshot({
    path: testInfo.outputPath("pull-list.png"),
    fullPage: true,
  });

  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".page-header__actions")).toBeHidden();
  await expect(page.locator(".pull-list-table")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("pull-list-print.png"),
    fullPage: true,
  });
});
