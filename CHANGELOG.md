# Changelog

## [Unreleased] — 2026-08-05 JST

### Added

- 個人／グループを切り替えられるLINE通知先ルーティング
- `LINE_GROUP_ID` と `LINE_DESTINATION_MODE` の対応
- `line_test` 専用の `configured` / `personal` / `group` override
- Capture Workerの専用tailイベント、ローカルOrchestrator、managed dormant sink
- 実行可能なCapture CLI（project-local Wrangler、tail envelope、stdin転送、部分rollback）
- Production正本 `cloudflare-worker/wrangler.production.toml`
- GitHub／Cloudflare切替のread-only preflight、post-check、rollback契約
- GitHubユーザー一致、D1 JSON assert、実効Cron取得不能時のApply fail-closed、Health必須化
- LINE検証POSTのHTTP 200契約、Tail子プロセス停止確認、実コマンドに基づくSecret名一覧とVersion識別
- Health JSONの3キーexact allowlistと設定boolean検証
- ルーティング、fail-closed、Capture／Dormantの自動テスト

### Changed

- LINE通知処理の宛先概念を `destination` に一般化
- 未設定モードは `personal` として後方互換に処理
- 不正モードまたは選択先不足は送信せずfail closed
- Cloudflare Workerに非機密の `/health` 状態応答を追加
- Capture Workerは署名済み正常JSON（`events: []`を含む）へHTTP 200を返し、no-op時はログを出さない

### Security

- 個人User ID、groupId、Channel Secret、Channel Access Token、Webhook URLはコード、Git、ログ、文書、テスト結果、ZIPへ記録しない
- Capture Workerはraw bodyの署名を検証し、専用tailイベント以外へgroupIdを出さない。OrchestratorはIDを表示・永続化せず標準入力コールバックへ渡す
- Worker isolateのduplicate suppressionはbest effortであり、Orchestratorの1件受領が正式停止条件
- Dormant sinkはPOST bodyを読まず、外部通信・永続ログ・Secret・Cron・Bindingを持たない
- Productionモード、Webhook、Secret、Cron、D1はこのPending作業で変更しない

### Rollback

正式切替後の全経路ロールバックは、レビュー済みVersionを指定して次を実行する。

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode personal -Apply -CloudflareVersionId <approved-version-id>
```

このPending記録では実行していない。`-WhatIf` は外部状態を変更しない。

### Pending

- LINE DevelopersのWebhook URL登録、検証、配送有効化は未実施
- Capture WorkerのDeploy、Secret登録、groupId取得は未実施
- LINE_GROUP_ID Secret追加、LINE_DESTINATION_MODE変更は未実施
- personal／groupの実配送E2EとProduction切替はHuman Checkpoint B以降
- Human Checkpoint Bは差戻し修正後も未承認（`HUMAN_CHECKPOINT_B_REVIEW_PENDING`）
