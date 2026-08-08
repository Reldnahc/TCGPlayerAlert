import { describe, expect, it, vi } from "vitest";
import { MessageManagementService } from "../src/message-management.js";

function clientFixture() {
  const listSellerMessageThreads = vi.fn(() =>
    Promise.resolve({
      totalThreads: 26,
      page: 1,
      pageSize: 25,
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
  return {
    client: {
      listSellerMessageThreads,
      getSellerUnreadMessageCount,
      getSellerMessageThread,
    },
    listSellerMessageThreads,
    getSellerUnreadMessageCount,
    getSellerMessageThread,
  };
}

describe("MessageManagementService", () => {
  it("normalizes and caches the read-only inbox and conversation", async () => {
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
  });
});
