import { describe, expect, it, vi } from "vitest";
import type { ListSellerMessageThreadsInput } from "tcgplayer-private-api";
import { MessageManagementService } from "../src/message-management.js";

function clientFixture() {
  const listSellerMessageThreads = vi.fn(
    (_input?: ListSellerMessageThreadsInput) =>
      Promise.resolve({
        totalThreads: 26,
        page: _input?.page ?? 1,
        pageSize: _input?.pageSize ?? 25,
        threads: [
          {
            threadId: 123,
            unreadMessageCount: 2,
            totalMessageCount: 3,
            sender: "Synthetic Buyer",
            receiver: "me",
            subject: "Synthetic order question",
            orderType: "SellerOrder",
            orderNumber: "SYNTHETIC-ORDER-1",
            orderStatus: "Shipped",
            createdAt: "2026-08-07T12:00:00.000Z",
            deleted: false,
          },
        ],
      }),
  );
  const getSellerUnreadMessageCount = vi.fn(() => Promise.resolve(2));
  const getSellerMessageThread = vi.fn(() =>
    Promise.resolve({
      threadId: 123,
      subject: "Synthetic order question",
      totalMessageCount: 2,
      messages: [
        {
          messageId: 456,
          body: "Synthetic message body.",
          createdAt: "2026-08-07T12:00:00.000Z",
          sender: "me",
          responseRequired: false,
          isRead: true,
        },
      ],
      orderType: "SellerOrder",
      orderNumber: "SYNTHETIC-ORDER-1",
      deleted: false,
      page: 1,
      pageSize: 25,
    }),
  );
  const markSellerMessageThreadRead = vi.fn(() => Promise.resolve());
  const replyToSellerMessageThread = vi.fn(() => Promise.resolve());
  return {
    client: {
      listSellerMessageThreads,
      getSellerUnreadMessageCount,
      getSellerMessageThread,
      markSellerMessageThreadRead,
      replyToSellerMessageThread,
    },
    listSellerMessageThreads,
    getSellerUnreadMessageCount,
    getSellerMessageThread,
    markSellerMessageThreadRead,
    replyToSellerMessageThread,
  };
}

describe("MessageManagementService", () => {
  it("normalizes and caches the inbox and conversation", async () => {
    const current = clientFixture();
    const service = new MessageManagementService({
      client: current.client,
      sellerKey: "seller_test",
      now: () => new Date("2026-08-07T12:05:00.000Z"),
    });

    const first = await service.list();
    const cached = await service.list();
    const thread = await service.get(123);
    await service.get(123);

    expect(first).toMatchObject({
      page: 1,
      pageSize: 25,
      totalPages: 2,
      totalThreads: 26,
      unreadCount: 2,
      portalUrl: "https://sellerportal.tcgplayer.com/messages",
      threads: [
        {
          threadId: 123,
          senderDisplayName: "Synthetic Buyer",
          receiverDisplayName: "You",
        },
      ],
    });
    expect(cached).toEqual(first);
    expect(thread).toMatchObject({
      threadId: 123,
      totalPages: 1,
      portalUrl: "https://sellerportal.tcgplayer.com/messages/123",
      messages: [{ messageId: 456, senderDisplayName: "You" }],
    });
    expect(current.listSellerMessageThreads).toHaveBeenCalledOnce();
    expect(current.getSellerUnreadMessageCount).toHaveBeenCalledOnce();
    expect(current.getSellerMessageThread).toHaveBeenCalledOnce();
  });

  it("applies explicit message mutations and invalidates affected reads", async () => {
    const current = clientFixture();
    const service = new MessageManagementService({
      client: current.client,
      sellerKey: "seller_test",
    });
    await service.list();
    await service.get(123);

    await service.markRead(123);
    await service.list();
    await service.get(123);
    await service.reply(123, "  Synthetic reply.\r\nSecond line.  ");

    expect(current.markSellerMessageThreadRead).toHaveBeenCalledWith(
      { sellerKey: "seller_test", threadId: 123 },
      undefined,
    );
    expect(current.replyToSellerMessageThread).toHaveBeenCalledWith(
      {
        sellerKey: "seller_test",
        threadId: 123,
        body: "Synthetic reply.\nSecond line.",
      },
      undefined,
    );
    expect(current.listSellerMessageThreads).toHaveBeenCalledTimes(2);
    expect(current.getSellerUnreadMessageCount).toHaveBeenCalledTimes(2);
    expect(current.getSellerMessageThread).toHaveBeenCalledTimes(2);
  });

  it("marks every unread inbox thread sequentially across maximum-size pages", async () => {
    const current = clientFixture();
    const unreadThread = {
      threadId: 123,
      unreadMessageCount: 2,
      totalMessageCount: 3,
      sender: "Synthetic Buyer",
      receiver: "me",
      subject: "Synthetic order question",
      orderType: "SellerOrder",
      orderNumber: "SYNTHETIC-ORDER-1",
      orderStatus: "Shipped",
      createdAt: "2026-08-07T12:00:00.000Z",
      deleted: false,
    } as const;
    current.listSellerMessageThreads.mockImplementation((input) =>
      Promise.resolve({
        totalThreads: 101,
        page: input?.page ?? 1,
        pageSize: input?.pageSize ?? 25,
        threads:
          input?.page === 2
            ? [{ ...unreadThread, threadId: 125, unreadMessageCount: 1 }]
            : [
                unreadThread,
                { ...unreadThread, threadId: 124, unreadMessageCount: 0 },
              ],
      }),
    );
    const service = new MessageManagementService({
      client: current.client,
      sellerKey: "seller_test",
    });
    await service.list();
    await service.get(123);

    await expect(service.markAllRead()).resolves.toEqual({
      markedThreadCount: 2,
    });

    expect(current.listSellerMessageThreads).toHaveBeenNthCalledWith(
      2,
      { sellerKey: "seller_test", page: 1, pageSize: 100 },
      undefined,
    );
    expect(current.listSellerMessageThreads).toHaveBeenNthCalledWith(
      3,
      { sellerKey: "seller_test", page: 2, pageSize: 100 },
      undefined,
    );
    expect(current.markSellerMessageThreadRead.mock.calls).toEqual([
      [{ sellerKey: "seller_test", threadId: 123 }, undefined],
      [{ sellerKey: "seller_test", threadId: 125 }, undefined],
    ]);

    await service.list();
    await service.get(123);
    expect(current.listSellerMessageThreads).toHaveBeenCalledTimes(4);
    expect(current.getSellerUnreadMessageCount).toHaveBeenCalledTimes(2);
    expect(current.getSellerMessageThread).toHaveBeenCalledTimes(2);
  });

  it("stops bulk mark-read work on the first failed thread", async () => {
    const current = clientFixture();
    current.listSellerMessageThreads.mockResolvedValue({
      totalThreads: 3,
      page: 1,
      pageSize: 100,
      threads: [123, 124, 125].map((threadId) => ({
        threadId,
        unreadMessageCount: 1,
        totalMessageCount: 1,
        sender: "Synthetic Buyer",
        receiver: "me",
        subject: "Synthetic order question",
        orderType: "SellerOrder",
        orderNumber: `SYNTHETIC-ORDER-${String(threadId)}`,
        orderStatus: "Shipped",
        createdAt: "2026-08-07T12:00:00.000Z",
        deleted: false,
      })),
    });
    current.markSellerMessageThreadRead
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Synthetic remote failure."));
    const service = new MessageManagementService({
      client: current.client,
      sellerKey: "seller_test",
    });

    await expect(service.markAllRead()).rejects.toThrow(
      "Synthetic remote failure.",
    );
    expect(current.markSellerMessageThreadRead.mock.calls).toEqual([
      [{ sellerKey: "seller_test", threadId: 123 }, undefined],
      [{ sellerKey: "seller_test", threadId: 124 }, undefined],
    ]);
  });

  it("supports forced refreshes and deduplicates concurrent count reads", async () => {
    let resolveCount: ((value: number) => void) | undefined;
    const count = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveCount = resolve;
        }),
    );
    const current = clientFixture();
    const service = new MessageManagementService({
      client: { ...current.client, getSellerUnreadMessageCount: count },
      sellerKey: "seller_test",
    });

    const first = service.unreadCount();
    const second = service.unreadCount({ force: true });
    expect(count).toHaveBeenCalledOnce();
    resolveCount?.(4);
    await expect(Promise.all([first, second])).resolves.toEqual([4, 4]);

    count.mockResolvedValue(4);
    await service.list({ force: true });
    expect(current.listSellerMessageThreads).toHaveBeenCalledOnce();
  });

  it("invalidates cached inbox and conversation content when the unread count changes", async () => {
    const current = clientFixture();
    let now = new Date("2026-08-07T12:00:00.000Z");
    const service = new MessageManagementService({
      client: current.client,
      sellerKey: "seller_test",
      cacheMilliseconds: 30_000,
      now: () => now,
    });

    await service.unreadCount();
    now = new Date("2026-08-07T12:00:20.000Z");
    await service.list();
    await service.get(123);

    current.getSellerUnreadMessageCount.mockResolvedValue(3);
    now = new Date("2026-08-07T12:00:31.000Z");
    await expect(service.unreadCount()).resolves.toBe(3);
    await service.list();
    await service.get(123);

    expect(current.getSellerUnreadMessageCount).toHaveBeenCalledTimes(2);
    expect(current.listSellerMessageThreads).toHaveBeenCalledTimes(2);
    expect(current.getSellerMessageThread).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid page, order, and thread inputs", async () => {
    const service = new MessageManagementService({
      client: clientFixture().client,
      sellerKey: "seller_test",
    });

    await expect(service.list({ page: 0 })).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    await expect(service.list({ orderNumber: "\n" })).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    await expect(service.get(0)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    await expect(service.markRead(0)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    await expect(service.reply(123, "\u0000")).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
  });
});
