# okaz-slot-watcher

「茶と果実」の4つの日時枠をGitHub-hosted runnerから5分間隔で確認し、
キャンセル枠が復活したときだけDiscordへ通知します。任意でLINE Messaging APIも
独立した通知経路として有効化できます。

## 安全上の境界

- 公開商品ページの表示だけを読み取ります。
- 自動購入、カート投入、ログイン、CAPTCHA回避は行いません。
- Discord WebhookはRepository Secret `DISCORD_WEBHOOK_URL` にだけ保存します。
- LINEのアクセストークンとユーザーIDはRepository Secret
  `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_USER_ID` にだけ保存します。
- Secretの値、購入者情報、認証情報をIssueやログへ保存しません。
- 状態はタイトル `Okaz slot watcher state (machine-managed)` の専用Issue本文へJSONで保存します。

## 判定

対象枠は次の4件です。

- `8/22（土）10:30-12:30`
- `8/22（土）14:00-16:00`
- `8/23（日）10:30-12:30`
- `8/23（日）14:00-16:00`

商品ページの静的SSR HTMLは実在庫と一致しないため、WorkflowでPlaywright Chromiumを
明示的に導入し、`ec-storefront-v3-ssr` を除いた描画後DOMだけを解析します。
日時inputの値と対応labelが完全一致すれば `AVAILABLE`、labelに `Sold out`、
`売り切れ` または `完売` があれば `SOLD_OUT`、枠がなければ `MISSING`、
DOM構造やlabelが不明なら `UNKNOWN` とします。
ローカルのGoogle Chromeを使う場合だけ `PLAYWRIGHT_CHANNEL=chrome` を指定できます。

## Workflow運用

- Workflow: `.github/workflows/availability-watcher.yml`
- 手動モード: `normal`、`discord_test`、`line_test`、`diagnostic`
- 定期実行はRepository Variable `WATCHER_ENABLED=true` のときだけ有効です。
- LINE通知はRepository Variable `LINE_ENABLED=true` のときだけ有効です。
  未設定またはtrue以外の場合もDiscord監視は継続します。
- 多重実行は`concurrency`で直列化し、各監視runは4分でtimeoutします。
- `diagnostic`、`discord_test`、`line_test`は`contents: read`のみ、`normal`だけが
  状態保存用の`issues: write`を持ちます。
- 2026-08-23 16:30 JST以降、`WATCHER_ENABLED=true`のscheduleに限り、
  停止専用ジョブだけに`actions: write`を与えてこのWorkflow自身を無効化します。
- 手動実行がWorkflowを無効化することはありません。

## ローカルテスト

通常テストは保存済みHTML fixtureだけを使い、実サイトへ接続しません。

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest
```
