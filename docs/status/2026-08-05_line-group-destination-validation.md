# LINE Destination Routing — Local Validation Report

作業日: 2026-08-05 JST（再検証開始 00:45頃）
作業ブランチ: `feat/line-destination-routing`
修正基点: `ca8e2eee9376cd1cf884ebf526b03607c8f7f608`
直近検証HEAD: `799ae7f5bc4eb78ab32ef3cd5c665323d10948d8`

## Required checks

| Check | Result |
|---|---|
| Worker `npm run typecheck` | pass |
| Worker `npm test` | pass（5 files / 104 tests） |
| Python `pytest -q` | pass（77 tests） |
| Capture default fetch／専用event／tail Orchestrator | pass |
| Switch-script WhatIf read-only preflight | pass（personal; no write command） |
| Switch-script mismatch／rollback failure-injection | pass |
| Production config TOML／Cron／D1／secret-free checks | pass |
| Workflow YAML／PowerShell syntax／`git diff --check` | pass |
| Main／Capture／Dormant Wrangler dry-run | local-only pass |

WhatIfはGitHub認証、Cloudflare Account、Active Version 100%、D1、lease、canonical Cron記載、modeを読み取る。Health URL未指定時はVersion metadata modeを使用し、実HTTP probeは行わない。

## Security scan classification

- actual credential detected: 0
- credential-like fixture detected: 35
- allowlisted fixture: 35（tests配下のdummy fixture、値は転載しない）
- unresolved credential-like match: 0
- LINE ID pattern: 0
- unsafe archive path: 0

## External state

Production Worker upload／deploy、Cron、D1、GitHub Secrets／Variables、LINE Webhook、remote push、main統合は実施していない。Human Checkpoint Bは未承認。
