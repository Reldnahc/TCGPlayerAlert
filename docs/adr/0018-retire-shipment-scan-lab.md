# ADR 0018: Retire the shipment Scan lab

## Status

Accepted.

## Context

ADR 0016 introduced a synthetic Scan lab to validate label geometry, AprilTag
detection, five-read consensus, continuous camera operation, and basket
handling without seller data or shipment mutations. The installed DYMO printer,
label stock, webcam, and five-parcel basket test passed at the intended
workstation. ADR 0017 then introduced the guarded production Scanner.

Keeping a second operator workspace would duplicate the camera experience,
retain a synthetic print endpoint in the running service, and create ambiguity
about which scanner should be used.

## Decision

Remove the Scan lab navigation item, page, synthetic cases, print endpoint,
runtime print helper, and lab-specific styles and tests. Keep the AprilTag
generator, detector, consensus controller, printer rendering, and production
Scanner.

Exercise the real production Scanner in browser regression tests against a
synthetic preview server. The test process generates a local AprilTag PNG,
uploads it through Scanner, initializes the production WebAssembly detector,
and resolves a synthetic ready order. It cannot contact TCGplayer, print, or
mutate an order.

Keep ADR 0016 as historical evidence for the safety experiment and mark it
superseded rather than deleting the decision record.

## Consequences

- Operators have one shipment-scanning workspace.
- The running service no longer exposes a synthetic label-print route.
- Production detector coverage remains independent of seller credentials,
  real customer data, printers, and shipment mutations.
- Printer routing continues to use the ordinary synthetic test-label controls
  in Settings.
