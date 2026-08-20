// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import {
  baseFetch,
  json,
  requestPath,
  resetWebUiTest,
} from "./web-ui-fixtures.js";

afterEach(resetWebUiTest);

describe("feedback", () => {
  it("shows filtered read-only feedback without exposing raw buyer nicknames", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/feedback?")) {
          return Promise.resolve(
            json({
              page: 1,
              pageSize: 25,
              totalPages: 1,
              totalFeedback: 1,
              feedback: [
                {
                  rating: 5,
                  comment: "Synthetic feedback comment.",
                  buyerDisplayName: "Synthetic B*",
                  createdAt: "2026-08-07T12:00:00.000Z",
                  active: true,
                  arrivedWhenExpected: false,
                  asDescribed: false,
                  goodCommunication: false,
                },
              ],
              aggregation: {
                totalRatings: 10,
                fiveStar: 8,
                fourStar: 1,
                threeStar: 0,
                twoStar: 0,
                oneStar: 1,
                arrivedWhenExpected: {
                  positive: 9,
                  negative: 1,
                  unanswered: 0,
                },
                asDescribed: { positive: 9, negative: 1, unanswered: 0 },
                goodCommunication: {
                  positive: 8,
                  negative: 1,
                  unanswered: 1,
                },
                totalAdditionalRatings: 28,
              },
              storefrontUrl:
                "https://store.tcgplayer.com/sellerfeedback/synthetic-seller",
              fetchedAt: "2026-08-07T12:00:00.000Z",
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Dashboard" });

    await user.click(screen.getByRole("link", { name: "Feedback" }));

    expect(
      await screen.findByRole("heading", { name: "Feedback" }),
    ).toBeTruthy();
    expect(screen.getByText("Synthetic feedback comment.")).toBeTruthy();
    expect(screen.getByText("Synthetic B*")).toBeTruthy();
    expect(screen.queryByText("Synthetic Buyer")).toBeNull();
    expect(screen.getByLabelText("5 out of 5 stars")).toBeTruthy();
    expect(screen.queryByText("Order experience")).toBeNull();
    expect(screen.queryByText("Delivery")).toBeNull();
    expect(screen.queryByText("Item")).toBeNull();
    expect(screen.queryByText("Communication")).toBeNull();
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open TCGplayer" }).getAttribute("href"),
    ).toBe("https://store.tcgplayer.com/sellerfeedback/synthetic-seller");

    await user.selectOptions(screen.getByLabelText("Rating"), "1");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) => requestPath(input) === "/api/feedback?page=1&rating=1",
        ),
      ).toBe(true),
    );
  });
});
