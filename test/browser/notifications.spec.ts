import { expect, test } from "@playwright/test";

const SYNTHETIC_WEBHOOK =
  "https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz012345";

test("configures Discord delivery and notification events without exposing the webhook", async ({
  page,
}) => {
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Notifications" }).click();

  await expect(page.getByRole("heading", { name: "Discord" })).toBeVisible();
  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  const webhook = page.getByLabel(/Webhook URL/u);
  await webhook.fill(SYNTHETIC_WEBHOOK);
  await page.getByRole("button", { name: "Save webhook" }).click();

  await expect(page.getByText("Discord webhook saved securely.")).toBeVisible();
  await expect(webhook).toHaveValue("");
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SYNTHETIC_WEBHOOK);

  await page.getByRole("button", { name: "Send test" }).click();
  await expect(page.getByText("Test notification delivered.")).toBeVisible();
  await page.getByText("Enable Discord notifications", { exact: true }).click();
  await expect(page.getByText("Unsaved configuration changes")).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Unsaved configuration changes")).toBeHidden();
});
