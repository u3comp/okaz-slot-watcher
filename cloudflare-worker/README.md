# Okaz Slot Watcher - Cloudflare Workers版

GitHub Actions版とは独立した実装です。Playwright、Browser Run、商品ページHTML取得は使用せず、Ecwidの公開された
`catalog/product/overrides` APIへ4枠それぞれPOSTして判定します。

## 初期安全設定

`DRY_RUN=true`（既定）ではDiscord/LINEへ送信せず、イベントは`dry_run_events`へ分離保存します。
切替前に必ずユーザー確認を行い、`DRY_RUN=false`へ変更するまで本番通知は送信しません。

秘密値はWrangler Secretへ登録し、ファイル・D1状態・ログへ保存しません。

## 手動操作（未実施）

1. Cloudflareへログインし、D1データベースを作成する。
2. `schema.sql`をD1へ適用し、`wrangler.toml`の`database_id`を設定する。
3. `wrangler secret put DISCORD_WEBHOOK_URL`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_USER_ID`を実行する。
4. `wrangler deploy`でCron Triggerを登録する。

上記はCloudflareアカウントに対する外部変更を伴うため、この段階では実行していません。

## 状態と通知

D1の`watcher_state` 1行にスロット状態、連続障害回数、障害通知状態、チャネル別pending状態を保存します。
`watcher_lock`でCronの重複実行を防ぎ、`version`による楽観ロックで状態更新を保護します。
Discord成功/LINE失敗などの場合は成功済みチャネルを再送せず、失敗チャネルだけ次回再試行します。
