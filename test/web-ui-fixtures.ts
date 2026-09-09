// @vitest-environment jsdom

import { cleanup } from "@testing-library/preact";
import { vi } from "vitest";
import type { Settings } from "../src/web/contracts.js";
import { DEFAULT_PULL_LIST_BINNING_CONFIG } from "../src/pull-list-binning.js";
export const settings: Settings = {
  revision: "synthetic-revision",
  pollIntervalMinutes: 5,
  confirmBeforeMarkingShipped: true,
  masterPullList: {
    groupLands: true,
    groupMulticolored: true,
    binning: DEFAULT_PULL_LIST_BINNING_CONFIG,
  },
  notifications: {
    discord: {
      enabled: false,
      events: {
        authenticationRequired: true,
        inboundMessage: true,
        orderCanceled: true,
        shipmentMarkAttempt: true,
      },
    },
  },
  shipmentScanner: {
    enabled: false,
    automaticallyMarkShipped: false,
    soundEnabled: true,
    camera: { enabled: false, deviceId: "" },
  },
  priceUpdateQueue: { enabled: true, delaySeconds: 0 },
  inventoryAdditionQueue: { enabled: true, delaySeconds: 0 },
  merchandiseProfiles: [
    {
      id: "english-singles",
      name: "English singles",
      language: "English",
      estimatedShippingPrice: 1.49,
      defaultCondition: "Near Mint",
      defaultPrinting: "Normal",
      pricingProfileId: "match-lowest",
    },
  ],
  defaultMerchandiseProfileId: "english-singles",
  repricingProfiles: [
    {
      id: "match-lowest",
      name: "Conservative",
      minimumPrice: 0.25,
      conditionPolicy: "same-or-better",
      priceBasis: "delivered",
      adjustmentCents: 0,
      allowPriceIncreases: true,
      unsupportedSellerBandAction: "wait",
      automaticDecreaseGuard: true,
      automaticDecreaseThresholdPercent: 25,
      automaticDecreaseThresholdAmount: 0.5,
      sparseMarketFallback: "higher-of-market-and-lowest",
      gamePricingModules: [],
      ranges: [
        {
          minimumListings: 2,
          priceSource: "lowest",
          percentage: 100,
          gapThresholdPercent: 10,
          gapAction: "use-next",
          supportMode: "cluster",
          minimumSellerSupport: 2,
          supportWindowPercent: 5,
        },
      ],
    },
  ],
  defaultRepricingProfileId: "match-lowest",
  outputs: [
    {
      actionId: "address-label",
      type: "print-address-label",
      enabled: true,
      printerId: "label",
      printerName: "Synthetic Label Printer",
      adapter: "windows-native-label",
      adapterLabel: "Windows label",
      widthMm: 89,
      heightMm: 28,
      marginMm: 3,
      fontSize: 14,
    },
    {
      actionId: "packing-slip",
      type: "print-packing-slip",
      enabled: true,
      printerId: "office",
      printerName: "Synthetic Office Printer",
      adapter: "windows-pdf",
      adapterLabel: "Windows PDF",
      dpi: 200,
      scale: "fit",
      colorMode: "black-and-white",
    },
  ],
  installedPrinters: [
    { name: "Synthetic Label Printer", isDefault: false },
    { name: "Synthetic Office Printer", isDefault: true },
  ],
  installedCameras: [
    { id: "synthetic-camera", label: "Synthetic Camera", isDefault: true },
  ],
};

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export function baseFetch(
  input: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  const path = requestPath(input);
  if (
    path === "/api/marketplace-connections" ||
    path === "/api/marketplace-connections?refresh=1"
  ) {
    return Promise.resolve(
      json({
        connections: [
          {
            descriptor: {
              connectionId: "manapool-main",
              providerId: "manapool",
              providerLabel: "ManaPool",
              connectionLabel: "ManaPool",
            },
            enabled: true,
            setup: {
              kind: "managed-credentials",
              credentialFields: [
                {
                  id: "email",
                  label: "Seller email",
                  inputType: "email",
                  secretReference: "MANAPOOL_EMAIL",
                },
                {
                  id: "access-token",
                  label: "Seller API code",
                  inputType: "password",
                  secretReference: "MANAPOOL_ACCESS_TOKEN",
                },
              ],
              secretEnvironmentNames: [
                "MANAPOOL_EMAIL",
                "MANAPOOL_ACCESS_TOKEN",
              ],
              restartRequired: false,
            },
            supportedFacets: [
              "order-pages",
              "order-details",
              "fulfillment",
              "inventory-reader",
              "inventory-mutator",
              "inventory-publisher",
              "listing-quotes",
            ],
            health: {
              state: "connected",
              checkedAt: "2026-08-07T12:00:00.000Z",
            },
          },
          {
            descriptor: {
              connectionId: "tcgplayer-main",
              providerId: "tcgplayer",
              providerLabel: "TCGplayer",
              connectionLabel: "TCGplayer",
            },
            enabled: true,
            setup: {
              kind: "browser-session",
              secretEnvironmentNames: [
                "TCGPLAYER_AUTH_COOKIE",
                "TCGPLAYER_SELLER_KEY",
              ],
              restartRequired: true,
            },
            supportedFacets: [
              "order-pages",
              "order-details",
              "fulfillment",
              "refunds",
              "native-documents",
              "pull-lines",
              "inventory-reader",
              "inventory-mutator",
              "inventory-additions",
              "catalog-search",
              "repricing",
              "payments",
              "messages",
              "feedback",
            ],
            health: {
              state: "connected",
              checkedAt: "2026-08-07T12:00:00.000Z",
            },
          },
        ],
        completedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  }
  if (path === "/api/marketplace-connections/manapool-main/credentials") {
    return Promise.resolve(
      json({
        connectionId: "manapool-main",
        configured: true,
        protectedStorage: true,
        fields: [
          {
            id: "email",
            label: "Seller email",
            inputType: "email",
            configured: true,
            source: "environment",
          },
          {
            id: "access-token",
            label: "Seller API code",
            inputType: "password",
            configured: true,
            source: "environment",
          },
        ],
      }),
    );
  }
  if (path === "/api/auth/status") {
    return Promise.resolve(
      json({
        state: "connected",
        source: "browser",
        automaticRenewal: true,
        protectedStorage: true,
        updatedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  }
  if (path === "/api/settings" && options?.method === "PUT") {
    if (typeof options.body !== "string")
      throw new Error("Expected a JSON request body.");
    const submitted = JSON.parse(options.body) as Settings;
    return Promise.resolve(
      json({
        ...settings,
        ...submitted,
        outputs: settings.outputs,
        revision: "saved-revision",
      }),
    );
  }
  if (path === "/api/settings") return Promise.resolve(json(settings));
  if (path === "/api/notifications/discord") {
    return Promise.resolve(json({ configured: false, protectedStorage: true }));
  }
  if (path === "/api/notifications/discord/connect") {
    return Promise.resolve(
      json({
        configured: true,
        source: "protected",
        protectedStorage: true,
      }),
    );
  }
  if (path === "/api/notifications/discord/disconnect") {
    return Promise.resolve(json({ configured: false, protectedStorage: true }));
  }
  if (path === "/api/notifications/discord/test") {
    return Promise.resolve(json({ delivered: true }));
  }
  if (path === "/api/shipment-scanner") {
    return Promise.resolve(
      json({
        enabled: false,
        automaticallyMarkShipped: false,
        soundEnabled: true,
        readyOrderCount: 0,
        readyTagIds: [],
        conflictingTagCount: 0,
        reviewRequiredCount: 0,
        backgroundCamera: {
          state: "disabled",
          deviceId: "",
          consensus: { tagId: null, matchingReads: 0, requiredReads: 0 },
        },
      }),
    );
  }
  if (path === "/api/orders?status=ready-to-ship")
    return Promise.resolve(
      json({
        snapshot: {
          orders: [],
          fetchedAt: "2026-08-07T12:00:00.000Z",
        },
      }),
    );
  if (path === "/api/orders/ready" || path === "/api/orders/sync")
    return Promise.resolve(
      json({
        data: [],
        issues: [],
        completedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  if (path.startsWith("/api/orders"))
    return Promise.resolve(
      json({
        data: [],
        issues: [],
        completedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  if (path.startsWith("/api/payments"))
    return Promise.resolve(
      json({
        experience: "money-movement",
        totalPayouts: 0,
        page: 1,
        pageSize: 25,
        payouts: [],
        unpaidBalance: { totalBalance: 0, transactions: [] },
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  if (path.startsWith("/api/feedback"))
    return Promise.resolve(
      json({
        page: 1,
        pageSize: 25,
        totalPages: 1,
        totalFeedback: 0,
        feedback: [],
        aggregation: {
          totalRatings: 0,
          fiveStar: 0,
          fourStar: 0,
          threeStar: 0,
          twoStar: 0,
          oneStar: 0,
          arrivedWhenExpected: { positive: 0, negative: 0, unanswered: 0 },
          asDescribed: { positive: 0, negative: 0, unanswered: 0 },
          goodCommunication: { positive: 0, negative: 0, unanswered: 0 },
          totalAdditionalRatings: 0,
        },
        storefrontUrl:
          "https://store.tcgplayer.com/sellerfeedback/synthetic-seller",
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  if (path.startsWith("/api/messages/unread-count"))
    return Promise.resolve(json({ unreadCount: 0 }));
  if (/^\/api\/messages\/\d+/u.test(path))
    return Promise.resolve(
      json({
        threadId: 1,
        subject: "Synthetic conversation",
        totalMessageCount: 0,
        messages: [],
        orderType: "SellerOrder",
        orderNumber: "",
        deleted: false,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        portalUrl: "https://sellerportal.tcgplayer.com/messages/1",
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  if (path.startsWith("/api/messages"))
    return Promise.resolve(
      json({
        page: 1,
        pageSize: 25,
        totalPages: 1,
        totalThreads: 0,
        unreadCount: 0,
        threads: [],
        portalUrl: "https://sellerportal.tcgplayer.com/messages",
        fetchedAt: "2026-08-07T12:00:00.000Z",
      }),
    );
  throw new Error(`Unexpected request: ${path}`);
}

export function resetWebUiTest(): void {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.location.hash = "";
}
