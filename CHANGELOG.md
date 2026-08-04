# Changelog

## [Unreleased] — 2026-08-05 JST

### Added

- 個人／グループを切り替えられるLINE通知先ルーティング
- `LINE_GROUP_ID` と `LINE_DESTINATION_MODE` の対応
- `line_test` 専用の `configured` / `personal` / `group` override
- Capture Worker と managed dormant sink のローカル実装
- GitHub／Cloudflare切替計画スクリプトと `-WhatIf` 検証
- ルーティング、fail-closed、Capture／Dormantの自動テスト

### Changed

- LINE通知処理の宛先概念を `destination` に一般化
- 未設定モードは `personal` として後方互換に処理
- 不正モードまたは選択先不足は送信せずfail closed
- Cloudflare Workerに非機密の `/health` 状態応答を追加

### Security

- 個人User ID、groupId、Channel Secret、Channel Access Token、Webhook URLはコード、Git、ログ、文書、テスト結果、ZIPへ記録しない
- Capture Workerはraw bodyの署名を検証し、groupIdをログ、永続ストレージ、レスポンス本文へ出さない
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
