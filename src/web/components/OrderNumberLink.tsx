import type { ComponentChildren } from "preact";
import { orderDetailUrl } from "../api.js";

export function OrderNumberLink({
  orderNumber,
  children,
}: {
  readonly orderNumber: string;
  readonly children?: ComponentChildren;
}) {
  return (
    <a class="order-number-link numeric" href={orderDetailUrl(orderNumber)}>
      {children ?? orderNumber}
    </a>
  );
}
