import { expect, test } from "@playwright/test";

test("shows a printable master pull list with card metadata", async ({
  page,
}, testInfo) => {
  await page.goto("/#orders/pull-list");

  await expect(
    page.getByRole("heading", { name: "Master pull list" }),
  ).toBeVisible();
  await expect(page.getByText("Session orders", { exact: true })).toBeVisible();
  await expect(page.getByText("Lightning Bolt", { exact: true })).toBeVisible();
  await expect(page.getByText("Counterspell", { exact: true })).toBeVisible();
  await expect(page.getByText("Red", { exact: true })).toBeVisible();
  await expect(page.getByText("Blue", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print" })).toBeEnabled();
  const foilRow = page.locator(".pull-list-row--foil").filter({
    hasText: "Counterspell",
  });
  await expect(foilRow).toHaveCount(1);
  await expect(foilRow.locator(".pull-list-foil__badge")).toHaveText("FOIL");
  await expect(foilRow.locator(".pull-list-condition--foil")).toContainText(
    "Near Mint Foil",
  );

  const productNames = page.locator(
    ".pull-list-table tbody .pull-list-product strong",
  );
  await expect(productNames).toHaveText(["Lightning Bolt", "Counterspell"]);
  await page.getByRole("button", { name: "Sort by product" }).click();
  await expect(productNames).toHaveText(["Counterspell", "Lightning Bolt"]);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Master pull list" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Sort by product, currently ascending",
    }),
  ).toBeVisible();
  await expect(productNames).toHaveText(["Counterspell", "Lightning Bolt"]);

  await page
    .locator(".pull-list-table tbody tr")
    .last()
    .evaluate((row) => {
      const body = row.parentElement;
      if (body === null) throw new Error("Pull-list table body was not found.");
      for (let index = 0; index < 80; index += 1) {
        body.append(row.cloneNode(true));
      }
    });
  const summary = page.locator(".pull-list-summary");
  const summaryBeforeScroll = await summary.boundingBox();
  await page.locator(".pull-list-region").evaluate((region) => {
    region.scrollTop = region.scrollHeight;
  });
  await expect
    .poll(() =>
      page.locator(".pull-list-region").evaluate((region) => region.scrollTop),
    )
    .toBeGreaterThan(0);
  await expect(summary).toBeVisible();
  expect(await summary.boundingBox()).toEqual(summaryBeforeScroll);
  expect(
    await page
      .locator(".pull-list-page .page-body")
      .evaluate((body) => body.scrollTop),
  ).toBe(0);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Master pull list" }),
  ).toBeVisible();
  await expect(productNames).toHaveText(["Counterspell", "Lightning Bolt"]);

  await page
    .getByRole("checkbox", { name: "Mark Lightning Bolt as pulled" })
    .click();
  const pulledLightning = page.getByRole("checkbox", {
    name: "Mark Lightning Bolt as not pulled",
  });
  await expect(pulledLightning).toBeChecked();
  await expect(
    page.getByText("Cards to pull").locator("..").locator("strong"),
  ).toHaveText("2");

  await page.getByRole("checkbox", { name: "Show pulled (1)" }).uncheck();
  await expect(productNames).toHaveText(["Counterspell"]);
  await page.getByRole("checkbox", { name: "Show pulled (1)" }).check();
  await expect(productNames).toHaveText(["Counterspell", "Lightning Bolt"]);
  await expect(pulledLightning).toBeChecked();

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
    "2 ready orders · 2 cards · 1 unique SKUs",
  );
  await expect(page.locator(".pull-list-row--pulled")).toBeHidden();
  await expect(foilRow).toBeVisible();
  await expect(foilRow.locator(".pull-list-foil__badge")).toBeVisible();
  await expect(foilRow.locator(".pull-list-foil")).toHaveCSS(
    "font-weight",
    "900",
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
