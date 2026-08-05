import type {
  AppConfig,
  FulfillmentDocument,
  FulfillmentOrder,
  Logger,
  OrderProvider,
  Printer,
  StateStore,
  WorkflowAction,
} from "../src/index.js";
import { emptyState, type ApplicationState } from "../src/state.js";

export const syntheticOrderId = "00000000000000000";

export const syntheticOrder: FulfillmentOrder = {
  provider: "synthetic",
  id: syntheticOrderId,
  placedAt: "2026-01-02T03:04:05.000Z",
  status: "ReadyToShip",
  channel: "Marketplace",
  fulfillment: "Seller",
  shippingType: "Standard",
  totalAmount: 13.75,
  buyerPaid: true,
  shippingAddress: {
    recipientName: "Example Recipient",
    addressOne: "123 Example Street",
    addressTwo: "Unit 4",
    city: "Example City",
    territory: "IL",
    country: "US",
    postalCode: "00000",
  },
  items: [{ name: "Example Card", quantity: 2, unitPrice: 6.25 }],
};

export const syntheticPackingSlip: FulfillmentDocument = {
  kind: "packing-slip",
  mediaType: "application/pdf",
  fileName: "packing-slip.pdf",
  bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF\n"),
};

export function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    pollIntervalMinutes: 60,
    actionMaximumAttempts: 3,
    dryRun: true,
    stateFile: ".data/test-state.json",
    spoolDirectory: ".spool-test",
    timezoneOffsetMinutes: "local",
    priceUpdateQueue: {
      enabled: true,
      stateFile: ".data/test-price-updates.json",
      delaySeconds: 0,
      rateLimitDelaySeconds: 300,
      historyLimit: 500,
    },
    inventoryAdditionQueue: {
      enabled: true,
      stateFile: ".data/test-inventory-additions.json",
      delaySeconds: 0,
      rateLimitDelaySeconds: 300,
      historyLimit: 500,
    },
    merchandiseProfiles: [
      {
        id: "english-singles",
        name: "English singles",
        language: "English",
        minimumPrice: 0.35,
        estimatedShippingPrice: 0,
        conditionPolicy: "same-or-better",
        priceBasis: "delivered",
        adjustmentCents: 0,
        noComparisonFallback: "market",
      },
    ],
    defaultMerchandiseProfileId: "english-singles",
    repricingProfiles: [
      {
        id: "match-lowest",
        name: "Match lowest",
        minimumPrice: 0.35,
        conditionPolicy: "same-or-better",
        priceBasis: "delivered",
        adjustmentCents: 0,
        allowPriceIncreases: false,
        ranges: [
          {
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 25,
            gapAction: "follow-lowest",
          },
        ],
      },
    ],
    defaultRepricingProfileId: "match-lowest",
    provider: {
      type: "tcgplayer",
      authCookieEnv: "TCGPLAYER_AUTH_COOKIE",
      sellerKeyEnv: "TCGPLAYER_SELLER_KEY",
      pageSize: 100,
      maximumPages: 100,
    },
    printers: {},
    actions: {},
    rules: [],
    ...overrides,
  };
}

export class MemoryStateStore implements StateStore {
  state: ApplicationState = emptyState();
  saves = 0;

  load(): Promise<ApplicationState> {
    return Promise.resolve(structuredClone(this.state));
  }

  save(state: ApplicationState): Promise<void> {
    this.saves += 1;
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

export class FakeProvider implements OrderProvider {
  readonly id = "synthetic";
  discovered: { id: string; status: string }[] = [];
  confirmations = 0;
  packingSlips = 0;
  discoveryGate: Promise<void> | undefined;

  async discoverReadyToShip() {
    await this.discoveryGate;
    return this.discovered;
  }

  confirmOrder(orderId: string) {
    this.confirmations += 1;
    return Promise.resolve({ ...syntheticOrder, id: orderId });
  }

  getPackingSlip() {
    this.packingSlips += 1;
    return Promise.resolve(syntheticPackingSlip);
  }
}

export class FakeAction implements WorkflowAction {
  calls = 0;
  lastPackingSlip: FulfillmentDocument | undefined;
  error: Error | undefined;

  constructor(
    readonly id: string,
    readonly requiresPackingSlip: boolean,
  ) {}

  execute(context: {
    readonly packingSlip?: FulfillmentDocument;
  }): Promise<void> {
    this.calls += 1;
    this.lastPackingSlip = context.packingSlip;
    if (this.error !== undefined) throw this.error;
    return Promise.resolve();
  }
}

export const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

export const successfulPrinter: Printer = {
  acceptedMediaTypes: new Set(["application/pdf"]),
  submit: () => Promise.resolve(),
};
