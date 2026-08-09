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
  expect(pageErrors).toEqual([]);
});
