# Opportunity Surface Detection v1 — 2026-08-08

## Status

`PRODUCTION_OPPORTUNITY_SURFACE_ACCEPTANCE_PENDING`

## Confirmed facts

- Cloudflare preflight: active Worker health is normal, D1 is healthy, pending is empty, lease is free, and canonical state contains four `SOLD_OUT` slots.
- The Ecwid public `catalog/product` API returned HTTP 200 and five choices at preflight time, including `8/22（土）17:00-19:00`.
- Dynamic discovery and stable semantic identity are implemented in the Worker and Python fallback.
- Reorder, duplicate, unparseable, zero-slot, addition, reappearance, removal confirmation, and new-AVAILABLE coalescing tests pass.

## Incident reconstruction

The previous watcher monitored a fixed four-slot set. A fifth option (`8/22（土）17:00-19:00`, currently SOLD_OUT) appeared in the live product payload and was outside the fixed set, so the old implementation could not generate a new-opportunity event.

## New contract

- Discover every public product option on each five-minute observation boundary.
- Normalize labels and derive stable keys from semantic date/start time, never DOM position.
- Persist first/last seen metadata, active state, and missing-observation count.
- Emit one-shot `NEW_SLOT` for an added SOLD_OUT slot; emit a single five-round `NEW_SLOT_AVAILABLE` series for an added AVAILABLE slot.
- Confirm removals only after two observations; preserve canonical data on parser/structural anomalies.
- Keep Discord and LINE URL-bearing notification behavior and channel-specific retry rules.

## Cadence and acceptance boundary

Cloudflare Cron remains every minute, while page observation remains every five minutes to preserve the existing request/load contract. A one-minute observation cadence was not enabled without current usage, site-load, and free-tier evidence. The resulting latency boundary is up to approximately five minutes. Production candidate deployment and natural D1/Discord/LINE detection are still pending.

## Non-actions

No synthetic D1 seed, direct notification, purchase action, GitHub schedule/Issue change, secret exposure, or modification of the existing eight untracked files was performed during preflight.
