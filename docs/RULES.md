# Rules

Rules select configured actions after an order is authoritatively confirmed and normalized. The format is configuration schema version 2.

An action must also be enabled to run. The settings UI's address-label and packing-slip switches update the action-level `enabled` setting, so an operator can globally suppress either output while leaving reusable rule definitions intact.

An unconditional rule:

```json
{
  "id": "default-fulfillment",
  "enabled": true,
  "when": { "all": [] },
  "actions": ["print-address-label", "print-packing-slip"]
}
```

A rule using both numeric and string conditions:

```json
{
  "id": "small-standard-order",
  "enabled": true,
  "when": {
    "all": [
      {
        "field": "order.shippingType",
        "operator": "eq",
        "value": "Standard"
      },
      {
        "field": "order.totalAmount",
        "operator": "lte",
        "value": 20
      }
    ]
  },
  "actions": ["print-address-label"]
}
```

## Conditions

`all` predicates must all match. If `any` is present, at least one `any` predicate must also match. An omitted or empty group imposes no additional condition.

Supported fields:

- String: `order.status`, `order.channel`, `order.fulfillment`, `order.shippingType`
- Number: `order.totalAmount`, `order.productCount`, `order.itemQuantity`
- Boolean: `order.buyerPaid`

Supported operators:

- `eq`, `neq` compare scalar values.
- `in` tests a string against a non-empty string array.
- `gte`, `lte` compare numeric fields to a number.

Every evaluation records safe matched/not-matched explanations in workflow state. It never stores the order's address, buyer name, products, or document contents.

## Idempotency

An order/action combination has one durable state. Successful actions are not repeated by later polls. Definite failures may retry up to `actionMaximumAttempts`. Ambiguous or interrupted print submissions become `review-required` and require operator investigation rather than automatic replay.
