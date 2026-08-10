# 0025: Validate Browser API Responses at Runtime

## Status

Accepted

## Context

TypeScript return annotations do not validate JSON received by the browser. The
operator console previously cast successful response bodies to their expected
types. A provider compatibility change, an incomplete server response, or a
stale test fixture could therefore reach a component and fail later as an
unrelated rendering error. Streamed repricing completion events had the same
problem.

The browser boundary also handles seller, customer, order, and payment data.
Validation errors must identify the broken contract without echoing response
values into the interface or logs.

## Decision

- Every successful JSON request declares a runtime decoder for its response.
- Decoder declarations are statically assigned to the corresponding shared
  contract type so missing or incompatible fields fail type checking.
- Nested failures report only the response field path and expected shape, never
  the rejected value.
- Malformed JSON and malformed error envelopes become controlled `UiApiError`
  instances.
- Repricing NDJSON progress and completion events are validated before they
  reach page state.
- Endpoints whose successful response data is deliberately unused discard it
  explicitly.

## Consequences

Browser pages receive structurally validated data and surface a stable
`INVALID_RESPONSE` error when the application server contract drifts. Contract
fixtures must represent complete production responses, which catches incomplete
mocks earlier. New browser API methods must add a decoder alongside their return
type.
