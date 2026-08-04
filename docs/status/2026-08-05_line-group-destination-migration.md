# LINE Group Destination Migration (Pending)

作業日時: 2026-08-05 JST（開始 00:08頃）

## Confirmed facts

- Production Worker baseline was committed locally as a separate commit: `dfe2971`
- Feature branch: `feat/line-destination-routing`
- Active Production Version／Deploymentは変更していない
- Production Cron、D1、Secrets、Variables、Webhookは変更していない
- Production通知先はpersonalのまま維持
- Production Artifact baseline: `PRODUCTION_BASELINE_VERIFIED`
- Artifact comparison: `DEPLOYED_ARTIFACT_NORMALIZED_MATCH`

## Implemented locally

- Python／Cloudflare Workerの個人・グループ宛先解決
- 未設定personal、明示personal、明示group、不正値fail-closed
- GitHub `line_test`専用destination override
- Cloudflare `/health` の非機密状態応答
- Capture WorkerとDormant sinkのローカル実装
- `scripts/set-line-destination.ps1` と `-WhatIf`
- CHANGELOGとrunbook
- ローカル検証結果: `docs/status/2026-08-05_line-group-destination-validation.md`

## Not performed

- LINE_GROUP_ID Secretの登録
- LINE_DESTINATION_MODE Variableの作成・変更
- Capture WorkerのUpload／Deploy
- Webhook URL登録・検証・配送有効化
- groupId取得
- Dormant Workerへの置換
- personal／group実配送E2E
- Production切替
- remote push、main統合

## Security scope

実ID、Secret、Token、Webhook URL、Cookie、Authorization、個人情報はこの文書へ記録しない。テストはfixture値のみを使用する。

## Status

`HUMAN_CHECKPOINT_B_PENDING`
