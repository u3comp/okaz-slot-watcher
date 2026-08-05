# LINE Destination Routing — Local Validation Report

作業日: 2026-08-05 JST（再検証開始 00:45頃）
作業ブランチ: `feat/line-destination-routing`
修正基点: `ca8e2eee9376cd1cf884ebf526b03607c8f7f608`
直近検証HEAD: 最終修正コミットで更新

## Required checks

| Check | Result |
|---|---|
| Worker `npm run typecheck` | pass |
| Worker `npm test` | pass（6 files / 109 tests） |
| Python `pytest -q` | pass（78 tests） |
| Capture default fetch／実tail envelope／CLI process adapter | pass |
| Switch-script WhatIf read-only preflight | pass（personal; no write command） |
| PowerShell本体 adapter／failure-injection | pass |
| Switch-script mismatch／rollback failure-injection | pass |
| Production config TOML／Cron／D1／secret-free checks | pass |
| Workflow YAML／PowerShell syntax／`git diff --check` | pass |
| Main／Capture／Dormant Wrangler dry-run | local-only pass |

WhatIfはGitHubユーザー完全一致、Cloudflare Account、Active Version 100%、D1 JSON（pending=0、failures=0、leaseなし）、canonical Cron記載、modeを読み取る。Wrangler 4.118にはSchedules readコマンドがないため実効Cronは取得不能として記録し、Applyはfail-closed。Health URL未指定時はVersion metadata modeを使用し、Applyは実HTTP GETを必須とする。

## Security scan classification

- actual credential detected: 0
- credential-like fixture detected: 35
- allowlisted fixture: 35（tests配下のdummy fixture、値は転載しない）
- unresolved credential-like match: 0
- LINE ID pattern: 0
- unsafe archive path: 0

## External state

Production Worker upload／deploy、Cron、D1、GitHub Secrets／Variables、LINE Webhook、remote push、main統合は実施していない。Human Checkpoint Bは未承認。
