# Candidate Version Attestation

判定: `PRODUCTION_PERSONAL_CANDIDATE_PROVENANCE_VERIFIED_DEPLOY_REVIEW_PENDING`

この文書はDeploy前の候補証跡であり、Deploy後の正本は
`docs/status/2026-08-05_line-personal-candidate-production-deploy.md`です。

## Source provenance

- Source Commit: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- Repository Tree: `e8ea8184e713fe4e485c27a2c71695ef35e85532`
- Worker Tree: `2433d61856e53a7cdd28eb8459c1dd94ce0c2319`
- Canonical Config Blob: `7f37031548a3b25a74f4217fe21ac165cafd3256`
- Wrangler: `4.118.0`
- Source worktree: clean detached HEAD at the Source Commit
- Source signature status: unsigned (`N`); parent commit is `577802c224582670e40008faad93f1168d06daa7`

## Candidate

- Version ID: `0a685610-dbbc-40b4-bd6e-76d84051598d`
- tag: `line-routing-personal-9a9ea475-provenance-r2`
- source: `wrangler`
- uploaded: `2026-08-05T06:03:26.443569Z`
- script.etag: `ac7545d6811edb5bac09ff84de00339d2b0a0bc613212e156e00d6790a9cc550`
- handlers: `scheduled`, `fetch`
- compatibility date: `2026-08-02`
- D1 binding: `DB` → `04c229e8-a76b-40a8-a4b4-17c78bdcf6ff`
- runtime variables: `DRY_RUN=false`, `LINE_ENABLED=true`, `LINE_DESTINATION_MODE=personal`
- secret binding names: `DISCORD_WEBHOOK_URL`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, `LINE_GROUP_ID`
- candidate traffic at upload: `0%`
- Active Deployment at upload: `8406f8b7-f3b3-45d6-a072-c177713500a6` with `f655cd8e-e0c6-4768-b403-45b50bbd3b02` at 100%; new Candidate not included

## Preview and state safety

- Versioned Preview `GET /health`: HTTP 200
- response keys: exactly `line_destination_mode`, `line_user_id_configured`, `line_group_id_configured`
- response values: `personal`, `true`, `true`
- unknown keys: 0
- ID-like values: 0
- D1 version immediately before/after Preview GET: `524` / `524`
- pending immediately before/after: `[]` / `[]`
- notification generated: 0

## Superseded Candidate

`fef3f4c1-d4cc-476e-ae98-51daff127df0` remains at traffic 0% and is permanently excluded from deployment as `SUPERSEDED_UNAPPROVED_PROVENANCE`; it is not a rollback or promotion target.

At the time of this pre-deploy attestation, no Candidate Deploy, Production traffic change, Secret/Variable change, notification, Cron change, D1 write, main push, force push, tag, or PR had been performed. The later approved deployment is recorded separately in the Deploy-after status document.

Secret values, User ID, groupId, Access Token, Webhook URL, Cookie, and Authorization values are not recorded.
