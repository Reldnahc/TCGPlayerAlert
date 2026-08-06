# ADR 0008: Searchable inventory and exact-SKU removal

- Status: Accepted
- Date: 2026-08-05

## Context

The Inventory page already loads the seller's listings to calculate a repricing preview. Operators also need to find a listing in that inventory and remove cards they no longer offer. A browser-supplied mutation payload or an immediate delete would bypass the application's preview, durability, revalidation, and audit safeguards.

Seller Portal represents removal as an inventory update that sets the exact SKU's absolute quantity to zero. A stale preview is hazardous because sales or another inventory change may alter the quantity before the queued job runs. Primary and secondary inventory for the same SKU also cannot be changed independently without a verified reserve-quantity contract.

## Decision

Inventory search filters the server-generated preview in the browser. It matches card name, product line, set, condition, printing, language, product number, and product-condition SKU. Typing in this field makes no remote requests.

Each primary-channel, non-custom listing without secondary-channel inventory receives a **Remove** action. The first click expands an inline confirmation that states the full quantity to be removed. Confirmation sends only the server-held preview id and row id; the server derives the mutation payload from its unexpired preview and writes a durable `remove` job to the inventory queue.

Add and remove jobs share one serialized worker and state document. Queuing a removal supersedes any pending inventory change for the same SKU. Immediately before mutation, the worker reloads both primary and secondary listings. It submits only when the exact primary quantity still equals the preview, the listing is not custom, and no secondary listing exists. A changed quantity becomes `review-required`. A quantity already at zero is an idempotent success. An ambiguous mutation response also becomes `review-required` and is not retried automatically.

The app consumes the package's `removeSellerInventory` contract and does not implement the private endpoint. The package sends an absolute zero quantity with no relative addition while preserving freshly observed identity and price fields.

## Consequences

- Inventory lookup reuses data already needed for repricing and adds no search-time Seller Portal load.
- Removal is explicit, full-quantity, durable, auditable, paced, and independently pausable through the inventory queue setting.
- Pending additions cannot later recreate a listing that an operator has just queued for removal.
- Partial quantity reduction, custom-listing mutation, and separate primary/secondary inventory management remain unsupported until their contracts are independently verified.
