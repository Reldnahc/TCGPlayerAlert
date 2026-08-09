import { expect, test } from "@playwright/test";

test("the built Scan lab initializes AprilTag WASM and detects its preview", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/#scan-lab");

  await expect(
    page.getByRole("heading", { name: "Scan lab", exact: true }),
  ).toBeVisible();
  const scanPreview = page.getByRole("button", { name: "Scan preview" });
  await scanPreview.click();
  await expect(
    page.getByText("Would mark shipped", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });

  await scanPreview.click();
  await expect(
    page.getByText("Already simulated", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Basket of 5/u }).click();
  await expect(
    page.getByRole("button", { name: "Label 1: Avery Fixture" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Label 5: Emery Mock" }).click();
  await expect(page.getByText("52 Simulation Circle")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Print all 5 labels" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Scanner" }).click();
  await expect(
    page.getByRole("heading", { name: "Shipment scanner", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Review before shipping")).toBeVisible();
  await expect(
    page
      .getByLabel("Shipment scanner status")
      .locator("div")
      .filter({ hasText: "Ready orders" })
      .getByText("2", { exact: true }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
