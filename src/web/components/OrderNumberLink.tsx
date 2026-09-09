import type { ComponentChildren } from "preact";
import { orderDetailUrl } from "../api.js";
import type { ProviderOrderRef } from "../../marketplaces/identity.js";

export function OrderNumberLink({
  orderNumber,
  orderRef,
  children,
}: {
  readonly orderNumber: string;
  readonly orderRef?: ProviderOrderRef;
  readonly children?: ComponentChildren;
}) {
  if (orderRef === undefined) {
    return <span class="numeric">{children ?? orderNumber}</span>;
  }
  return (
    <a class="order-number-link numeric" href={orderDetailUrl(orderRef)}>
      {children ?? orderNumber}
    </a>
  );
}
