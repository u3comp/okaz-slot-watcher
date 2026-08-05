# LINE Group Notification Migration — Final Default-Branch Validation

Status: `GITHUB_MAIN_GROUP_ROUTE_VALIDATED_PENDING_TOKEN_CLEANUP`

実施日: `2026-08-05 JST`

## Integration

- Feature branch: `feat/line-destination-routing`
- Integrated main SHA: `350d500e5e20903592829d2876bce52109af8832`
- Integration method: fast-forward only
- Feature and main are identical after integration
- Force push、rebase、squash、tag: なし
- Evidence-only final commit: this document's main commit（handoffでSHAを記録）

## Main line_test

- Run ID: `31006461545`
- URL: `https://github.com/u3comp/okaz-slot-watcher/actions/runs/31006461545`
- ref: `main`
- HEAD SHA: `350d500e5e20903592829d2876bce52109af8832`
- mode: `line_test`
- line_destination: `configured`
- conclusion: success
- line-test: success
- diagnostic、normal、discord-test、disable-after-cutoff: skipped
- Test ID: `LINE-CONFIGURED-23b82a90-1265-444a-ba48-c375bfb1bfd9`
- 人間確認: 通知専用グループ受信、個人トーク未受信、Test ID一致
- 通知件数: 1件、誤配送なし

## Main normal validation

- Run ID: `31007093073`
- URL: `https://github.com/u3comp/okaz-slot-watcher/actions/runs/31007093073`
- ref: `main`
- HEAD SHA: `350d500e5e20903592829d2876bce52109af8832`
- event: `workflow_dispatch`（schedule遅延後の承認済み代替）
- mode: `normal`
- normal job: success
- Playwright Chromium installation: success
- 4 slots: all `SOLD_OUT`
- 空き枠通知: なし
- log credential scan: 0

## Cloudflare and GitHub state

- Active Deployment: `8bc06f32-33f5-4065-80e9-1b5ce2a78ac6`
- Active Version: `e65c222d-49ba-4dff-95f4-a3059d26db32`（100%）
- Cloudflare health: HTTP 200、mode group、user/group configured true
- Effective Cron: `* * * * *`、変更なし
- GitHub `LINE_DESTINATION_MODE`: `group`
- D1 final read: version 604、last HTTP 200、error null、consecutive failures 0、outage false、pending `[]`、active lease 0
- Cloudflare Worker／Cron／D1／Secret／Webhook: main統合による変更なし

## Security and cleanup

- Secret values, User ID, Group ID, access token, webhook URL: not read or recorded
- GitHub Actions log credential scan: clean
- Temporary Cloudflare Schedules Read Token: process memory/environment cleared; Dashboard deletion requested, confirmation pending
