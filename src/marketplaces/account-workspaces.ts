import type { FeedbackManagementService } from "../feedback-management.js";
import type { MessageManagementService } from "../message-management.js";
import type { PaymentManagementService } from "../payment-management.js";
import { parseConnectionId } from "./identity.js";

export interface MarketplaceAccountServices {
  readonly payments?: PaymentManagementService;
  readonly feedback?: FeedbackManagementService;
  readonly messages?: MessageManagementService;
}

export type MarketplaceAccountServiceMap = Readonly<
  Record<string, MarketplaceAccountServices>
>;

export function marketplaceAccountServiceMap(
  entries: Readonly<Record<string, MarketplaceAccountServices>>,
): MarketplaceAccountServiceMap {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(entries).map(([connectionId, services]) => [
        parseConnectionId(connectionId),
        Object.freeze({ ...services }),
      ]),
    ),
  );
}
