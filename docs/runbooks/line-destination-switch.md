# LINE通知先切替Runbook（Pending）

最終更新: 2026-08-05 JST

## 構成

- `LINE_USER_ID`: 既存の個人宛先Secret。削除・改名・上書きしない。
- `LINE_GROUP_ID`: グループ宛先Secret。Human Checkpoint B後に追加する。
- `LINE_DESTINATION_MODE`: `personal` または `group`。未設定は `personal`。
- GitHub Actionsの通常監視は `LINE_TEST_DESTINATION` を無視し、Repository Variableだけを使う。
- `line_test`だけが `configured` / `personal` / `group` の手動overrideを受け付ける。
- Cloudflare Workerの `/health` はモードと設定有無だけを返し、ID値を返さない。

## Fail-closed

- 不正なモードは通知しない。
- 選択された宛先Secretが不足している場合は通知しない。
- 通知本文、監視判定、重複抑止、Lease、CAS契約は変更しない。

## WhatIf確認

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode personal -WhatIf
powershell -File scripts/set-line-destination.ps1 -Mode group -WhatIf
```

上記はGitHub、Cloudflare、Cron、D1、Secretを変更しない。

## Production切替（Human承認後のみ）

1. personal／groupの両方で手動 `line_test` を実施し、人間が着信確認する。
2. Cloudflare側のレビュー済みVersionを用意する。Version Upload／Deployは別承認とする。
3. 次を実行し、Cloudflare Versionを先に昇格してからGitHub Variableを更新する。

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode group -Apply -CloudflareVersionId <approved-version-id>
```

4. 片側失敗時は追加通知を発生させず、状態を記録して停止する。

## ロールバック

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode personal -Apply -CloudflareVersionId <approved-personal-version-id>
```

Cloudflare Versionの承認済みIDがない場合は、推測でDeployせずHuman承認へ戻る。

## Capture／Dormant

Capture WorkerはHuman Checkpoint BまでDeployしない。Webhook URL登録後、署名検証済みのgroupイベントを一度だけ受け、groupIdを永続化せず安全な人間管理経路へ移送する。取得後はWebhook配送を無効化し、同じURLをDormant sinkへ置換し、Channel Secretを削除する。Webhook URLは空欄へ完全復元できない可能性を前提に、endpoint retained / delivery disabled / dormant sinkの状態を記録する。

## 秘密情報の取扱い

Secret値、User ID、groupId、Channel Secret、Access Token、Webhook URLは表示、ログ、文書、Git、Artifact、ZIPへ保存しない。Secret一覧は名前だけ確認する。
