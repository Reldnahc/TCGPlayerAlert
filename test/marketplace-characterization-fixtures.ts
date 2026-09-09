export const legacyMarketplaceStateFixtures = {
  applicationWorkflow: {
    version: 1,
    baselineCompletedAt: "2026-08-24T10:00:00.000Z",
    orders: {
      "LEGACY-TCG-100": {
        firstSeenAt: "2026-08-24T10:00:00.000Z",
        lastSeenAt: "2026-08-24T11:00:00.000Z",
        providerStatus: "ReadyToShip",
        workflowStatus: "completed",
        matchedRuleIds: ["default-fulfillment"],
        ruleReasons: {
          "default-fulfillment": ["synthetic characterization fixture"],
        },
        actions: {
          "print-address-label": {
            status: "succeeded",
            attempts: 1,
            updatedAt: "2026-08-24T11:00:00.000Z",
          },
        },
      },
    },
    lastSync: {
      correlationId: "00000000-0000-4000-8000-000000000100",
      trigger: "scheduled",
      startedAt: "2026-08-24T11:00:00.000Z",
      completedAt: "2026-08-24T11:00:01.000Z",
      outcome: "succeeded",
      discoveredCount: 1,
      processedCount: 1,
    },
  },
  pullProgress: {
    version: 1,
    orders: {
      "LEGACY-TCG-100": {
        "legacy-sku-100": {
          quantity: 2,
          pulledAt: "2026-08-24T11:05:00.000Z",
        },
      },
    },
  },
  shipmentTags: {
    version: 2,
    lastSequence: 1,
    assignments: {
      "LEGACY-TCG-100": {
        orderNumber: "LEGACY-TCG-100",
        tagId: 100,
        assignedAt: "2026-08-24T11:10:00.000Z",
        assignedSequence: 1,
      },
    },
  },
  shipmentScans: {
    version: 1,
    records: {
      "LEGACY-TCG-100": {
        orderNumber: "LEGACY-TCG-100",
        tagId: 100,
        status: "review-required",
        updatedAt: "2026-08-24T11:11:00.000Z",
      },
    },
  },
  notifications: {
    version: 1,
    readyOrderNumbers: ["LEGACY-TCG-100"],
    messages: {
      "100": {
        fingerprint: "synthetic-message-fingerprint",
        observedAt: "2026-08-24T11:12:00.000Z",
      },
    },
    deliveries: [
      {
        key: "order-canceled:LEGACY-TCG-100:Canceled",
        type: "order-canceled",
        attemptedAt: "2026-08-24T11:13:00.000Z",
        status: "delivered",
      },
      {
        key: "shipment-mark-attempt:00000000-0000-4000-8000-000000000100",
        type: "shipment-mark-attempt",
        attemptedAt: "2026-08-24T11:14:00.000Z",
        status: "failed",
        errorCode: "REVIEW_REQUIRED",
      },
    ],
  },
} as const;
