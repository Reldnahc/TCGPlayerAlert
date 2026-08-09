import { createCanvas } from "@napi-rs/canvas";
import { expect, test } from "@playwright/test";
import { createShipmentAprilTag, shipmentTagId } from "../../src/index.js";

const syntheticOrderNumber = "123-4567890-001";

test("the built Scanner detects an AprilTag and resolves its ready order", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/#scanner");

  await expect(
    page.getByRole("heading", { name: "Shipment scanner", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Scan lab" })).toHaveCount(0);
  await expect(page.getByText("Review before shipping")).toBeVisible();
  await expect(
    page
      .getByLabel("Shipment scanner status")
      .locator("div")
      .filter({ hasText: "Ready orders" })
      .getByText("2", { exact: true }),
  ).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-shipment-tag.png",
    mimeType: "image/png",
    buffer: renderMarker(shipmentTagId(syntheticOrderNumber)),
  });

  await expect(page.getByText("Exact ready-order match")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Alex Morgan/u)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark shipped" }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});

function renderMarker(tagId: number): Buffer {
  const marker = createShipmentAprilTag(tagId);
  const modules = marker.rows.length + marker.quietZoneModules * 2;
  const modulePixels = 48;
  const canvas = createCanvas(modules * modulePixels, modules * modulePixels);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  for (let row = 0; row < marker.rows.length; row += 1) {
    const markerRow = marker.rows[row];
    if (markerRow === undefined) continue;
    for (let column = 0; column < markerRow.length; column += 1) {
      if (markerRow[column] !== "1") continue;
      context.fillRect(
        (column + marker.quietZoneModules) * modulePixels,
        (row + marker.quietZoneModules) * modulePixels,
        modulePixels,
        modulePixels,
      );
    }
  }
  return canvas.toBuffer("image/png");
}
