# Group Candidate Provenance

判定: `PRODUCTION_GROUP_CANDIDATE_VERIFIED_SWITCH_AUTOMATION_BLOCKED`

## Source and Candidate

- Source Commit: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- Repository Tree: `e8ea8184e713fe4e485c27a2c71695ef35e85532`
- Worker Tree: `2433d61856e53a7cdd28eb8459c1dd94ce0c2319`
- Config Blob: `7f37031548a3b25a74f4217fe21ac165cafd3256`
- Wrangler: `4.118.0`
- Candidate Version: `e65c222d-49ba-4dff-95f4-a3059d26db32`
- Candidate tag: `line-routing-group-9a9ea475-provenance-r1`
- Candidate created: `2026-08-05T06:49:39.581338Z`
- Script etag: `ac7545d6811edb5bac09ff84de00339d2b0a0bc613212e156e00d6790a9cc550`
- Upload message contains the exact source/tree/config/Wrangler/mode=group/deployment=prohibited provenance

## Runtime and bindings

- Handlers: `scheduled`, `fetch`
- Compatibility date: `2026-08-02`
- Runtime variables: `DRY_RUN=false`, `LINE_ENABLED=true`, `LINE_DESTINATION_MODE=group`
- D1: `DB` → `04c229e8-a76b-40a8-a4b4-17c78bdcf6ff`
- Secret binding names preserved: Discord, LINE access token, LINE user ID, LINE group ID
- Candidate traffic: 0%; Active Personal Version remains `0a685610-dbbc-40b4-bd6e-76d84051598d` at 100%

## Preview

Versioned Preview `GET /health` returned HTTP 200 JSON with exactly:

- `line_destination_mode=group`
- `line_user_id_configured=true`
- `line_group_id_configured=true`
- unknown keys: 0
- ID-like values: 0

D1 immediately before and after Preview remained version 532, pending empty, failures 0, and lease absent. No notification was sent.

## Switch gate

The existing switch script WhatIf completed with no write commands for both group and personal rollback plans. It reported `health_probe=False` and `effective_cron_probe=False`; the official read-only health and Schedules API checks were performed separately and passed. Because the script cannot prove those gates, switch automation is blocked and no deploy or mode change is authorized by this task.

Production remains personal. GitHub `LINE_DESTINATION_MODE` is absent, so the existing default is personal. No GitHub/Cloudflare secret or variable, Cron, D1, webhook, notification, main branch, or Production traffic was changed.

Secret values, user IDs, group IDs, tokens, authorization headers, and Webhook URLs are not recorded.
