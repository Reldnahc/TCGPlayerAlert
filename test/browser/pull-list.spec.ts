import { expect, test } from "@playwright/test";

test("shows a printable master pull list with card metadata", async ({
  page,
}, testInfo) => {
  await page.goto("/#orders/pull-list");

  await expect(
    page.getByRole("heading", { name: "Master pull list" }),
  ).toBeVisible();
  await expect(page.getByText("Ready orders", { exact: true })).toBeVisible();
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
  await expect(page.locator(".pull-list-summary")).toBeHidden();
  await expect(page.locator(".pull-list-sheet__header")).toBeHidden();
  await expect(page.locator(".pull-list-print-meta")).toHaveText(
    "2 ready orders · 5 cards · 2 unique SKUs",
  );
  await expect(page.locator(".pull-list-table")).toBeVisible();
  await expect(page.locator(".pull-list-table tbody td").first()).toHaveCSS(
    "color",
    "rgb(0, 0, 0)",
  );
  await expect(page.locator(".pull-list-table tbody td").first()).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.screenshot({
    path: testInfo.outputPath("pull-list-print.png"),
    fullPage: true,
  });
});
