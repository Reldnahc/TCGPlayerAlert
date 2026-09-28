// @vitest-environment jsdom
import { render, screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplenishmentPanel } from "../src/web/pages/ReplenishmentPanel.js";
import { uiApi } from "../src/web/api.js";
import { resetWebUiTest } from "./web-ui-fixtures.js";
import type { LocalInventoryItem } from "../src/local-inventory-contracts.js";
import type { ReplenishmentRule } from "../src/replenishment-contracts.js";
afterEach(resetWebUiTest);
const item: LocalInventoryItem = {
  localInventoryId: "00000000-0000-4000-8000-000000000001",
  displayName: "Synthetic Promo Pack",
  onHand: 20,
  catalogIdentities: [],
  attributes: {},
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};
const rule: ReplenishmentRule = {
  localInventoryId: item.localInventoryId,
  displayName: item.displayName,
  accountScope: "synthetic",
  connectionId: "tcgplayer-main",
  targetQuantity: 1,
  price: 2,
  enabled: false,
  status: "review-required",
  tickets: [],
  jobs: [],
  message: "Check the live listing.",
};
describe("auto-relisting controls", () => {
  it("defaults to one public unit and enables only through an explicit inventory action", async () => {
    vi.spyOn(uiApi, "replenishment").mockResolvedValue({
      connectionId: "tcgplayer-main",
      workerRunning: true,
      rules: [],
    });
    const configure = vi
      .spyOn(uiApi, "configureReplenishment")
      .mockResolvedValue({
        connectionId: "tcgplayer-main",
        workerRunning: true,
        rules: [{ ...rule, enabled: true, status: "watching" }],
      });
    const user = userEvent.setup();
    render(<ReplenishmentPanel item={item} initialPrice={2} />);
    await screen.findByLabelText("Public quantity limit");
    expect(
      screen.getByLabelText<HTMLInputElement>("Public quantity limit").value,
    ).toBe("1");
    expect(configure).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Enable for future sales" }),
    );
    expect(configure).toHaveBeenCalledWith(item.localInventoryId, {
      enabled: true,
      targetQuantity: 1,
      price: 2,
      reconciled: false,
      pricingProfileId: null,
    });
    await screen.findByText(
      "Auto-relisting enabled for future sales. No listing was changed now.",
    );
    await user.click(
      screen.getByRole("button", { name: "Pause auto-relisting" }),
    );
    expect(configure).toHaveBeenLastCalledWith(item.localInventoryId, {
      enabled: false,
      targetQuantity: 1,
      price: 2,
      reconciled: false,
      pricingProfileId: null,
    });
  });
  it("reviews a profile-based initial listing before publishing local-only stock", async () => {
    vi.spyOn(uiApi, "replenishment").mockResolvedValue({
      connectionId: "tcgplayer-main",
      workerRunning: true,
      rules: [],
      pricingProfiles: [{ id: "smart", name: "Smart conservative" }],
    });
    const configure = vi
      .spyOn(uiApi, "configureReplenishment")
      .mockResolvedValueOnce({
        connectionId: "tcgplayer-main",
        workerRunning: true,
        rules: [],
        preview: {
          id: "review-id",
          quantity: 0,
          targetQuantity: 1,
          addQuantity: 1,
          price: 1.75,
        },
      })
      .mockResolvedValue({
        connectionId: "tcgplayer-main",
        workerRunning: true,
        rules: [
          {
            ...rule,
            enabled: true,
            status: "watching",
            pricingProfileId: "smart",
            message:
              "Initial listing confirmed in live inventory. Replacements wait for confirmed shipment.",
          },
        ],
      });
    const user = userEvent.setup();
    render(<ReplenishmentPanel item={item} />);
    await screen.findByLabelText("Relisting pricing");
    expect(
      screen.getByLabelText<HTMLSelectElement>("Relisting pricing").value,
    ).toBe("smart");
    expect(screen.queryByLabelText("Relisting price ($)")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Review initial listing" }),
    );
    expect(configure).toHaveBeenLastCalledWith(
      item.localInventoryId,
      expect.objectContaining({ pricingProfileId: "smart", previewOnly: true }),
    );
    await screen.findByText(/Public stock: 0 → 1/);
    expect(configure).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "List now and enable auto-relist" }),
    );
    expect(configure).toHaveBeenLastCalledWith(
      item.localInventoryId,
      expect.objectContaining({
        startPreviewId: "review-id",
        pricingProfileId: "smart",
      }),
    );
    await screen.findAllByText(
      "Initial listing confirmed in live inventory. Replacements wait for confirmed shipment.",
    );
  });
  it("shows progress and an unverified result next to the listing controls", async () => {
    vi.spyOn(uiApi, "replenishment").mockResolvedValue({
      connectionId: "tcgplayer-main",
      workerRunning: true,
      rules: [],
    });
    let finish: (() => void) | undefined;
    vi.spyOn(uiApi, "configureReplenishment")
      .mockResolvedValueOnce({
        connectionId: "tcgplayer-main",
        workerRunning: true,
        rules: [],
        preview: {
          id: "review",
          quantity: 0,
          targetQuantity: 1,
          addQuantity: 1,
          price: 2,
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                connectionId: "tcgplayer-main",
                workerRunning: true,
                rules: [
                  {
                    ...rule,
                    message:
                      "Expected live quantity could not be confirmed. Check TCGplayer.",
                  },
                ],
              });
          }),
      );
    const user = userEvent.setup();
    render(<ReplenishmentPanel item={item} />);
    await user.click(
      await screen.findByRole("button", { name: "Review initial listing" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "List now and enable auto-relist",
      }),
    );
    await screen.findByText(
      "Submitting and checking live inventory. Please wait; do not submit again.",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "List now and enable auto-relist",
      }).disabled,
    ).toBe(true);
    finish?.();
    const messages = await screen.findAllByText(
      "Expected live quantity could not be confirmed. Check TCGplayer.",
    );
    expect(messages.some((message) => message.closest("form") !== null)).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Review initial listing",
      }).disabled,
    ).toBe(true);
  });
  it("requires reconciliation acknowledgement for uncertain attempts", async () => {
    vi.spyOn(uiApi, "replenishment").mockResolvedValue({
      connectionId: "tcgplayer-main",
      workerRunning: false,
      rules: [rule],
    });
    const configure = vi
      .spyOn(uiApi, "configureReplenishment")
      .mockResolvedValue({
        connectionId: "tcgplayer-main",
        workerRunning: false,
        rules: [],
      });
    const user = userEvent.setup();
    render(<ReplenishmentPanel item={item} />);
    const button = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Enable for future sales",
    });
    expect(button.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox"));
    await user.click(button);
    expect(configure).toHaveBeenCalledWith(
      item.localInventoryId,
      expect.objectContaining({ reconciled: true }),
    );
  });
});
