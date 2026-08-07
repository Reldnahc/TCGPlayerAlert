import { describe, expect, it, vi } from "vitest";
import {
  FeedbackManagementService,
  maskBuyerNickname,
} from "../src/feedback-management.js";

function clientFixture() {
  const listSellerFeedback = vi.fn(() =>
    Promise.resolve({
      totalFeedback: 26,
      offset: 25,
      rows: 25,
      feedback: [
        {
          rating: 5 as const,
          comment: "Synthetic feedback.",
          buyerNickname: "Synthetic Buyer",
          createdAt: "2026-08-07T12:00:00.000Z",
          active: true,
          arrivedWhenExpected: true,
          asDescribed: true,
          goodCommunication: false,
        },
      ],
    }),
  );
  const getSellerFeedbackAggregation = vi.fn(() =>
    Promise.resolve({
      totalRatings: 40,
      fiveStar: 35,
      fourStar: 3,
      threeStar: 1,
      twoStar: 0,
      oneStar: 1,
      arrivedWhenExpected: { positive: 30, negative: 2, unanswered: 8 },
      asDescribed: { positive: 31, negative: 1, unanswered: 8 },
      goodCommunication: { positive: 29, negative: 1, unanswered: 10 },
      totalAdditionalRatings: 94,
    }),
  );
  return {
    client: { listSellerFeedback, getSellerFeedbackAggregation },
    listSellerFeedback,
    getSellerFeedbackAggregation,
  };
}

describe("FeedbackManagementService", () => {
  it("caches pages and aggregates while masking buyer nicknames", async () => {
    const fixture = clientFixture();
    const service = new FeedbackManagementService({
      client: fixture.client,
      sellerKey: "synthetic-seller",
      now: () => new Date("2026-08-07T12:30:00.000Z"),
    });

    const input = {
      page: 2,
      rating: 5 as const,
      commentsOnly: true,
      days: 90,
    };
    const first = await service.list(input);
    const second = await service.list(input);
    await service.list({ ...input, force: true });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      page: 2,
      pageSize: 25,
      totalPages: 2,
      totalFeedback: 26,
      feedback: [
        {
          rating: 5,
          buyerDisplayName: "Synthetic B*",
          comment: "Synthetic feedback.",
        },
      ],
      aggregation: { totalRatings: 40, fiveStar: 35 },
      storefrontUrl:
        "https://store.tcgplayer.com/sellerfeedback/synthetic-seller",
      fetchedAt: "2026-08-07T12:30:00.000Z",
    });
    expect(first.feedback[0]).not.toHaveProperty("buyerNickname");
    expect(fixture.listSellerFeedback).toHaveBeenCalledTimes(2);
    expect(fixture.getSellerFeedbackAggregation).toHaveBeenCalledTimes(2);
    expect(fixture.listSellerFeedback).toHaveBeenCalledWith(
      {
        sellerKey: "synthetic-seller",
        offset: 25,
        rows: 25,
        rating: 5,
        requireComment: true,
        days: 90,
      },
      undefined,
    );
  });

  it("validates filters and masks single-token nicknames", async () => {
    const fixture = clientFixture();
    const service = new FeedbackManagementService({
      client: fixture.client,
      sellerKey: "synthetic-seller",
    });

    await expect(service.list({ rating: 0 as 1 })).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    expect(maskBuyerNickname("SoloNickname")).toBe("S***e");
    expect(maskBuyerNickname(" ")).toBeUndefined();
    expect(fixture.listSellerFeedback).not.toHaveBeenCalled();
  });
});
