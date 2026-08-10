import { expect, test } from "@playwright/test";

const workspaces = [
  { route: "dashboard", label: "Dashboard" },
  { route: "add-cards", label: "Add cards" },
  { route: "orders", label: "Orders" },
  { route: "scanner", label: "Shipment scanner", navLabel: "Scanner" },
  { route: "messages", label: "Messages" },
  { route: "payments", label: "Payments" },
  { route: "feedback", label: "Feedback" },
  { route: "inventory", label: "Inventory" },
  { route: "settings", label: "Settings" },
  { route: "jobs", label: "Jobs" },
] as const;

test("loads every operator workspace through the application shell", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/#dashboard");

  await expect(page.locator(".app-shell")).toHaveCSS("display", "grid");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();

  for (const workspace of workspaces) {
    const navigationLabel =
      "navLabel" in workspace ? workspace.navLabel : workspace.label;
    await page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", {
        name:
          workspace.route === "messages"
            ? /^Messages(?:, \d+ unread messages?)?$/u
            : navigationLabel,
      })
      .click();

    await expect(page).toHaveURL(new RegExp(`#${workspace.route}$`, "u"));
    await expect(
      page.getByRole("heading", { name: workspace.label, exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Primary navigation" })
        .locator(`a[href="#${workspace.route}"]`),
    ).toHaveAttribute("aria-current", "page");
  }

  expect(pageErrors).toEqual([]);
});
