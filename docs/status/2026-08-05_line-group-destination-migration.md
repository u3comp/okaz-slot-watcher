# LINE Group Destination Migration (Production candidate pending)

作業日時: 2026-08-05 JST（Capture実環境確認・Dormant化を同日実施）
作業ブランチ: `feat/line-destination-routing`
修正対象の基点: `ca8e2eee9376cd1cf884ebf526b03607c8f7f608`

## Confirmed facts

- Production Worker baseline was committed locally as a separate commit: `dfe2971`
- Feature branch: `feat/line-destination-routing`
- Gate repair starts from `ca8e2eee9376cd1cf884ebf526b03607c8f7f608`; no obsolete `b88f7e0` claim remains.
- Active Production Version／Deploymentは変更していない
- Production Cron、D1、Secrets、Variables、Webhookは変更していない
- Production通知先はpersonalのまま維持
- Production Artifact baseline: `PRODUCTION_BASELINE_VERIFIED`
- Artifact comparison: `DEPLOYED_ARTIFACT_NORMALIZED_MATCH`
- Remote Probe: `worker_invocation_seen`、HTTP 200、capture eventなし、Secret write 0
- Capture結果: `secrets_set`、`tail_stopped=true`
- GitHub `LINE_GROUP_ID`: configured（値は取得・記録していない）
- Cloudflare `LINE_GROUP_ID`: 未Deploy Secret Version `fc763ea1-1c74-41b6-92d6-b42570566b3c`、Production traffic 0%
- Dormant Worker Active Version: `de73b291-257c-470f-8b0a-690bda425315`
- Dormant Worker Deployment: `2fb48bc8-8cbc-467f-9446-f086d62f49d5`
- Webhook endpointは保持、Webhook配送は無効、Capture Channel Secretは削除済み
- Dormant bindings 0、永続ログ無効、Capture／Tail残存プロセス0
- groupId value logged: false、Production通知送信なし
- Candidate Version `fef3f4c1-d4cc-476e-ae98-51daff127df0`をpersonal modeでUpload済み、Preview `/health`はHTTP 200、traffic 0%
- Preview前後のD1 versionは494で不変、候補はProduction Active Deploymentに含まれていない

## Implemented locally

- Python／Cloudflare Workerの個人・グループ宛先解決
- 未設定personal、明示personal、明示group、不正値fail-closed
- GitHub `line_test`専用destination override
- Cloudflare `/health` の非機密状態応答
- Capture Workerの専用tailイベントとローカルOrchestrator（IDを表示・永続化しない）
- 実行可能な`capture-group-id.mjs`（Wrangler tail envelope、実停止確認、stdin Secret転送、実Secret一覧、tag/messageによるVersion識別、部分状態のfail-stop）
- `scripts/set-line-destination.ps1` の読み取りpreflight、target確認、post-check、rollback
- GitHub user完全一致、D1 JSON assert、実効Cron取得不能時Apply fail-closed、Apply時Health exact-schemaと設定boolean必須
- Production正本 `cloudflare-worker/wrangler.production.toml`
- CHANGELOGとrunbook
- ローカル検証結果: `docs/status/2026-08-05_line-group-destination-validation.md`

## Validation summary

- Worker: typecheck passed; 6 files / 123 tests passed
- Python: 78 tests passed
- Wrangler main／Capture／Dormant dry-run passed
- PowerShell switch-script syntax、personal WhatIf read-only preflight、個別関数failure-injection passed（Apply全体E2Eではない）
- fixture分類付きsecret scan、LINE ID、absolute-path scanを実施

## Completed externally under Human approval

- Capture WorkerのUpload／Deploy、Remote Probe、groupId Capture
- GitHub `LINE_GROUP_ID`登録とCloudflare未Deploy Secret Version作成
- Webhook URL登録／検証、Capture中の一時配送有効化、取得直後の配送無効化
- Dormant Workerへの置換とCapture Channel Secret削除

## Not performed

- `LINE_DESTINATION_MODE`のProduction設定変更
- personal／group実配送E2E
- remote feature branch push
- GitHub Actions branch指定`line_test`
- Production切替
- remote push、main統合

## Security scope

実ID、Secret、Token、Webhook URL、Cookie、Authorization、個人情報はこの文書へ記録しない。テストはfixture値のみを使用する。

## Status

`PRODUCTION_CANDIDATE_VALIDATION_BLOCKED`

Blocked理由: remote mainのWorkflow／CLIにはdestination overrideがなく、feature branch未Push時点ではpersonal／group実送信を実施できなかった。次の承認範囲はfeature branch pushとbranch指定line_testのみ。
