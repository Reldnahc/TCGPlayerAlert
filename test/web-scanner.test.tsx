// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import {
  baseFetch,
  json,
  requestPath,
  resetWebUiTest,
} from "./web-ui-fixtures.js";

afterEach(resetWebUiTest);

describe("shipment scanner", () => {
  it("shows the service-owned camera without making an order request", async () => {
    window.location.hash = "scanner";
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        if (requestPath(input) === "/api/shipment-scanner") {
          return Promise.resolve(
            json({
              enabled: true,
              automaticallyMarkShipped: true,
              soundEnabled: false,
              readyOrderCount: 5,
              readyTagIds: [7, 18, 29, 41, 84],
              conflictingTagCount: 0,
              reviewRequiredCount: 0,
              snapshotFetchedAt: "2026-08-09T12:00:00.000Z",
              backgroundCamera: {
                state: "running",
                deviceId: "synthetic-camera",
                consensus: { tagId: null, matchingReads: 0, requiredReads: 0 },
                lastFrameAt: "2026-08-09T12:00:01.000Z",
              },
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Shipment scanner" }),
    ).toBeTruthy();
    expect(await screen.findByText("Automatic shipping")).toBeTruthy();
    expect(await screen.findByText("Watching the basket")).toBeTruthy();
    expect(screen.getByText("Synthetic Camera")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start camera" })).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestPath(input).startsWith("/api/orders"),
      ),
    ).toBe(false);
  });

  it("shows a background match after the status poll without submitting a scan", async () => {
    vi.useFakeTimers();
    let statusRead = 0;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/shipment-scanner") {
          statusRead += 1;
          return Promise.resolve(
            json({
              enabled: true,
              automaticallyMarkShipped: false,
              soundEnabled: false,
              readyOrderCount: 1,
              readyTagIds: [7],
              conflictingTagCount: 0,
              reviewRequiredCount: 0,
              backgroundCamera:
                statusRead === 1
                  ? {
                      state: "running",
                      deviceId: "synthetic-camera",
                      consensus: {
                        tagId: 7,
                        matchingReads: 4,
                        requiredReads: 5,
                      },
                    }
                  : {
                      state: "waiting-for-review",
                      deviceId: "synthetic-camera",
                      consensus: {
                        tagId: null,
                        matchingReads: 0,
                        requiredReads: 0,
                      },
                      latchedTagId: 7,
                      lastResultAt: "2026-08-09T12:00:02.000Z",
                      lastResult: {
                        state: "matched",
                        tagId: 7,
                        order: {
                          orderNumber: "SYNTHETIC-ORDER-7",
                          buyerName: "Synthetic Buyer",
                          orderDate: "2026-08-07T12:00:00.000Z",
                          status: "Ready to Ship",
                          statusCode: "ReadyToShip",
                          canMarkShipped: true,
                          shippingType: "Standard",
                          productAmount: 10,
                          shippingAmount: 1.49,
                          totalAmount: 11.49,
                        },
                      },
                    },
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    window.location.hash = "scanner";
    render(<App />);

    await screen.findByRole("heading", { name: "Shipment scanner" });
    await screen.findByText("Review before shipping");
    expect(screen.getByText("Confirming tag 7")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(await screen.findByText("Exact ready-order match")).toBeTruthy();
    expect(screen.getByText("Waiting for review")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input) === "/api/shipment-scanner/scan",
      ),
    ).toBe(false);
  });
});
