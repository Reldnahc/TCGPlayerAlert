export const TRACKING_REQUIRED_TOTAL = 50;

export function requiresShipmentTracking(totalAmount: number): boolean {
  return totalAmount >= TRACKING_REQUIRED_TOTAL;
}
