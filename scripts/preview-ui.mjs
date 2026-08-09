import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  ConfigurationService,
  shipmentTagId,
  startConfigurationUi,
} from "../dist/index.js";

const previewDirectory = await mkdtemp(
  join(tmpdir(), "tcgplayer-alert-preview-"),
);
const configPath = join(previewDirectory, "local.json");
await writeFile(
  configPath,
  await readFile("config/local.example.json", "utf8"),
);

const now = "2026-08-07T17:15:00.000Z";
let previewUnreadMessageCount = 2;
const previewReplies = [];
const orders = [
  {
    orderNumber: "123-4567890-001",
    buyerName: "Alex Morgan",
    orderDate: "2026-08-07T14:31:00.000Z",
    status: "Ready to Ship",
    statusCode: "ReadyToShip",
    canMarkShipped: true,
    shippingType: "Standard",
    productAmount: 28.75,
    shippingAmount: 1.49,
    totalAmount: 30.24,
  },
  {
    orderNumber: "123-4567890-002",
    buyerName: "Jordan Lee",
    orderDate: "2026-08-06T19:42:00.000Z",
    status: "Ready to Ship",
    statusCode: "ReadyToShip",
    canMarkShipped: true,
    shippingType: "Expedited",
    productAmount: 71.2,
    shippingAmount: 4.99,
    totalAmount: 76.19,
  },
  {
    orderNumber: "123-4567890-003",
    buyerName: "Sam Rivera",
    orderDate: "2026-08-05T12:12:00.000Z",
    status: "Shipped",
    statusCode: "Shipped",
    canMarkShipped: false,
    shippingType: "Standard",
    productAmount: 8.5,
    shippingAmount: 1.49,
    totalAmount: 9.99,
  },
];

const payouts = [
  {
    payoutId: "synthetic-payout-1",
    referenceId: "SYNTHETIC-PAYOUT-1",
    createdAt: "2026-08-04T12:00:00.000Z",
    lastSentAt: "2026-08-06T12:00:00.000Z",
    amount: 9_842,
    ordersCount: 7,
    status: "Succeeded",
  },
  {
    payoutId: "synthetic-payout-2",
    referenceId: "SYNTHETIC-PAYOUT-2",
    createdAt: "2026-08-07T12:00:00.000Z",
    holdUntil: "2026-08-11T12:00:00.000Z",
    amount: 5_615,
    ordersCount: 4,
    status: "Committed",
  },
];

const catalogProduct = {
  productId: 123456,
  imageUrl: "https://product-images.tcgplayer.com/fit-in/200x279/123456.jpg",
  productName: "Lightning Bolt",
  productLineName: "Magic: The Gathering",
  setName: "Masters 25",
  rarityName: "Uncommon",
  cardNumber: "141",
  marketPrice: 1.72,
  foilMarketPrice: 4.81,
  sellerListable: true,
};

let inventoryJobs = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    operation: "add",
    status: "submitted",
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    addition: {
      productId: 123456,
      productName: "Lightning Bolt",
      productConditionId: 654321,
      conditionId: 1,
      channelId: 0,
      categoryName: "Magic: The Gathering",
      currentQuantity: 1,
      addQuantity: 2,
      price: 1.72,
      storePriceCustomId: null,
      reserveQuantity: 0,
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    operation: "remove",
    status: "failed",
    createdAt: now,
    updatedAt: now,
    attempts: 2,
    errorCode: "PROVIDER_ERROR",
    removal: {
      productId: 222222,
      productName: "Counterspell",
      productConditionId: 333333,
      conditionId: 2,
      channelId: 0,
      categoryName: "Magic: The Gathering",
      currentQuantity: 3,
      price: 2.2,
      storePriceCustomId: null,
      reserveQuantity: 0,
    },
  },
];
let priceJobs = [
  {
    id: "00000000-0000-4000-8000-000000000201",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    update: {
      productId: 444444,
      productName: "Sol Ring",
      productConditionId: 555555,
      conditionId: 1,
      channelId: 0,
      categoryName: "Magic: The Gathering",
      quantity: 4,
      price: 1.49,
      storePriceCustomId: null,
      reserveQuantity: 0,
    },
  },
];

function counts(jobs) {
  return Object.fromEntries(
    [...new Set(jobs.map((job) => job.status))].map((status) => [
      status,
      jobs.filter((job) => job.status === status).length,
    ]),
  );
}

const inventoryQueue = {
  snapshot: () =>
    Promise.resolve({ jobs: inventoryJobs, counts: counts(inventoryJobs) }),
  enqueue: (addition) => {
    const job = {
      id: randomUUID(),
      operation: "add",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      addition,
    };
    inventoryJobs = [job, ...inventoryJobs];
    return Promise.resolve([job]);
  },
  enqueueRemoval: (removal) => {
    const job = {
      id: randomUUID(),
      operation: "remove",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      removal,
    };
    inventoryJobs = [job, ...inventoryJobs];
    return Promise.resolve(job);
  },
  resubmit: (id) => Promise.resolve(inventoryJobs.find((job) => job.id === id)),
  cancel: (id) => Promise.resolve(inventoryJobs.find((job) => job.id === id)),
};
const priceQueue = {
  snapshot: () =>
    Promise.resolve({ jobs: priceJobs, counts: counts(priceJobs) }),
  enqueue: ({ updates }) => {
    const jobs = updates.map((update) => ({
      id: randomUUID(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      update,
    }));
    priceJobs = [...jobs, ...priceJobs];
    return Promise.resolve(jobs);
  },
  resubmit: (id) => Promise.resolve(priceJobs.find((job) => job.id === id)),
  cancel: (id) => Promise.resolve(priceJobs.find((job) => job.id === id)),
};

const inventoryService = {
  search: () =>
    Promise.resolve({
      totalProducts: 3,
      productLines: [{ name: "Magic: The Gathering", count: 3 }],
      sets: [
        { name: "Masters 25", count: 1 },
        { name: "Magic 2011", count: 1 },
      ],
      products: [
        catalogProduct,
        {
          ...catalogProduct,
          productId: 234567,
          setName: "Magic 2011",
          cardNumber: "149",
          marketPrice: 1.51,
          foilMarketPrice: 5.12,
          matchKind: "exact",
          matchRank: [0, 1],
        },
        {
          ...catalogProduct,
          productId: 345678,
          productName: "Lightning Strike",
          setName: "Theros",
          cardNumber: "127",
          marketPrice: 0.31,
          foilMarketPrice: 0.78,
          matchKind: "related",
          matchRank: [2],
        },
      ].map((product, index) => ({
        matchKind: index === 2 ? "related" : "exact",
        matchRank: [index],
        ...product,
      })),
      nextOffset: 3,
      hasMore: false,
    }),
  getProduct: (productId) =>
    Promise.resolve({
      ...catalogProduct,
      productId,
      skus: [
        {
          productConditionId: productId + 1,
          conditionId: 1,
          condition: "Near Mint",
          printing: "Normal",
          language: "English",
        },
        {
          productConditionId: productId + 2,
          conditionId: 1,
          condition: "Near Mint",
          printing: "Foil",
          language: "English",
        },
      ],
    }),
  preview: ({ productId, productConditionId, addQuantity, rules }) =>
    Promise.resolve({
      id: "00000000-0000-4000-8000-000000000301",
      createdAt: now,
      expiresAt: now,
      product: catalogProduct,
      sku: {
        productConditionId,
        conditionId: 1,
        condition: "Near Mint",
        printing: "Normal",
        language: "English",
      },
      currentQuantity: 0,
      addQuantity,
      proposedPrice: 1.71,
      minimumApplied: false,
      queueable: true,
      reason: "Uses the marketplace reference.",
      rules,
      productId,
    }),
  takeAddition: () => ({
    productId: 123456,
    productName: "Lightning Bolt",
    productConditionId: 654321,
    conditionId: 1,
    channelId: 0,
    categoryName: "Magic: The Gathering",
    currentQuantity: 0,
    addQuantity: 1,
    price: 1.71,
    storePriceCustomId: null,
    reserveQuantity: 0,
  }),
};

const previewRows = [
  {
    id: "row-1",
    productId: 1001,
    productConditionId: 2001,
    productName: "Lightning Bolt",
    productLineName: "Magic: The Gathering",
    setName: "Masters 25",
    condition: "Near Mint",
    printing: "Normal",
    language: "English",
    quantity: 4,
    currentPrice: 1.85,
    currentShipping: 1.49,
    proposedPrice: 1.72,
    marketPrice: 1.72,
    lowestPrice: 1.73,
    lowestShipping: 1.49,
    qualifyingListings: 18,
    comparisonSource: "batched",
    distinctSellers: 14,
    minimumApplied: false,
    status: "ready",
    reason: "Uses 100% of the lowest supported listing.",
    queueable: true,
    removable: true,
  },
  {
    id: "row-2",
    productId: 1002,
    productConditionId: 2002,
    productName: "Sol Ring",
    productLineName: "Magic: The Gathering",
    setName: "Commander Masters",
    condition: "Lightly Played",
    printing: "Foil",
    language: "English",
    quantity: 2,
    currentPrice: 4.25,
    currentShipping: 1.49,
    proposedPrice: 4.25,
    marketPrice: 4.51,
    lowestPrice: 4.25,
    lowestShipping: 1.49,
    qualifyingListings: 9,
    comparisonSource: "exact",
    distinctSellers: 7,
    minimumApplied: false,
    status: "unchanged",
    reason: "Current price already matches the profile.",
    queueable: false,
    removable: true,
  },
  {
    id: "row-3",
    productId: 1003,
    productConditionId: 2003,
    productName: "Counterspell",
    productLineName: "Magic: The Gathering",
    setName: "Dominaria Remastered",
    condition: "Moderately Played",
    printing: "Normal",
    language: "English",
    quantity: 1,
    currentPrice: 0.45,
    currentShipping: 1.49,
    proposedPrice: 0.5,
    marketPrice: 0.48,
    lowestPrice: 0.44,
    lowestShipping: 1.49,
    qualifyingListings: 23,
    comparisonSource: "batched",
    distinctSellers: 18,
    minimumApplied: true,
    effectiveMinimumPrice: 0.5,
    minimumPriceSource: "Uncommon",
    status: "ready",
    reason: "The Magic rarity floor sets the minimum.",
    queueable: true,
    removable: true,
  },
];
const repricingService = {
  preview: (rules) =>
    Promise.resolve({
      id: "00000000-0000-4000-8000-000000000401",
      createdAt: now,
      expiresAt: now,
      rules,
      rows: previewRows,
      counts: { ready: 2, unchanged: 1, skipped: 0 },
      totals: { listingCount: 3, totalQuantity: 7, currentListingValue: 16.35 },
      marketplaceSnapshot: { capturedAt: now, expiresAt: now, source: "cache" },
    }),
  takeUpdates: (_id, body) =>
    previewRows
      .filter((row) => body.rowIds.includes(row.id))
      .map((row) => ({
        productId: row.productId,
        productName: row.productName,
        productConditionId: row.productConditionId,
        conditionId: 1,
        channelId: 0,
        categoryName: row.productLineName,
        quantity: row.quantity,
        price: row.proposedPrice,
        storePriceCustomId: null,
        reserveQuantity: 0,
      })),
  takeRemoval: () => ({
    productId: 1001,
    productName: "Lightning Bolt",
    productConditionId: 2001,
    conditionId: 1,
    channelId: 0,
    categoryName: "Magic: The Gathering",
    currentQuantity: 4,
    price: 1.85,
    storePriceCustomId: null,
    reserveQuantity: 0,
  }),
};

const service = new ConfigurationService({
  configPath,
  discoverPrinters: () =>
    Promise.resolve({
      supported: true,
      printers: [
        { name: "DYMO LabelWriter 450", isDefault: false },
        { name: "Office Laser Printer", isDefault: true },
      ],
    }),
  discoverCameras: () =>
    Promise.resolve({
      cameras: [
        {
          id: "synthetic-camera",
          label: "Synthetic Basket Camera",
          isDefault: true,
        },
      ],
    }),
});
const previewConnectionStatus = {
  state: "connected",
  source: "browser",
  updatedAt: now,
  automaticRenewal: true,
  protectedStorage: true,
};
const sessionManager = {
  connectionStatus: () => previewConnectionStatus,
  startPairing: () => ({
    pairingCode: "synthetic-preview",
    expiresAt: now,
  }),
  connect: () =>
    Promise.resolve({
      connectorToken: "synthetic-preview",
      status: previewConnectionStatus,
    }),
  renew: () => Promise.resolve(previewConnectionStatus),
  disconnect: () => Promise.resolve(previewConnectionStatus),
};
const server = await startConfigurationUi({
  configPath,
  port: Number(process.env.PREVIEW_PORT ?? 47839),
  service,
  sessionManager,
  inventoryService,
  inventoryQueue,
  inventoryWorkerRunning: false,
  priceQueue,
  priceWorkerRunning: true,
  repricingService,
  orderService: {
    listOrders: (scope) =>
      Promise.resolve({
        orders:
          scope === "ready-to-ship"
            ? orders.filter((order) => order.canMarkShipped)
            : orders,
        fetchedAt: now,
      }),
    getPackingSlip: () =>
      Promise.resolve({ bytes: new Uint8Array([37, 80, 68, 70]) }),
    preparePirateShip: () =>
      Promise.resolve({
        url: "https://ship.pirateship.com/ship/single",
        pasteAddress: "Alex Morgan\n123 Example Street\nChicago, IL 60601",
      }),
    print: () => Promise.resolve(),
    addTracking: (orderNumber) =>
      Promise.resolve({ orderNumber, carrier: "USPS", outcome: "applied" }),
    markShipped: (orderNumber) =>
      Promise.resolve({ orderNumber, outcome: "applied" }),
  },
  paymentService: {
    list: ({ page = 1 }) =>
      Promise.resolve({
        experience: "money-movement",
        totalPayouts: payouts.length,
        page,
        pageSize: 25,
        payouts,
        unpaidBalance: {
          totalBalance: 3_274,
          transactions: [
            {
              createdAt: "2026-08-07T11:00:00.000Z",
              type: "SettleOrder",
              orderNumber: orders[0].orderNumber,
              amount: 3_024,
              feeAmount: -268,
              netAmount: 2_756,
            },
            {
              createdAt: "2026-08-07T11:30:00.000Z",
              type: "ApplyAdjustment",
              amount: 518,
              feeAmount: 0,
              netAmount: 518,
            },
          ],
        },
        fetchedAt: now,
      }),
    get: (referenceId) =>
      Promise.resolve({
        payoutId: `detail-${referenceId}`,
        referenceId,
        createdAt: "2026-08-04T12:00:00.000Z",
        lastSentAt: "2026-08-06T12:00:00.000Z",
        amount: 9_842,
        status: "Succeeded",
        totalSales: 10_800,
        totalRefunds: 0,
        totalFees: -958,
        totalAdjustments: 0,
        transactions: [
          {
            createdAt: "2026-08-03T12:00:00.000Z",
            type: "SettleOrder",
            orderNumber: orders[0].orderNumber,
            amount: 3_024,
            feeAmount: -268,
            netAmount: 2_756,
          },
        ],
      }),
  },
  feedbackService: {
    list: ({ page = 1 }) =>
      Promise.resolve({
        page,
        pageSize: 25,
        totalPages: 1,
        totalFeedback: 3,
        feedback: [
          {
            rating: 5,
            comment: "Fast shipping and careful packaging.",
            buyerDisplayName: "Taylor M*",
            createdAt: "2026-08-07T10:20:00.000Z",
            active: true,
            arrivedWhenExpected: true,
            asDescribed: true,
            goodCommunication: true,
          },
          {
            rating: 4,
            buyerDisplayName: "R***7",
            createdAt: "2026-08-05T15:40:00.000Z",
            active: true,
            arrivedWhenExpected: true,
            asDescribed: true,
          },
          {
            rating: 3,
            comment: "Synthetic preview comment for layout testing.",
            buyerDisplayName: "Morgan L*",
            createdAt: "2026-08-02T09:10:00.000Z",
            active: true,
            arrivedWhenExpected: false,
            asDescribed: true,
            goodCommunication: true,
          },
        ],
        aggregation: {
          totalRatings: 42,
          fiveStar: 36,
          fourStar: 4,
          threeStar: 1,
          twoStar: 0,
          oneStar: 1,
          arrivedWhenExpected: { positive: 37, negative: 2, unanswered: 3 },
          asDescribed: { positive: 39, negative: 1, unanswered: 2 },
          goodCommunication: { positive: 34, negative: 1, unanswered: 7 },
          totalAdditionalRatings: 114,
        },
        storefrontUrl:
          "https://store.tcgplayer.com/sellerfeedback/synthetic-seller",
        fetchedAt: now,
      }),
  },
  messageService: {
    unreadCount: () => Promise.resolve(previewUnreadMessageCount),
    markRead: () => {
      previewUnreadMessageCount = 0;
      return Promise.resolve();
    },
    reply: (_threadId, body) => {
      previewReplies.push({
        messageId: 2000 + previewReplies.length,
        body,
        createdAt: now,
        responseRequired: false,
        isRead: true,
        senderDisplayName: "You",
      });
      return Promise.resolve();
    },
    list: ({ page = 1, orderNumber, includeDeleted = false }) => {
      const threads = [
        {
          threadId: 101,
          unreadMessageCount: previewUnreadMessageCount,
          totalMessageCount: 3 + previewReplies.length,
          subject: "Question about shipping",
          orderType: "Marketplace",
          orderNumber: orders[0].orderNumber,
          orderStatus: "Ready to Ship",
          createdAt: "2026-08-07T15:05:00.000Z",
          respondedAt: "2026-08-07T16:10:00.000Z",
          deleted: false,
          senderDisplayName: "Taylor M.",
          receiverDisplayName: "You",
        },
        {
          threadId: 102,
          unreadMessageCount: 0,
          totalMessageCount: 1,
          subject: "Thanks for the careful packaging",
          orderType: "Marketplace",
          orderNumber: orders[1].orderNumber,
          orderStatus: "Shipped",
          createdAt: "2026-08-06T20:15:00.000Z",
          deleted: false,
          senderDisplayName: "Jordan L.",
          receiverDisplayName: "You",
        },
      ].filter(
        (thread) =>
          (includeDeleted || !thread.deleted) &&
          (orderNumber === undefined || thread.orderNumber === orderNumber),
      );
      return Promise.resolve({
        page,
        pageSize: 25,
        totalPages: 1,
        totalThreads: threads.length,
        unreadCount: previewUnreadMessageCount,
        threads,
        portalUrl: "https://sellerportal.tcgplayer.com/messages",
        fetchedAt: now,
      });
    },
    get: (threadId, { page = 1 } = {}) =>
      Promise.resolve({
        threadId,
        subject: "Question about shipping",
        totalMessageCount: 3 + previewReplies.length,
        messages: [
          {
            messageId: 1001,
            body: "Will this order include tracking?",
            createdAt: "2026-08-07T15:05:00.000Z",
            responseRequired: true,
            isRead: previewUnreadMessageCount === 0,
            senderDisplayName: "Taylor M.",
          },
          {
            messageId: 1002,
            body: "Yes, tracking will be added when the order ships.",
            createdAt: "2026-08-07T15:22:00.000Z",
            responseRequired: false,
            isRead: true,
            senderDisplayName: "You",
          },
          {
            messageId: 1003,
            body: "Perfect, thank you!",
            createdAt: "2026-08-07T16:10:00.000Z",
            responseRequired: false,
            isRead: previewUnreadMessageCount === 0,
            senderDisplayName: "Taylor M.",
          },
          ...previewReplies,
        ],
        orderType: "Marketplace",
        orderNumber: orders[0].orderNumber,
        deleted: false,
        page,
        pageSize: 25,
        totalPages: 1,
        portalUrl: `https://sellerportal.tcgplayer.com/messages/${String(threadId)}`,
        fetchedAt: now,
      }),
  },
  shipmentScannerService: {
    status: () =>
      Promise.resolve({
        enabled: true,
        automaticallyMarkShipped: false,
        soundEnabled: false,
        readyOrderCount: 2,
        readyTagIds: orders
          .filter((order) => order.canMarkShipped)
          .map((order) => shipmentTagId(order.orderNumber)),
        conflictingTagCount: 0,
        reviewRequiredCount: 0,
        snapshotFetchedAt: now,
      }),
    scan: (tagId) => {
      const order = orders.find(
        (candidate) =>
          candidate.canMarkShipped &&
          shipmentTagId(candidate.orderNumber) === tagId,
      );
      return Promise.resolve(
        order === undefined
          ? { state: "no-match", tagId }
          : { state: "matched", tagId, order },
      );
    },
    markShipped: (tagId, orderNumber) =>
      Promise.resolve({ state: "already-processed", tagId, orderNumber }),
  },
  executePrintTest: () => Promise.resolve(),
});

process.stdout.write(`Synthetic UI preview: ${server.url}\n`);
