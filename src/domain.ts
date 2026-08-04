export interface ShippingAddress {
  readonly recipientName: string;
  readonly addressOne: string;
  readonly addressTwo?: string;
  readonly city: string;
  readonly territory: string;
  readonly country: string;
  readonly postalCode: string;
}

export interface OrderItem {
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface FulfillmentOrder {
  readonly provider: string;
  readonly id: string;
  readonly placedAt: string;
  readonly status: string;
  readonly channel: string;
  readonly fulfillment: string;
  readonly shippingType: string;
  readonly totalAmount: number;
  readonly buyerPaid: boolean;
  /** Ephemeral workflow data. It must not be written to application state or logs. */
  readonly shippingAddress: ShippingAddress;
  /** Ephemeral workflow data. It must not be written to application state or logs. */
  readonly items: readonly OrderItem[];
}

export interface FulfillmentDocument {
  readonly kind: "packing-slip";
  readonly mediaType: "application/pdf";
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface DiscoveredOrder {
  readonly id: string;
  readonly status: string;
}

export interface OrderProvider {
  readonly id: string;
  discoverReadyToShip(
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredOrder[]>;
  confirmOrder(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<FulfillmentOrder>;
  getPackingSlip(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<FulfillmentDocument>;
}
