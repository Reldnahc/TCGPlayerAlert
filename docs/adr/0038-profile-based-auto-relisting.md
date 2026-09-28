# 0038 — Profile-based auto-relisting and initial listing

Auto-relist setup belongs to each local inventory item. Operators choose a pricing profile or a manual price and a public quantity cap, then review and explicitly submit an initial listing without changing local stock. Existing watch-only and pause actions remain available.

Profile prices use the existing exact-SKU addition pricing policy with fresh comparisons and the default listing shipping estimate. Profiles are loaded from current configuration for each replacement; saved fixed-price overrides take precedence. Missing profiles or unsupported pricing stop the submission rather than falling back to an old price. Legacy rules retain their manual prices.

Initial listing reviews are single-use, expire after five minutes, and are checked against fresh stock, account, rule, quantity and price before submission. Pending shipment tickets block initial top-ups. The local inventory lease serializes configuration and sales; the inventory queue lease rejects conflicting active jobs during submission. Persist a running attempt before remote mutation; ambiguous or interrupted attempts require reconciliation and cannot retry automatically. Shipped-sale replacements retain their existing shipment gate and sale-credit cap.
