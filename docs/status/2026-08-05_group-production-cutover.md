# Group Production Cutover

Status: `GITHUB_MAIN_GROUP_ROUTE_VALIDATED_PENDING_TOKEN_CLEANUP`

実施日: `2026-08-05 JST`

## Gated execution

- Group Remote WhatIf: pass
- Personal rollback Remote WhatIf: pass
- Group Apply: pass
- Cutover launcher completed: `2026-08-05T19:46:54+09:00`
- Schedules read Token: process memory only; value logged false; process environment cleanup true
- Production Upload／Version Upload: なし
- Cron変更: なし
- D1直接更新: なし
- Secret変更: なし

## Cloudflare Production

- Active Deployment: `8bc06f32-33f5-4065-80e9-1b5ce2a78ac6`
- Active Version: `e65c222d-49ba-4dff-95f4-a3059d26db32`
- Traffic: 100%
- Handlers: `scheduled`, `fetch`
- Runtime mode: `group`
- Production health: HTTP 200、exact 3-key、mode group、user/group configured true
- D1 Binding: `04c229e8-a76b-40a8-a4b4-17c78bdcf6ff`
- Secret binding names: Discord Webhook、LINE access token、LINE user ID、LINE group ID（値は未取得）
- Effective Cron: `* * * * *`。Applyの変更前、Deploy後、最終post-checkで公式Schedules GETにより同一1件を確認

## Normal state after cutover

- D1 version: cutover前 `579`、最終読み取り確認時 `599`
- `updated_at_jst`: `2026-08-05T21:20:41`
- `last_run_id`: `29e1ea27-a68a-47df-bd17-e44fcbb98a9b`
- `last_attempt_count`: 4
- `last_http_status`: 200
- `last_error_class`: null
- `consecutive_total_failures`: 0
- `outage_notified`: false
- `pending_notifications`: `[]`
- Active lease: 0
- 4枠: `8/22 10:30`、`8/22 14:00`、`8/23 10:30`、`8/23 14:00`のすべてが`SOLD_OUT`、quantity 0
- 不要な通知pending: なし

## GitHub state and scope boundary

- Repository Variable `LINE_DESTINATION_MODE`: `group`
- Feature branch: `feat/line-destination-routing`
- remote main: `350d500e5e20903592829d2876bce52109af8832`（featureとfast-forward統合済み）
- remote mainへ`LINE_DESTINATION_MODE`／`LINE_GROUP_ID`対応を統合済み。
- GitHub Actionsのdefault-branch group routeはmain line_testとnormal検証で確認済み。

## Safety result

途中のhealth伝播待機不足によるApply失敗時は、Personal Version 100%とGitHub Variable未設定へ自動Rollbackし、D1正常を確認した。伝播待機を追加後の最終Applyは成功した。Secret、LINE ID、Webhook URL、Authorization、Cookieは、結果JSON、Git、D1、文書、ログへ保存していない。

最終default-branch証跡は`docs/status/2026-08-05_line-group-migration-complete.md`に記録した。scheduleは遅延したため、承認済みnormal手動実行で代替確認した。
