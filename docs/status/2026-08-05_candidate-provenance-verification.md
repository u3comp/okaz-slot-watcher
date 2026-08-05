# Candidate Provenance Verification

判定: `PRODUCTION_PERSONAL_CANDIDATE_PROVENANCE_VERIFIED_DEPLOY_REVIEW_PENDING`

この文書はCandidateのDeploy前照合記録です。Deploy後の正本は
`docs/status/2026-08-05_line-personal-candidate-production-deploy.md`です。

## SHA roles

- Route Test Execution SHA: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- Evidence Commit／Current Remote Feature HEAD（確認時）: `3f24b92652c74226e7f521e24e71733c00eecfba`
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

## New Candidate provenance-bound upload

- Version ID: `0a685610-dbbc-40b4-bd6e-76d84051598d`
- tag: `line-routing-personal-9a9ea475-provenance-r2`
- message: `source_commit=9a9ea475adbec3ad2b450725ce462a70ca091fa5 repository_tree=e8ea8184e713fe4e485c27a2c71695ef35e85532 worker_tree=2433d61856e53a7cdd28eb8459c1dd94ce0c2319 config_blob=7f37031548a3b25a74f4217fe21ac165cafd3256 wrangler=4.118.0 mode=personal deployment=prohibited`
- source: `wrangler`
- upload timestamp: `2026-08-05T06:03:26.443569Z`
- script.etag: `ac7545d6811edb5bac09ff84de00339d2b0a0bc613212e156e00d6790a9cc550`
- handlers: `scheduled`, `fetch`
- compatibility date: `2026-08-02`
- D1 binding: `DB` → `04c229e8-a76b-40a8-a4b4-17c78bdcf6ff`
- runtime variable: `LINE_DESTINATION_MODE=personal`
- secret binding names: `DISCORD_WEBHOOK_URL`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_GROUP_ID`, `LINE_USER_ID`
- candidate traffic: `0%`
- Active Deployment inclusion: none

## Provenance result

Candidateは9a9のclean detached worktree（detached、tracked clean、submoduleなし、symlinkなし）からUploadした。tag/messageのSource Commit／Tree／Config Blob／Wranglerと、Version metadataのsource、etag、handlers、compatibility、binding、variableを一致確認した。Preview URLの`GET /health`はHTTP 200、exact 3-key、personal、user/group configured=true、未知キー0、ID値0。Preview GET直前・直後のD1 versionは524、pendingは両方`[]`。新Candidate trafficは0%、Active Deploymentは旧Version 100%のまま。

Old Candidate `fef3f4c1-d4cc-476e-ae98-51daff127df0` は `SUPERSEDED_UNAPPROVED_PROVENANCE` として永久にDeploy対象外とする。新CandidateのDeploy、Production traffic変更、通知、Cron／D1変更は行わない。

Secret値、User ID、groupId、Token、Webhook URLは取得・表示・保存していない。
