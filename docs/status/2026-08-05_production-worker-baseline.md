# Cloudflare Worker Production Baseline (Pending)

作業日時: 2026-08-05 JST（00:08頃から実施）

## Confirmed

- 対象リポジトリ: `u3comp/okaz-slot-watcher`
- 対象Worker: `okaz-slot-watcher-cf`
- Active Deployment: `8406f8b7-f3b3-45d6-a072-c177713500a6`
- Active Version: `f655cd8e-e0c6-4768-b403-45b50bbd3b02`（100%）
- Handlers: `scheduled`, `fetch`
- Compatibility date: `2026-08-02`
- 実効Cron: `* * * * *`
- Version詳細のScript ETagとWorker本文取得結果のETagが一致
- Worker本文取得結果: multipart形式。ローカルdry-run bundle本体を完全に含む
- Artifact判定: `DEPLOYED_ARTIFACT_NORMALIZED_MATCH`
- Worker本文SHA-256: `4F8FCA3049C0E018E75F9B275831B47B61A3639DB078CF11324266E15C74D9C2`
- ローカルbundle SHA-256: `FB85D5CCA005668BCC1767C19D9C6B082751B0113E1933147777CBBE3CC71174`
- Worker本文のSecret類似リテラル検査: 0件
- ProductionへのUpload、Deploy、Cron、D1、Secret、Variable変更: なし

## Canonical local configuration

- `cloudflare-worker/wrangler.production.toml` is the tracked production config.
- It records the verified Worker name, compatibility date, D1 ID, `DRY_RUN=false`, `LINE_ENABLED=true`, personal mode, target page URL, and effective `* * * * *` Cron.
- Secret bindings are names only; no secret values are present.

## Scope

この文書にはLINE User ID、groupId、Channel Secret、Channel Access Token、Webhook URL、個人情報を記録しない。
`DRY_RUN`、`LINE_ENABLED`の実値は取得・保存せず、既存Production正本の確認範囲に限定する。

## Pending

- `feat/line-destination-routing`で実装・テストを行う
- Human Checkpoint B（Capture WorkerのWebhook URL登録直前）で停止する
- Production通知先はpersonalのまま維持する
