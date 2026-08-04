# LINE Destination Routing — Local Validation Report

作業日: 2026-08-05 JST
作業ブランチ: `feat/line-destination-routing`

## Validation commands

| Check | Start (JST) | End (JST) | Exit |
|---|---:|---:|---:|
| Worker `npm run typecheck` | 00:20:43 | 00:20:46 | 0 |
| Worker `npm test` | 00:20:46 | 00:20:53 | 0 |
| Python `pytest -q` | 00:20:53 | 00:20:54 | 0 |
| Python `compileall` | 00:20:54 | 00:20:54 | 0 |
| Workflow YAML parse | 00:20:54 | 00:20:55 | 0 |
| PowerShell switch-script syntax | 00:20:55 | 00:20:55 | 0 |
| `git diff --cached --check` | 00:20:55 | 00:20:55 | 0 |
| `set-line-destination.ps1 -Mode personal -WhatIf` | 00:20:55 | 00:20:55 | 0 |
| `set-line-destination.ps1 -Mode group -WhatIf` | 00:20:55 | 00:20:56 | 0 |
| Main Worker Wrangler dry-run | 00:20:56 | 00:20:58 | 0 |
| Capture Worker Wrangler dry-run | 00:20:58 | 00:21:01 | 0 |
| Dormant Worker Wrangler dry-run | 00:21:01 | 00:21:04 | 0 |

## Results

- Worker tests: 5 files / 100 tests passed
- Python tests: 70 passed
- Main Worker dry-run: 36.41 KiB upload / 9.01 KiB gzip
- Capture Worker dry-run: 3.50 KiB upload / 1.31 KiB gzip / no bindings
- Dormant Worker dry-run: 0.55 KiB upload / 0.31 KiB gzip / no bindings
- Secret-like literal scan of staged files: clean
- LINE ID pattern scan: 0 matches
- Absolute user-path scan: 0 matches
- Unsafe staged filenames: none

## External state

- Production Worker upload／deploy: not performed
- Production Cron／D1／Secrets／Variables／Webhook: unchanged
- GitHub remote push: not performed
- Human Checkpoint B: pending
