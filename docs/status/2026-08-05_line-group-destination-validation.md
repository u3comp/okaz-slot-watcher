# LINE Destination Routing — Local Validation Report

作業日: 2026-08-05 JST（ローカル再検証および同日Remote Capture確認）
作業ブランチ: `feat/line-destination-routing`
修正基点: `ca8e2eee9376cd1cf884ebf526b03607c8f7f608`
Implementation Commit: `a5380fc664e6c55570c6e700ebfe649d86c4c252`
Validation Commit: `1f461fa1b4cfe6c5098d8f3dc57176c5f09cc6e3`

## Required checks

| Check | Result |
|---|---|
| Worker `npm run typecheck` | pass |
| Worker `npm test` | pass（6 files / 132 tests、multiline Tail parserを含む） |
| Python `pytest -q` | pass（78 tests） |
| LINE検証相当の署名済み`events: []` | pass（HTTP 200、body IDなし、log 0） |
| Capture default fetch／実tail envelope／CLI process lifecycle | pass |
| project-local Wrangler 4.118.0 command capability | pass（helpのみ、書込みなし） |
| Secret list JSON parser／Secret Version identification | pass |
| Health exact 3-key schema／boolean／HTTP非200 | pass |
| Switch-script WhatIf read-only preflight | pass（personal; no write command） |
| PowerShell個別関数 adapter／failure-injection | pass（Apply全体E2Eではない） |
| Switch-script mismatch／rollback failure-injection | pass |
| Production config TOML／Cron／D1／secret-free checks | pass |
| Workflow YAML／PowerShell syntax／`git diff --check` | pass |
| Main／Capture／Dormant Wrangler dry-run | local-only pass |
| Remote Probe | pass（HTTP 200、outcome正常、capture event 0、Secret write 0） |
| Remote Capture | pass（`secrets_set`、`tail_stopped=true`、安全な5項目のみ出力） |
| Dormant endpoint | pass（同一URL、GET 405／空body、bindings 0、Secret 0、永続ログ無効） |

WhatIfはGitHubユーザー完全一致、Cloudflare Account、Active Version 100%、D1 JSON（pending=0、failures=0、leaseなし）、canonical Cron記載、modeを読み取る。Wrangler 4.118にはSchedules readコマンドがないため実効Cronは取得不能として記録し、Applyはfail-closed。ApplyはHealth URLと移行段階ごとのgroup configured期待値を必須とし、HTTP JSONとadapterの双方を同じexact-schema関数で検査する。

## Security scan classification

- actual credential detected: 0
- credential-like fixture detected: 35
- allowlisted fixture: 35（tests配下のdummy fixture、値は転載しない）
- unresolved credential-like match: 0
- LINE ID pattern: 0
- unsafe archive path: 0

## External state after Capture

GitHub `LINE_GROUP_ID`はconfigured。Cloudflareには`LINE_GROUP_ID`を含む未Deploy Secret Versionが1件ありtraffic 0%。Production Active Version／Deployment、mode personal、Cron、D1は不変で、Production通知は発生していない。Webhook配送は無効、Capture WorkerはDormant化され、Channel Secretは削除済み。remote push／main統合は実施していない。状態は`PRODUCTION_PERSONAL_CANDIDATE_PREPARATION_APPROVED`。
