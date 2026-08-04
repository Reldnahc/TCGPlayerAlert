import { describe, expect, it } from "vitest";
import { evaluateRules, type RuleConfig } from "../src/index.js";
import { syntheticOrder } from "./fixtures.js";

describe("rule evaluation", () => {
  it("evaluates typed predicates and explains every decision", () => {
    const rules: RuleConfig[] = [
      {
        id: "small-standard-order",
        enabled: true,
        when: {
          all: [
            { field: "order.shippingType", operator: "eq", value: "Standard" },
            { field: "order.totalAmount", operator: "lte", value: 20 },
          ],
        },
        actions: ["label"],
      },
      {
        id: "large-order",
        enabled: true,
        when: {
          all: [{ field: "order.totalAmount", operator: "gte", value: 100 }],
        },
        actions: ["manual-review"],
      },
    ];

    const results = evaluateRules(syntheticOrder, rules);

    expect(results[0]).toMatchObject({
      ruleId: "small-standard-order",
      matched: true,
      actionIds: ["label"],
    });
    expect(results[0]?.reasons).toHaveLength(2);
    expect(results[1]).toMatchObject({ matched: false, actionIds: [] });
  });
});
