# Personal Candidate Production Deploy

判定: `PRODUCTION_PERSONAL_ROUTING_FOUNDATION_ACTIVE_GROUP_SWITCH_REVIEW_PENDING`

## Deployment

- Previous Active Version: `f655cd8e-e0c6-4768-b403-45b50bbd3b02`
- Previous Deployment: `8406f8b7-f3b3-45d6-a072-c177713500a6`
- Promoted Version: `0a685610-dbbc-40b4-bd6e-76d84051598d`
- New Deployment: `3a959931-add6-4ced-9cfb-6fc7d1ee962d`
- Traffic: promoted Version `100%`; no split traffic
- Deploy time: `2026-08-05T06:23:56.548959Z` (`2026-08-05 15:23:56 JST`)
- Rollback: not performed

## Candidate provenance

- Source Commit: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- Repository Tree: `e8ea8184e713fe4e485c27a2c71695ef35e85532`
- Worker Tree: `2433d61856e53a7cdd28eb8459c1dd94ce0c2319`
- Config Blob: `7f37031548a3b25a74f4217fe21ac165cafd3256`
- Wrangler: `4.118.0`
- Candidate tag: `line-routing-personal-9a9ea475-provenance-r2`
- Script etag: `ac7545d6811edb5bac09ff84de00339d2b0a0bc613212e156e00d6790a9cc550`

## Version and health

- Handlers: `scheduled`, `fetch`
- Compatibility date: `2026-08-02`
- D1 binding: `DB` → `04c229e8-a76b-40a8-a4b4-17c78bdcf6ff`
- Runtime variables: `DRY_RUN=false`, `LINE_ENABLED=true`, `LINE_DESTINATION_MODE=personal`
- Health: HTTP 200, `application/json`
- Health keys: exactly `line_destination_mode`, `line_user_id_configured`, `line_group_id_configured`
- Health values: `personal`, `true`, `true`; unknown keys 0; ID-like values 0
- Secret binding names were preserved; secret values were not read or recorded

## Cron and scheduled verification

The official read-only Schedules API reported one unchanged schedule before and after deploy:

- Cron: `* * * * *`
- `created_on`: `2026-08-04T12:51:43.650426Z`
- `modified_on`: `2026-08-04T12:51:43.650426Z`
- No trigger update command was used.

Wrangler tail, filtered to the promoted Version, observed three scheduled envelopes with `outcome=ok` and `cron`/`scheduledTime` fields. No raw tail payload was persisted or reported.

## D1 and notification state

| Check | Before deploy | After scheduled checks |
|---|---:|---:|
| `watcher_state.version` | 527 | 529 |
| `pending_notifications` | `[]` | `[]` |
| `consecutive_total_failures` | 0 | 0 |
| `last_error_class` | null | null |
| `last_http_status` | 200 | 200 |
| `watcher_lock.lease_until_ms` | 0 | 0 |

The D1 version advanced only through normal scheduled monitoring. No D1 write or state injection was performed. No deliberate Discord or LINE test notification was sent; no notification was observed during the checks.

## Safety and remaining gate

- Production mode remains `personal`; group mode was not changed.
- GitHub Variables/Secrets, Cloudflare Secrets/Variables, Webhook, D1 schema, and Cron configuration were not modified.
- `origin/main` remains `6cf4d439c17c1899837452b43c3f903169df9dbf`.
- Old candidate `fef3f4c1-d4cc-476e-ae98-51daff127df0` remains excluded as `SUPERSEDED_UNAPPROVED_PROVENANCE`.
- Secret values, User ID, groupId, tokens, authorization headers, and Webhook URL are not recorded.

Remaining review gates: group-mode Candidate provenance, coordinated group-mode cutover, personal rollback rehearsal, and any main/PR integration.
