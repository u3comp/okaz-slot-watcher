# Controlled CUJ Status

Status: `CONTROLLED_PRODUCTION_CUJ_ACCEPTANCE_COMPLETE`

The URL-bearing production notification renderer and isolated acceptance
state path were exercised in Production. The human receipt check confirmed
five Discord deliveries and five LINE deliveries, with the target URL
opening successfully and no duplicate or sixth-round delivery.

Acceptance Test ID: `CF-CUJ-20260806-249cd32a-acb2-4f1c-85f6-f8ab507f9f24`

The final Production version is `1795c1d6-ce9e-4e71-9edf-c4cdd8b0c88e`
(100% deployment `95587214-3554-4e14-a907-5b365a35dd6d`). The isolated
acceptance state remains as complete evidence (`phase=complete`, rounds
1-5, pending=0); no cleanup function exists and no canonical watcher state
was deleted or reset.

The Acceptance Harness is disabled in the final version: both acceptance
endpoints return HTTP 404 and the temporary `ACCEPTANCE_HARNESS_TOKEN`
binding is absent. The normal health endpoint remains HTTP 200 in group mode.

The final production version must keep:

- `DRY_RUN=false`
- `LINE_ENABLED=true`
- `LINE_DESTINATION_MODE=group`
- `ACCEPTANCE_HARNESS_ENABLED=false`
- the exact configured purchase-page URL

The natural real-site transition boundary is intentionally separate:
`FULL_REAL_SITE_NATURAL_TRANSITION: NOT_YET_OBSERVED`.
