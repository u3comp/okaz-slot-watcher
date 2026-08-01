# okaz-slot-watcher

「茶と果実」の4つの日時枠をGitHub-hosted runnerから5分間隔で確認し、
キャンセル枠が復活したときだけDiscordへ通知します。

## 安全上の境界

- 公開商品ページの表示だけを読み取ります。
- 自動購入、カート投入、ログイン、CAPTCHA回避は行いません。
- Discord WebhookはRepository Secret `DISCORD_WEBHOOK_URL` にだけ保存します。
- Secretの値、購入者情報、認証情報をIssueやログへ保存しません。
- 状態はタイトル `Okaz slot watcher state (machine-managed)` の専用Issue本文へJSONで保存します。

## 判定

対象枠は次の4件です。

- `8/22（土）10:30-12:30`
- `8/22（土）14:00-16:00`
- `8/23（日）10:30-12:30`
- `8/23（日）14:00-16:00`

商品ページの静的SSR HTMLは実在庫と一致しないため、Playwrightからrunner既設の
Google Chromeを起動し、`ec-storefront-v3-ssr` を除いた描画後DOMだけを解析します。
日時inputの値と対応labelが完全一致すれば `AVAILABLE`、labelに `Sold out`、
`売り切れ` または `完売` があれば `SOLD_OUT`、枠がなければ `MISSING`、
DOM構造やlabelが不明なら `UNKNOWN` とします。

## Workflow運用

- Workflow: `.github/workflows/availability-watcher.yml`
- 手動モード: `normal`、`discord_test`、`diagnostic`
- 定期実行はRepository Variable `WATCHER_ENABLED=true` のときだけ有効です。
- 多重実行は`concurrency`で直列化し、各監視runは4分でtimeoutします。
- 通常監視権限は`contents: read`と`issues: write`だけです。
- 2026-08-23 16:30 JST以降、停止専用ジョブだけに`actions: write`を与え、
  このWorkflow自身を無効化します。

## ローカルテスト

通常テストは保存済みHTML fixtureだけを使い、実サイトへ接続しません。

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest
```
