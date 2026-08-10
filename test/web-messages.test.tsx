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

describe("messages", () => {
  it("marks conversations read and sends explicit replies", async () => {
    let replyDeliveryUncertain = false;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const path = requestPath(input);
        if (path.startsWith("/api/messages/unread-count")) {
          return Promise.resolve(json({ unreadCount: 3 }));
        }
        if (path === "/api/messages/123/mark-read") {
          return Promise.resolve(json({ threadId: 123 }));
        }
        if (path === "/api/messages/mark-all-read") {
          return Promise.resolve(json({ markedThreadCount: 1 }));
        }
        if (path === "/api/messages/123/reply") {
          if (replyDeliveryUncertain) {
            return Promise.resolve(
              json(
                {
                  message: "Synthetic delivery outcome is uncertain.",
                  code: "AMBIGUOUS_RESULT",
                },
                502,
              ),
            );
          }
          return Promise.resolve(json({ threadId: 123 }));
        }
        if (path.startsWith("/api/messages?page=1")) {
          return Promise.resolve(
            json({
              page: 1,
              pageSize: 25,
              totalPages: 1,
              totalThreads: 2,
              unreadCount: 3,
              threads: [
                {
                  threadId: 123,
                  unreadMessageCount: 2,
                  totalMessageCount: 2,
                  senderDisplayName: "Synthetic Buyer",
                  receiverDisplayName: "You",
                  subject: "Synthetic order question",
                  orderType: "SellerOrder",
                  orderNumber: "SYNTHETIC-ORDER-1",
                  orderStatus: "Shipped",
                  createdAt: "2026-08-07T12:00:00.000Z",
                  deleted: false,
                },
                {
                  threadId: 124,
                  unreadMessageCount: 1,
                  totalMessageCount: 1,
                  senderDisplayName: "Another Synthetic Buyer",
                  receiverDisplayName: "You",
                  subject: "Another synthetic question",
                  orderType: "SellerOrder",
                  orderNumber: "SYNTHETIC-ORDER-2",
                  orderStatus: "Ready to Ship",
                  createdAt: "2026-08-07T11:00:00.000Z",
                  deleted: false,
                },
              ],
              portalUrl: "https://sellerportal.tcgplayer.com/messages",
              fetchedAt: "2026-08-07T12:05:00.000Z",
            }),
          );
        }
        if (path.startsWith("/api/messages/123?page=1")) {
          return Promise.resolve(
            json({
              threadId: 123,
              subject: "Synthetic order question",
              totalMessageCount: 2,
              messages: [
                {
                  messageId: 456,
                  body: "Synthetic message body.",
                  createdAt: "2026-08-07T12:00:00.000Z",
                  senderDisplayName: "Synthetic Buyer",
                  responseRequired: true,
                  isRead: false,
                },
              ],
              orderType: "SellerOrder",
              orderNumber: "SYNTHETIC-ORDER-1",
              deleted: false,
              page: 1,
              pageSize: 25,
              totalPages: 1,
              portalUrl: "https://sellerportal.tcgplayer.com/messages/123",
              fetchedAt: "2026-08-07T12:05:00.000Z",
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

    const messagesLink = await screen.findByRole("link", {
      name: "Messages, 3 unread messages",
    });
    expect(messagesLink.querySelector(".nav__unread")?.textContent).toBe("3");
    await user.click(messagesLink);

    expect(
      await screen.findByRole("heading", { name: "Messages" }),
    ).toBeTruthy();
    expect(await screen.findByText("Synthetic message body.")).toBeTruthy();
    expect(screen.getByText("Synthetic Buyer")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open conversation" })
        .getAttribute("href"),
    ).toBe("https://sellerportal.tcgplayer.com/messages/123");

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, request]) =>
            requestPath(input) === "/api/messages/123/mark-read" &&
            request?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText("Opening an unread conversation marks it read"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Read" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    expect(messagesLink.querySelector(".nav__unread")?.textContent).toBe("1");

    const markAllRead = screen.getByRole("button", { name: "Mark all read" });
    await waitFor(() => expect(markAllRead).toHaveProperty("disabled", false));
    await user.click(markAllRead);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, request]) =>
            requestPath(input) === "/api/messages/mark-all-read" &&
            request?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Marked 1 conversation read.")).toBeTruthy();
    expect(messagesLink.querySelector(".nav__unread")).toBeNull();

    await user.type(screen.getByLabelText("Reply"), "Synthetic reply.");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, request]) =>
            requestPath(input) === "/api/messages/123/reply" &&
            request?.method === "POST" &&
            request.body === JSON.stringify({ body: "Synthetic reply." }),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Message sent.")).toBeTruthy();

    replyDeliveryUncertain = true;
    const reply = screen.getByLabelText<HTMLTextAreaElement>("Reply");
    await user.type(reply, "Potential duplicate.");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Delivery needs verification")).toBeTruthy();
    expect(reply.value).toBe("Potential duplicate.");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(
      screen.getByRole("button", { name: "Refresh conversation" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toHaveProperty("disabled", false),
    );
    expect(
      fetchMock.mock.calls.filter(([, request]) => request?.method === "POST"),
    ).toHaveLength(4);
  });
});
