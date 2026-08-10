// @vitest-environment jsdom

import { render, screen } from "@testing-library/preact";
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

describe("internal jobs workspace", () => {
  it("creates a review-only repricing schedule without enqueueing a mutation", async () => {
    const schedules: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/internal-jobs" && options?.method !== "POST") {
          return Promise.resolve(
            json({ schedules, runs: [], runnerRunning: true }),
          );
        }
        if (
          path === "/api/internal-jobs/schedules" &&
          options?.method === "POST"
        ) {
          if (typeof options.body !== "string")
            throw new Error("Expected a schedule body.");
          const inputBody = JSON.parse(options.body) as Record<string, unknown>;
          const schedule = {
            ...inputBody,
            id: "00000000-0000-4000-8000-000000000100",
            createdAt: "2026-08-10T12:00:00.000Z",
            updatedAt: "2026-08-10T12:00:00.000Z",
            nextRunAt: "2026-08-11T08:00:00.000Z",
          };
          schedules.push(schedule);
          return Promise.resolve(json({ schedule }, 201));
        }
        if (path === "/api/inventory-additions") {
          return Promise.resolve(
            json({
              jobs: [],
              counts: {
                pending: 0,
                applying: 0,
                submitted: 0,
                failed: 0,
                "review-required": 0,
                superseded: 0,
                canceled: 0,
              },
              workerRunning: false,
            }),
          );
        }
        if (path === "/api/price-updates") {
          return Promise.resolve(
            json({
              jobs: [],
              counts: {
                pending: 0,
                applying: 0,
                applied: 0,
                failed: 0,
                "review-required": 0,
                superseded: 0,
                canceled: 0,
              },
              workerRunning: false,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    window.location.hash = "jobs";
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Jobs" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Review only" }).getAttribute("value"),
    ).toBe("review");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Morning review");
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(await screen.findByText("Morning review")).toBeTruthy();
    const createCall = fetchMock.mock.calls.find(
      ([input, options]) =>
        requestPath(input) === "/api/internal-jobs/schedules" &&
        options?.method === "POST",
    );
    expect(createCall).toBeDefined();
    const createBody = createCall?.[1]?.body;
    if (typeof createBody !== "string")
      throw new Error("Expected the captured schedule body.");
    const request = JSON.parse(createBody) as {
      payload: { mode: string };
    };
    expect(request.payload.mode).toBe("review");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestPath(input).includes("previews/queue"),
      ),
    ).toBe(false);
  });
});
