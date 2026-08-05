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
- Group／Personal Remote WhatIf、Version Preview prefix検証、Deploy後health伝播待機、Cron／D1再確認、Variable未設定への正確なRollback
- 承認済みGroup CandidateをCloudflare Productionへ100%昇格し、Production healthとD1 scheduled観測を確認
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
- Capture中だけWebhook配送を有効化し、取得後は無効化した。Group切替ではCron、D1、Secret、Webhookを変更していない
- groupId実値は表示・永続化せず、GitHub SecretとCloudflare未Deploy Secret Versionへstdin経由で登録した

### Rollback

正式切替後の全経路ロールバックは、レビュー済みVersionを指定して次を実行する。

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode personal -Apply -CloudflareVersionId <approved-version-id>
```

Group切替では承認済みPersonal VersionをRollback先として検証済み。`-WhatIf` は外部状態を変更しない。

### Current production and pending

- Captureは`secrets_set`、`tail_stopped=true`で完了し、Webhook配送は無効化済み
- `LINE_GROUP_ID`はGitHub／Cloudflare ProductionのSecret名として存在し、値は取得していない
- Capture Workerは同一Webhook URLのDormant Workerへ置換済み。Channel Secret、bindings、永続ログは残していない
- Cloudflare ProductionはGroup Candidate `e65c222d-49ba-4dff-95f4-a3059d26db32`を100%で稼働し、health=group、Cron毎分、D1正常を確認済み
- GitHub Repository Variable `LINE_DESTINATION_MODE=group`は設定済み
- personal／group実配送E2Eはfeature branchで各1件、人間着信確認済み
- remote mainは`6cf4d439c17c1899837452b43c3f903169df9dbf`のままでdestination routing未統合。GitHub Actions default-branch scheduleのgroup対応はmain統合後の別Gate
- 旧Candidate `fef3f4c1-d4cc-476e-ae98-51daff127df0`はPreview検証用の履歴であり、現在のProduction Active Versionではない
