// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/preact";
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

describe("bulk address labels", () => {
  it("formats editable previews and prints each ready label sequentially", async () => {
    let secondAddressAttempts = 0;
    const printedBodies: string[] = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        if (
          requestPath(input) === "/api/address-labels/print" &&
          options?.method === "POST"
        ) {
          if (typeof options.body !== "string") {
            throw new Error("Expected a JSON print request.");
          }
          const body = JSON.parse(options.body) as { address: string };
          printedBodies.push(body.address);
          if (body.address.includes("Second Recipient")) {
            secondAddressAttempts += 1;
            if (secondAddressAttempts === 1) {
              return Promise.resolve(
                json({ message: "Synthetic printer interruption." }, 503),
              );
            }
          }
          return Promise.resolve(json({ printed: true }));
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("link", { name: "Labels" }));
    const source = await screen.findByRole("textbox", {
      name: /^Address list/u,
    });
    fireEvent.input(source, {
      target: {
        value:
          "First Recipient, 1 First Street, Chicago, IL 60601\nSecond Recipient, 2 Second Street, Austin, TX 78701\nThird Recipient, 3 Third Street, Portland, OR 97201",
      },
    });
    await user.click(
      screen.getByRole("button", { name: "Format and preview" }),
    );

    const firstPreview = screen.getByRole("textbox", {
      name: "Label 1 lines",
    });
    const thirdPreview = screen.getByRole("textbox", {
      name: "Label 3 lines",
    });
    if (
      !(firstPreview instanceof HTMLTextAreaElement) ||
      !(thirdPreview instanceof HTMLTextAreaElement)
    ) {
      throw new Error("Expected editable label previews.");
    }
    expect(firstPreview.value).toBe(
      "First Recipient\n1 First Street\nChicago, IL 60601",
    );
    expect(thirdPreview.value).toBe(
      "Third Recipient\n3 Third Street\nPortland, OR 97201",
    );
    await user.click(screen.getByRole("button", { name: "Print 3 labels" }));

    expect(
      await screen.findByText(/Printing stopped after 1 of 3 labels/u),
    ).toBeTruthy();
    expect(printedBodies).toHaveLength(2);
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getAllByText("Ready")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Print remaining 1" }));
    await waitFor(() => expect(printedBodies).toHaveLength(3));
    expect(printedBodies[2]).toContain("Third Recipient");

    const failedLabel = screen.getByText("Needs review").closest("article");
    if (failedLabel === null) throw new Error("Missing failed label preview.");
    await user.click(
      within(failedLabel).getByRole("button", { name: "Mark for retry" }),
    );
    await user.click(screen.getByRole("button", { name: "Print remaining 1" }));
    await waitFor(() => expect(printedBodies).toHaveLength(4));
    expect(printedBodies[3]).toContain("Second Recipient");
    expect(
      await screen.findAllByText("1 address label sent to the printer."),
    ).toHaveLength(2);
  });

  it("works while the TCGplayer seller connection is disconnected", async () => {
    const requestedPaths: string[] = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        requestedPaths.push(path);
        if (path === "/api/auth/status") {
          return Promise.resolve(
            json({
              state: "disconnected",
              automaticRenewal: false,
              protectedStorage: true,
            }),
          );
        }
        return baseFetch(input, options);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("link", { name: "Labels" }));

    expect(
      await screen.findByRole("heading", { name: "Bulk labels" }),
    ).toBeTruthy();
    expect(screen.queryByText("Connect TCGplayer to use Labels")).toBeNull();
    expect(
      requestedPaths.filter((path) => path.startsWith("/api/orders")),
    ).toHaveLength(0);
  });
});
