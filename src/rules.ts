import type { RuleConfig, RuleField, RulePredicateConfig } from "./config.js";
import type { FulfillmentOrder } from "./domain.js";

export interface RuleEvaluation {
  readonly ruleId: string;
  readonly matched: boolean;
  readonly reasons: readonly string[];
  readonly actionIds: readonly string[];
}

type RuleValue = string | number | boolean;

function fieldValue(order: FulfillmentOrder, field: RuleField): RuleValue {
  switch (field) {
    case "order.status":
      return order.status;
    case "order.channel":
      return order.channel;
    case "order.fulfillment":
      return order.fulfillment;
    case "order.shippingType":
      return order.shippingType;
    case "order.totalAmount":
      return order.totalAmount;
    case "order.buyerPaid":
      return order.buyerPaid;
    case "order.productCount":
      return order.items.length;
    case "order.itemQuantity":
      return order.items.reduce((total, item) => total + item.quantity, 0);
  }
}

function predicateMatches(
  order: FulfillmentOrder,
  predicate: RulePredicateConfig,
): boolean {
  const actual = fieldValue(order, predicate.field);
  switch (predicate.operator) {
    case "eq":
      return actual === predicate.value;
    case "neq":
      return actual !== predicate.value;
    case "in":
      return (
        Array.isArray(predicate.value) &&
        typeof actual === "string" &&
        predicate.value.includes(actual)
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof predicate.value === "number" &&
        actual >= predicate.value
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof predicate.value === "number" &&
        actual <= predicate.value
      );
  }
}

export function evaluateRules(
  order: FulfillmentOrder,
  rules: readonly RuleConfig[],
): readonly RuleEvaluation[] {
  return rules.map((rule) => {
    if (!rule.enabled) {
      return {
        ruleId: rule.id,
        matched: false,
        reasons: ["rule disabled"],
        actionIds: [],
      };
    }
    const all = rule.when.all ?? [];
    const any = rule.when.any ?? [];
    const allResults = all.map((predicate) =>
      predicateMatches(order, predicate),
    );
    const anyResults = any.map((predicate) =>
      predicateMatches(order, predicate),
    );
    const allMatched = allResults.every(Boolean);
    const anyMatched = any.length === 0 || anyResults.some(Boolean);
    const matched = allMatched && anyMatched;
    return {
      ruleId: rule.id,
      matched,
      reasons: [
        ...allResults.map(
          (result, index) =>
            `all[${String(index)}] ${result ? "matched" : "did not match"}`,
        ),
        ...anyResults.map(
          (result, index) =>
            `any[${String(index)}] ${result ? "matched" : "did not match"}`,
        ),
        ...(all.length === 0 && any.length === 0 ? ["unconditional rule"] : []),
      ],
      actionIds: matched ? rule.actions : [],
    };
  });
}
