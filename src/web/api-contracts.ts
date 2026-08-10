import type {
  AdditionPreview,
  CatalogProduct,
  CatalogSearch,
  FeedbackPage,
  InventoryJob,
  InventoryQueueResponse,
  InternalJobsResponse,
  JobRunResponse,
  JobScheduleResponse,
  DeletedResponse,
  MasterPullList,
  MarkAllMessagesReadResult,
  MessageMutationResult,
  MessagesPage,
  MessageThread,
  OrderDetail,
  OrderList,
  PaymentDetail,
  PaymentsPage,
  PirateShipResult,
  PriceJob,
  PriceQueueResponse,
  PricingPreview,
  PricingRules,
  QueuedJob,
  QueuedJobs,
  ReadyOrderSnapshot,
  RefundOptions,
  RefundResult,
  SellerConnectionStatus,
  SellerPairingChallenge,
  Settings,
  ShipmentResult,
  ShipmentScanResult,
  ShipmentScannerStatus,
  TrackingResult,
  UnreadMessages,
} from "./contracts.js";
import {
  array,
  boolean,
  calendarDate,
  enumeration,
  integer,
  isoDateTime,
  keyedRecord,
  literal,
  nullable,
  nonNegativeInteger,
  number,
  object,
  optional,
  text,
  union,
  type Decoder,
} from "./decoder.js";

const condition = enumeration(
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
  "Unopened",
);
const printing = enumeration("Normal", "Foil");
const orderStatus = enumeration(
  "Canceled",
  "Delivered",
  "PickedUp",
  "PickupOrderCanceled",
  "Processing",
  "Pulling",
  "ReadyForPickup",
  "ReadyToShip",
  "Received",
  "Shipped",
  "ShippedOrderCanceled",
  "Unknown",
);

const gamePricingModule = object({
  type: literal("magic-rarity-floor"),
  enabled: boolean,
  floors: array(object({ rarity: text, minimumPrice: number })),
});

const repricingRange = object({
  maximumPrice: optional(number),
  minimumListings: nonNegativeInteger,
  priceSource: enumeration("lowest", "market"),
  percentage: number,
  gapThresholdPercent: number,
  gapAction: enumeration("follow-lowest", "use-next", "skip"),
  supportMode: optional(enumeration("adjacent", "cluster")),
  minimumSellerSupport: optional(nonNegativeInteger),
  supportWindowPercent: optional(number),
});

const repricingProfile = object({
  id: text,
  name: text,
  minimumPrice: number,
  conditionPolicy: enumeration("same", "same-or-better"),
  priceBasis: enumeration("item", "delivered"),
  adjustmentCents: integer,
  allowPriceIncreases: boolean,
  sparseMarketFallback: enumeration(
    "skip",
    "higher-of-market-and-lowest",
    "market-then-lowest",
    "lowest-then-market",
  ),
  gamePricingModules: array(gamePricingModule),
  ranges: array(repricingRange),
});

const merchandiseProfile = object({
  id: text,
  name: text,
  language: text,
  estimatedShippingPrice: number,
  defaultCondition: condition,
  defaultPrinting: printing,
  pricingProfileId: text,
});

const outputBase = {
  actionId: text,
  enabled: boolean,
  printerId: text,
  printerName: text,
  adapter: enumeration("command", "windows-native-label", "windows-pdf"),
  adapterLabel: text,
} as const;
const addressOutput = object({
  ...outputBase,
  type: literal("print-address-label"),
  widthMm: number,
  heightMm: number,
  marginMm: number,
  fontSize: number,
});
const packingOutput = object({
  ...outputBase,
  type: literal("print-packing-slip"),
  dpi: optional(number),
  scale: optional(enumeration("actual-size", "fit", "shrink")),
});

export const settingsDecoder: Decoder<Settings> = object({
  revision: text,
  pollIntervalMinutes: nonNegativeInteger,
  confirmBeforeMarkingShipped: boolean,
  shipmentScanner: object({
    enabled: boolean,
    automaticallyMarkShipped: boolean,
    soundEnabled: boolean,
    camera: object({ enabled: boolean, deviceId: text }),
  }),
  priceUpdateQueue: object({
    enabled: boolean,
    delaySeconds: nonNegativeInteger,
  }),
  inventoryAdditionQueue: object({
    enabled: boolean,
    delaySeconds: nonNegativeInteger,
  }),
  merchandiseProfiles: array(merchandiseProfile),
  defaultMerchandiseProfileId: text,
  repricingProfiles: array(repricingProfile),
  defaultRepricingProfileId: text,
  outputs: array(union(addressOutput, packingOutput)),
  installedPrinters: array(object({ name: text, isDefault: boolean })),
  installedCameras: array(
    object({ id: text, label: text, isDefault: boolean }),
  ),
  discoveryIssue: optional(text),
  cameraDiscoveryIssue: optional(text),
});

export const sellerConnectionDecoder: Decoder<SellerConnectionStatus> = object({
  state: enumeration("connected", "expired", "disconnected"),
  source: optional(enumeration("browser", "environment")),
  updatedAt: optional(isoDateTime),
  expiresAt: optional(isoDateTime),
  automaticRenewal: boolean,
  protectedStorage: boolean,
});

export const sellerPairingDecoder: Decoder<SellerPairingChallenge> = object({
  pairingCode: text,
  expiresAt: isoDateTime,
  port: nonNegativeInteger,
});

export const orderSummaryDecoder = object({
  orderNumber: text,
  buyerName: text,
  orderDate: isoDateTime,
  status: text,
  statusCode: orderStatus,
  canMarkShipped: boolean,
  shippingType: text,
  productAmount: number,
  shippingAmount: number,
  totalAmount: number,
});

export const orderListDecoder: Decoder<OrderList> = object({
  orders: array(orderSummaryDecoder),
  fetchedAt: isoDateTime,
});

export const readyOrderSnapshotDecoder: Decoder<ReadyOrderSnapshot> = object({
  snapshot: nullable(orderListDecoder),
});

const orderTax = object({ code: text, amount: number });
const orderTransaction = object({
  productAmount: number,
  shippingAmount: number,
  grossAmount: number,
  feeAmount: number,
  netAmount: number,
  directFeeAmount: number,
  taxes: array(orderTax),
});
const orderAddress = object({
  recipientName: text,
  addressOne: text,
  addressTwo: optional(text),
  city: text,
  territory: text,
  country: text,
  postalCode: text,
});
const orderProduct = object({
  name: text,
  unitPrice: number,
  extendedPrice: number,
  quantity: nonNegativeInteger,
  url: text,
  productId: text,
  skuId: text,
  listoId: optional(union(text, number)),
});
const orderRefund = object({
  shippingAmount: number,
  products: array(object({ skuId: text, amount: number })),
});
const trackingNumber = object({
  createdAt: isoDateTime,
  carrier: text,
  trackingNumber: text,
  status: text,
});

export const orderDetailDecoder: Decoder<OrderDetail> = object({
  createdAt: isoDateTime,
  status: text,
  statusCode: orderStatus,
  orderChannel: text,
  orderFulfillment: text,
  orderNumber: text,
  sellerName: text,
  buyerName: text,
  paymentType: text,
  pickupStatus: text,
  shippingType: text,
  estimatedDeliveryDate: isoDateTime,
  transaction: orderTransaction,
  shippingAddress: orderAddress,
  products: array(orderProduct),
  refunds: array(orderRefund),
  refundStatus: text,
  refundCapabilities: object({ full: boolean, partial: boolean }),
  trackingNumbers: array(trackingNumber),
  canMarkShipped: boolean,
  fetchedAt: isoDateTime,
});

const pullMetadata = object({ label: text, values: array(text) });
export const pullListRowDecoder = object({
  productLine: text,
  productName: text,
  condition: text,
  number: text,
  setName: text,
  rarity: text,
  quantity: nonNegativeInteger,
  mainPhotoUrl: text,
  setReleaseDate: text,
  skuId: text,
  orderQuantity: nonNegativeInteger,
  productId: optional(nonNegativeInteger),
  metadata: array(pullMetadata),
  pulledQuantity: nonNegativeInteger,
  remainingQuantity: nonNegativeInteger,
  pulled: boolean,
  canTrackPullProgress: boolean,
});

export const masterPullListDecoder: Decoder<MasterPullList> = object({
  orderCount: nonNegativeInteger,
  rows: array(pullListRowDecoder),
  totalQuantity: nonNegativeInteger,
  pulledQuantity: nonNegativeInteger,
  remainingQuantity: nonNegativeInteger,
  fetchedAt: isoDateTime,
  metadataIssue: optional(text),
});

const scanResultBase = { tagId: nonNegativeInteger } as const;
export const shipmentScanResultDecoder: Decoder<ShipmentScanResult> = union(
  object({
    state: literal("matched"),
    ...scanResultBase,
    order: orderSummaryDecoder,
  }),
  object({
    state: literal("shipped"),
    ...scanResultBase,
    order: orderSummaryDecoder,
    outcome: enumeration("applied", "already-applied"),
  }),
  object({
    state: literal("already-processed"),
    ...scanResultBase,
    orderNumber: text,
  }),
  object({ state: literal("no-match"), ...scanResultBase }),
  object({
    state: literal("ambiguous"),
    ...scanResultBase,
    matchCount: nonNegativeInteger,
  }),
  object({
    state: literal("review-required"),
    ...scanResultBase,
    orderNumber: text,
  }),
);

const cameraStatus = object({
  state: enumeration(
    "disabled",
    "starting",
    "running",
    "processing",
    "waiting-for-review",
    "error",
    "unavailable",
  ),
  deviceId: text,
  consensus: object({
    tagId: nullable(nonNegativeInteger),
    matchingReads: nonNegativeInteger,
    requiredReads: nonNegativeInteger,
  }),
  latchedTagId: optional(nonNegativeInteger),
  lastFrameAt: optional(isoDateTime),
  lastDetectionAt: optional(isoDateTime),
  lastResultAt: optional(isoDateTime),
  lastResult: optional(shipmentScanResultDecoder),
  issue: optional(text),
});

export const shipmentScannerStatusDecoder: Decoder<ShipmentScannerStatus> =
  object({
    enabled: boolean,
    automaticallyMarkShipped: boolean,
    soundEnabled: boolean,
    readyOrderCount: nonNegativeInteger,
    readyTagIds: array(nonNegativeInteger),
    conflictingTagCount: nonNegativeInteger,
    reviewRequiredCount: nonNegativeInteger,
    snapshotFetchedAt: optional(isoDateTime),
    backgroundCamera: cameraStatus,
  });

const payoutMetadata = object({
  targetAmount: optional(number),
  targetCurrency: optional(text),
});
const payoutTransaction = object({
  createdAt: isoDateTime,
  type: enumeration("SettleOrder", "ApplyRefund", "ApplyAdjustment"),
  orderNumber: optional(text),
  amount: number,
  feeAmount: number,
  netAmount: number,
});
const payoutSummary = object({
  payoutId: text,
  referenceId: nullable(text),
  createdAt: isoDateTime,
  holdUntil: optional(isoDateTime),
  lastSentAt: optional(isoDateTime),
  amount: number,
  ordersCount: nonNegativeInteger,
  status: text,
  metadata: optional(payoutMetadata),
});
const legacyPayment = object({
  estimatedArrivalDate: nullable(calendarDate),
  initiatedDate: nullable(calendarDate),
  ordersCount: nonNegativeInteger,
  totalSales: number,
  totalFees: number,
  refundedOrders: number,
  refundedFees: number,
  adjustments: number,
  amount: number,
});

export const paymentsPageDecoder: Decoder<PaymentsPage> = union(
  object({
    experience: literal("money-movement"),
    totalPayouts: nonNegativeInteger,
    page: nonNegativeInteger,
    pageSize: nonNegativeInteger,
    payouts: array(payoutSummary),
    unpaidBalance: object({
      totalBalance: number,
      transactions: array(payoutTransaction),
    }),
    fetchedAt: isoDateTime,
  }),
  object({
    experience: literal("legacy"),
    page: nonNegativeInteger,
    totalPages: nonNegativeInteger,
    upcomingPayments: array(legacyPayment),
    pastPayments: array(legacyPayment),
    fetchedAt: isoDateTime,
  }),
);

export const paymentDetailDecoder: Decoder<PaymentDetail> = object({
  payoutId: text,
  referenceId: text,
  createdAt: isoDateTime,
  lastSentAt: optional(isoDateTime),
  amount: number,
  status: text,
  totalSales: number,
  totalRefunds: number,
  totalFees: number,
  totalAdjustments: number,
  metadata: optional(payoutMetadata),
  transactions: array(payoutTransaction),
});

const feedbackAnswerCounts = object({
  positive: nonNegativeInteger,
  negative: nonNegativeInteger,
  unanswered: nonNegativeInteger,
});
export const feedbackPageDecoder: Decoder<FeedbackPage> = object({
  page: nonNegativeInteger,
  pageSize: nonNegativeInteger,
  totalPages: nonNegativeInteger,
  totalFeedback: nonNegativeInteger,
  feedback: array(
    object({
      rating: union(literal(1), literal(2), literal(3), literal(4), literal(5)),
      comment: optional(text),
      createdAt: isoDateTime,
      updatedAt: optional(isoDateTime),
      active: boolean,
      arrivedWhenExpected: optional(boolean),
      asDescribed: optional(boolean),
      goodCommunication: optional(boolean),
      buyerDisplayName: optional(text),
    }),
  ),
  aggregation: object({
    totalRatings: nonNegativeInteger,
    fiveStar: nonNegativeInteger,
    fourStar: nonNegativeInteger,
    threeStar: nonNegativeInteger,
    twoStar: nonNegativeInteger,
    oneStar: nonNegativeInteger,
    arrivedWhenExpected: feedbackAnswerCounts,
    asDescribed: feedbackAnswerCounts,
    goodCommunication: feedbackAnswerCounts,
    totalAdditionalRatings: nonNegativeInteger,
  }),
  storefrontUrl: text,
  fetchedAt: isoDateTime,
});

const messageSummary = object({
  threadId: nonNegativeInteger,
  unreadMessageCount: nonNegativeInteger,
  totalMessageCount: nonNegativeInteger,
  senderDisplayName: text,
  receiverDisplayName: text,
  subject: text,
  orderType: text,
  orderNumber: text,
  orderStatus: text,
  createdAt: isoDateTime,
  respondedAt: optional(isoDateTime),
  activeEscalationAsOf: optional(isoDateTime),
  deleted: boolean,
});
export const messagesPageDecoder: Decoder<MessagesPage> = object({
  page: nonNegativeInteger,
  pageSize: nonNegativeInteger,
  totalPages: nonNegativeInteger,
  totalThreads: nonNegativeInteger,
  unreadCount: nonNegativeInteger,
  threads: array(messageSummary),
  portalUrl: text,
  fetchedAt: isoDateTime,
});
export const messageThreadDecoder: Decoder<MessageThread> = object({
  threadId: nonNegativeInteger,
  subject: text,
  activeEscalationAsOf: optional(isoDateTime),
  totalMessageCount: nonNegativeInteger,
  messages: array(
    object({
      messageId: nonNegativeInteger,
      body: text,
      createdAt: isoDateTime,
      senderDisplayName: text,
      responseRequired: boolean,
      isRead: boolean,
    }),
  ),
  orderType: text,
  orderNumber: text,
  deleted: boolean,
  page: nonNegativeInteger,
  pageSize: nonNegativeInteger,
  totalPages: nonNegativeInteger,
  portalUrl: text,
  fetchedAt: isoDateTime,
});
export const unreadMessagesDecoder: Decoder<UnreadMessages> = object({
  unreadCount: nonNegativeInteger,
});
export const messageMutationDecoder: Decoder<MessageMutationResult> = object({
  threadId: nonNegativeInteger,
});
export const markAllMessagesReadDecoder: Decoder<MarkAllMessagesReadResult> =
  object({ markedThreadCount: nonNegativeInteger });

export const trackingResultDecoder: Decoder<TrackingResult> = object({
  orderNumber: text,
  carrier: text,
  outcome: enumeration("applied", "already-applied"),
});
export const shipmentResultDecoder: Decoder<ShipmentResult> = object({
  orderNumber: text,
  outcome: enumeration("applied", "already-applied"),
});
export const refundOptionsDecoder: Decoder<RefundOptions> = object({
  origins: array(object({ name: text, value: text })),
  reasons: array(object({ name: text, value: text })),
});
export const refundResultDecoder: Decoder<RefundResult> = object({
  orderNumber: text,
  refundType: enumeration("full", "partial"),
  outcome: literal("submitted"),
});
export const pirateShipDecoder: Decoder<PirateShipResult> = object({
  url: literal("https://ship.pirateship.com/ship/single"),
  pasteAddress: text,
});

export const catalogSearchDecoder: Decoder<CatalogSearch> = object({
  totalProducts: nonNegativeInteger,
  productLines: array(object({ name: text, count: nonNegativeInteger })),
  sets: array(object({ name: text, count: nonNegativeInteger })),
  products: array(
    object({
      productId: nonNegativeInteger,
      imageUrl: text,
      productName: text,
      productLineName: text,
      setName: text,
      rarityName: text,
      cardNumber: text,
      colors: optional(array(text)),
      foilMarketPrice: optional(number),
      marketPrice: number,
      sellerListable: boolean,
      matchKind: enumeration("exact", "variant", "related"),
      matchRank: array(number),
    }),
  ),
  nextOffset: nonNegativeInteger,
  hasMore: boolean,
});
export const catalogProductDecoder: Decoder<CatalogProduct> = object({
  productId: nonNegativeInteger,
  imageUrl: text,
  productName: text,
  productLineName: text,
  setName: text,
  rarityName: text,
  cardNumber: text,
  colors: optional(array(text)),
  foilMarketPrice: optional(number),
  marketPrice: number,
  sellerListable: boolean,
  skus: array(
    object({
      productConditionId: nonNegativeInteger,
      conditionId: nonNegativeInteger,
      condition: text,
      printing: text,
      language: text,
    }),
  ),
});

const repricingRulesDecoder: Decoder<PricingRules> = object({
  minimumPrice: number,
  conditionPolicy: enumeration("same", "same-or-better"),
  priceBasis: enumeration("item", "delivered"),
  adjustmentCents: integer,
  allowPriceIncreases: boolean,
  sparseMarketFallback: optional(
    enumeration(
      "skip",
      "higher-of-market-and-lowest",
      "market-then-lowest",
      "lowest-then-market",
    ),
  ),
  gamePricingModules: optional(array(gamePricingModule)),
  ranges: array(
    object({
      maximumPrice: optional(number),
      minimumListings: optional(nonNegativeInteger),
      priceSource: enumeration("lowest", "market"),
      percentage: number,
      gapThresholdPercent: number,
      gapAction: enumeration("follow-lowest", "use-next", "skip"),
      supportMode: optional(enumeration("adjacent", "cluster")),
      minimumSellerSupport: optional(nonNegativeInteger),
      supportWindowPercent: optional(number),
    }),
  ),
});

export const additionPreviewDecoder: Decoder<AdditionPreview> = object({
  id: text,
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  product: object({
    productId: nonNegativeInteger,
    imageUrl: text,
    productName: text,
    productLineName: text,
    setName: text,
    rarityName: text,
    cardNumber: text,
    colors: optional(array(text)),
    foilMarketPrice: optional(number),
    marketPrice: number,
    sellerListable: boolean,
  }),
  sku: object({
    productConditionId: nonNegativeInteger,
    conditionId: nonNegativeInteger,
    condition: text,
    printing: text,
    language: text,
  }),
  currentQuantity: nonNegativeInteger,
  addQuantity: nonNegativeInteger,
  proposedPrice: optional(number),
  effectiveShippingPrice: optional(number),
  proposedDeliveredPrice: optional(number),
  competitorPrice: optional(number),
  competitorShipping: optional(number),
  competitorCondition: optional(text),
  minimumApplied: boolean,
  queueable: boolean,
  reason: text,
  rules: object({
    minimumPrice: number,
    conditionPolicy: enumeration("same", "same-or-better"),
    priceBasis: enumeration("item", "delivered"),
    adjustmentCents: integer,
    allowPriceIncreases: boolean,
    sparseMarketFallback: optional(
      enumeration(
        "skip",
        "higher-of-market-and-lowest",
        "market-then-lowest",
        "lowest-then-market",
      ),
    ),
    gamePricingModules: optional(array(gamePricingModule)),
    ranges: array(
      object({
        maximumPrice: optional(number),
        minimumListings: optional(nonNegativeInteger),
        priceSource: enumeration("lowest", "market"),
        percentage: number,
        gapThresholdPercent: number,
        gapAction: enumeration("follow-lowest", "use-next", "skip"),
        supportMode: optional(enumeration("adjacent", "cluster")),
        minimumSellerSupport: optional(nonNegativeInteger),
        supportWindowPercent: optional(number),
      }),
    ),
    estimatedShippingPrice: number,
  }),
});

const sellerAddition = object({
  productId: nonNegativeInteger,
  productName: text,
  productConditionId: nonNegativeInteger,
  conditionId: nonNegativeInteger,
  channelId: nonNegativeInteger,
  categoryName: text,
  currentQuantity: nonNegativeInteger,
  addQuantity: nonNegativeInteger,
  price: number,
  storePriceCustomId: nullable(number),
  reserveQuantity: nonNegativeInteger,
});
const sellerRemoval = object({
  productId: nonNegativeInteger,
  productName: text,
  productConditionId: nonNegativeInteger,
  conditionId: nonNegativeInteger,
  channelId: nonNegativeInteger,
  categoryName: text,
  currentQuantity: nonNegativeInteger,
  price: number,
  storePriceCustomId: nullable(number),
  reserveQuantity: nonNegativeInteger,
});
const jobBase = {
  id: text,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  attempts: nonNegativeInteger,
  nextAttemptAt: optional(isoDateTime),
  errorCode: optional(text),
  resubmittedFromJobId: optional(text),
  sourceRunId: optional(text),
} as const;
const inventoryJobDecoder: Decoder<InventoryJob> = union(
  object({
    ...jobBase,
    status: enumeration(
      "pending",
      "applying",
      "submitted",
      "failed",
      "review-required",
      "superseded",
      "canceled",
    ),
    operation: literal("add"),
    addition: sellerAddition,
  }),
  object({
    ...jobBase,
    status: enumeration(
      "pending",
      "applying",
      "submitted",
      "failed",
      "review-required",
      "superseded",
      "canceled",
    ),
    operation: literal("remove"),
    removal: sellerRemoval,
  }),
);
const sellerPriceUpdate = object({
  productId: nonNegativeInteger,
  productName: text,
  productConditionId: nonNegativeInteger,
  conditionId: nonNegativeInteger,
  channelId: nonNegativeInteger,
  categoryName: text,
  quantity: nonNegativeInteger,
  price: number,
  storePriceCustomId: nullable(number),
  reserveQuantity: nonNegativeInteger,
});
const priceJobDecoder: Decoder<PriceJob> = object({
  ...jobBase,
  update: sellerPriceUpdate,
  status: enumeration(
    "pending",
    "applying",
    "applied",
    "failed",
    "review-required",
    "superseded",
    "canceled",
  ),
});

export const inventoryQueueDecoder: Decoder<InventoryQueueResponse> = object({
  jobs: array(inventoryJobDecoder),
  counts: keyedRecord(
    [
      "pending",
      "applying",
      "submitted",
      "failed",
      "review-required",
      "superseded",
      "canceled",
    ] as const,
    nonNegativeInteger,
  ),
  workerRunning: boolean,
});
export const priceQueueDecoder: Decoder<PriceQueueResponse> = object({
  jobs: array(priceJobDecoder),
  counts: keyedRecord(
    [
      "pending",
      "applying",
      "applied",
      "failed",
      "review-required",
      "superseded",
      "canceled",
    ] as const,
    nonNegativeInteger,
  ),
  workerRunning: boolean,
});
export const queuedInventoryJobsDecoder: Decoder<QueuedJobs<InventoryJob>> =
  object({ jobs: array(inventoryJobDecoder) });
export const queuedPriceJobsDecoder: Decoder<QueuedJobs<PriceJob>> = object({
  jobs: array(priceJobDecoder),
});
export const queuedInventoryJobDecoder: Decoder<QueuedJob<InventoryJob>> =
  object({ job: inventoryJobDecoder });
export const queuedPriceJobDecoder: Decoder<QueuedJob<PriceJob>> = object({
  job: priceJobDecoder,
});

const scheduleTiming = union(
  object({ kind: literal("once"), runAt: isoDateTime }),
  object({
    kind: literal("interval"),
    everyMinutes: nonNegativeInteger,
    anchorAt: isoDateTime,
  }),
  object({ kind: literal("daily"), timeOfDay: text, timeZone: text }),
  object({
    kind: literal("weekly"),
    weekdays: array(nonNegativeInteger),
    timeOfDay: text,
    timeZone: text,
  }),
);
const repricingLimits = object({
  maximumUpdates: nonNegativeInteger,
  maximumDecreasePercent: number,
  maximumDecreaseAmount: number,
  maximumIncreasePercent: number,
  maximumBlockedPercent: number,
});
const listingItem = object({
  productId: nonNegativeInteger,
  productConditionId: nonNegativeInteger,
  productName: text,
  quantity: nonNegativeInteger,
});
const internalPayload = union(
  object({
    type: literal("reprice-inventory"),
    pricingProfileId: text,
    mode: enumeration("review", "automatic"),
    scope: literal("all"),
    limits: repricingLimits,
  }),
  object({
    type: literal("list-inventory"),
    merchandiseProfileId: text,
    items: array(listingItem),
  }),
);
const internalSchedule = object({
  id: text,
  name: text,
  enabled: boolean,
  timing: scheduleTiming,
  payload: internalPayload,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  nextRunAt: optional(isoDateTime),
  lastRunAt: optional(isoDateTime),
  lastRunId: optional(text),
});
const internalReportItem = object({
  key: text,
  productName: text,
  outcome: enumeration(
    "queued",
    "proposed",
    "unchanged",
    "skipped",
    "review-required",
  ),
  quantity: optional(nonNegativeInteger),
  currentPrice: optional(number),
  proposedPrice: optional(number),
  reason: optional(text),
});
const internalReport = object({
  proposed: nonNegativeInteger,
  queuedPriceJobs: nonNegativeInteger,
  queuedInventoryJobs: nonNegativeInteger,
  unchanged: nonNegativeInteger,
  skipped: nonNegativeInteger,
  reviewRequired: nonNegativeInteger,
  truncatedItems: nonNegativeInteger,
  items: array(internalReportItem),
});
const internalRun = object({
  id: text,
  scheduleId: text,
  scheduleName: text,
  payload: internalPayload,
  trigger: enumeration("scheduled", "manual"),
  status: enumeration(
    "queued",
    "running",
    "succeeded",
    "partial",
    "failed",
    "review-required",
    "canceled",
    "skipped",
  ),
  scheduledFor: isoDateTime,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  startedAt: optional(isoDateTime),
  completedAt: optional(isoDateTime),
  nextAttemptAt: optional(isoDateTime),
  attempts: nonNegativeInteger,
  report: optional(internalReport),
  errorCode: optional(text),
});

export const internalJobsDecoder: Decoder<InternalJobsResponse> = object({
  schedules: array(internalSchedule),
  runs: array(internalRun),
  runnerRunning: boolean,
});
export const jobScheduleResponseDecoder: Decoder<JobScheduleResponse> = object({
  schedule: internalSchedule,
});
export const jobRunResponseDecoder: Decoder<JobRunResponse> = object({
  run: internalRun,
});
export const deletedResponseDecoder: Decoder<DeletedResponse> = object({
  deleted: boolean,
});

const repricingRow = object({
  id: text,
  productId: nonNegativeInteger,
  productConditionId: nonNegativeInteger,
  productName: text,
  productLineName: text,
  setName: text,
  condition: text,
  printing: text,
  language: text,
  quantity: nonNegativeInteger,
  currentPrice: number,
  currentShipping: number,
  proposedPrice: number,
  competitorPrice: optional(number),
  competitorShipping: optional(number),
  competitorPricingShipping: optional(number),
  competitorCondition: optional(text),
  marketPrice: optional(number),
  lowestPrice: optional(number),
  lowestShipping: optional(number),
  nextLowestPrice: optional(number),
  nextLowestShipping: optional(number),
  gapPercent: optional(number),
  qualifyingListings: optional(nonNegativeInteger),
  comparisonSampleIncomplete: optional(boolean),
  comparisonSource: optional(enumeration("batched", "exact")),
  distinctSellers: optional(nonNegativeInteger),
  minimumQualifyingListings: optional(nonNegativeInteger),
  supportMode: optional(enumeration("adjacent", "cluster")),
  lowestSellerSupport: optional(nonNegativeInteger),
  minimumSellerSupport: optional(nonNegativeInteger),
  supportWindowPercent: optional(number),
  supportedClusterPrice: optional(number),
  supportedClusterShipping: optional(number),
  supportedClusterSellerCount: optional(nonNegativeInteger),
  gapActionApplied: optional(enumeration("use-next", "skip")),
  pricingSource: optional(
    enumeration("lowest", "market", "next-lowest", "supported-cluster"),
  ),
  pricingPercentage: optional(number),
  sparseMarketFallbackApplied: optional(
    enumeration(
      "higher-of-market-and-lowest",
      "market-then-lowest",
      "lowest-then-market",
    ),
  ),
  rangeMaximumPrice: optional(number),
  minimumApplied: boolean,
  effectiveMinimumPrice: optional(number),
  minimumPriceSource: optional(text),
  status: enumeration("ready", "unchanged", "skipped"),
  reason: text,
  queueable: boolean,
  removable: optional(boolean),
  removalReason: optional(text),
});

export const pricingPreviewDecoder: Decoder<PricingPreview> = object({
  id: text,
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  rules: repricingRulesDecoder,
  rows: array(repricingRow),
  counts: keyedRecord(
    ["ready", "unchanged", "skipped"] as const,
    nonNegativeInteger,
  ),
  totals: object({
    listingCount: nonNegativeInteger,
    totalQuantity: nonNegativeInteger,
    currentListingValue: number,
  }),
  marketplaceSnapshot: object({
    capturedAt: isoDateTime,
    expiresAt: isoDateTime,
    source: enumeration("fresh", "cache", "shared"),
  }),
});
