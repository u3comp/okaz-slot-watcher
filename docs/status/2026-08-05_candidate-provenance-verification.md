# Candidate Provenance Verification

判定: `PRODUCTION_CANDIDATE_PROVENANCE_BLOCKED`

## SHA roles

- Route Test Execution SHA: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- Evidence Commit／Current Remote Feature HEAD（確認時）: `e7ce07001fa94d8c7ea2686d746354ee5232d546`
- Main SHA: `6cf4d439c17c1899837452b43c3f903169df9dbf`
- Candidate Version: `fef3f4c1-d4cc-476e-ae98-51daff127df0`

## Source diff

`9a9ea475adbec3ad2b450725ce462a70ca091fa5` から `e7ce07001fa94d8c7ea2686d746354ee5232d546` へのGit差分は、証跡文書 `docs/status/2026-08-05_line-route-test-completion.md` の追加のみ。次のCandidate関連scopeに差分なし。

- `cloudflare-worker/src/`
- `cloudflare-worker/wrangler.production.toml`
- `cloudflare-worker/package.json`
- `cloudflare-worker/package-lock.json`
- `watcher/`
- `.github/workflows/`
- `scripts/`

## Candidate metadata (read-only)

- Version ID: `fef3f4c1-d4cc-476e-ae98-51daff127df0`
- tag: `line-destination-routing-personal-candidate-20260805`
- message: `Upload reversible LINE destination routing candidate in personal mode; do not deploy`
- source: `wrangler`
- upload timestamp: `2026-08-05T03:44:02.28066Z`
- handlers: `scheduled`, `fetch`
- compatibility date: `2026-08-02`
- D1 binding: `DB` → `04c229e8-a76b-40a8-a4b4-17c78bdcf6ff`
- runtime variable: `LINE_DESTINATION_MODE=personal`
- secret binding names: `DISCORD_WEBHOOK_URL`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_GROUP_ID`, `LINE_USER_ID`
- candidate traffic: `0%`
- Active Deployment inclusion: none

## Provenance result

Candidate Version metadataにはUpload時source commitがなく、Wrangler 4.118のread-only `versions view --json`はartifact本体を返さない。したがってCandidate artifactと承認対象sourceのnormalized matchは一意に証明できず、`artifact/version correspondence unverified` とする。Candidateの再Upload、Deploy、Production変更は行わない。

Secret値、User ID、groupId、Token、Webhook URLは取得・表示・保存していない。
