# Controlled CUJ Status

Status: `CONTROLLED_PRODUCTION_CUJ_HUMAN_RECEIPT_PENDING`

The URL-bearing production notification renderer and isolated acceptance
state path are implemented and locally tested. Candidate upload, deployment,
real-page observation, and human receipt confirmation are still required
before this status can become `CONTROLLED_PRODUCTION_CUJ_ACCEPTANCE_COMPLETE`.

The final production version must keep:

- `DRY_RUN=false`
- `LINE_ENABLED=true`
- `LINE_DESTINATION_MODE=group`
- `ACCEPTANCE_HARNESS_ENABLED=false`
- the exact configured purchase-page URL

The natural real-site transition boundary is intentionally separate:
`FULL_REAL_SITE_NATURAL_TRANSITION: NOT_YET_OBSERVED`.
