# LINE通知先切替Runbook（Human Checkpoint B pending）

最終更新: 2026-08-05 JST

## 構成

- `LINE_USER_ID`: 既存の個人宛先Secret。削除・改名・上書きしない。
- `LINE_GROUP_ID`: グループ宛先Secret。Human Checkpoint B後に追加する。
- `LINE_DESTINATION_MODE`: `personal` または `group`。未設定は `personal`。
- GitHub Actionsの通常監視は `LINE_TEST_DESTINATION` を無視し、Repository Variableだけを使う。
- `line_test`だけが `configured` / `personal` / `group` の手動overrideを受け付ける。
- Cloudflare Workerの `/health` はモードと設定有無だけを返し、ID値を返さない。
- Productionの正本設定は `cloudflare-worker/wrangler.production.toml`。`.example`や無指定configをDeploy元にしない。

## Fail-closed

- 不正なモードは通知しない。
- 選択された宛先Secretが不足している場合は通知しない。
- 通知本文、監視判定、重複抑止、Lease、CAS契約は変更しない。

## WhatIf確認

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode personal -WhatIf
# groupはレビュー済みVersion IDを指定した場合だけ対象確認できる
powershell -File scripts/set-line-destination.ps1 -Mode group -WhatIf -CloudflareVersionId <reviewed-version-id>
```

上記はGitHub、Cloudflare、Cron、D1、Secretを変更せず、対象Repository／Account／Active Version／D1／lease／canonical Cron／modeを読み取り検査する。現在の個人Versionをgroup指定する場合はfail-closedとなる。

## Production切替（Human承認後のみ）

1. personal／groupの両方で手動 `line_test` を実施し、人間が着信確認する。
2. Cloudflare側のレビュー済みVersionを用意する。Version Upload／Deployは別承認とする。
3. 次を実行し、Cloudflare Versionを先に昇格してからGitHub Variableを更新する。正本configを明示し、対象Versionのreview recordを必須とする。

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode group -Apply -CloudflareVersionId <approved-version-id> -ApprovalRecord <review-record>
```

4. 片側失敗時は前Versionと前Variableへrollbackし、事後preflightが通らなければ`INCONSISTENT_DESTINATION_STATE`として追加操作なしで停止する。

## ロールバック

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode personal -Apply -CloudflareVersionId <approved-personal-version-id>
```

Cloudflare Versionの承認済みIDがない場合は、推測でDeployせずHuman承認へ戻る。

## Capture／Dormant

Capture WorkerはHuman Checkpoint BまでDeployしない。Webhook URL登録後は送信前に`wrangler tail`を開始し、署名検証済みgroupイベントの専用イベントをローカルOrchestratorが1件だけ受ける。groupIdは同一プロセスの標準入力へ直接渡し、表示・ファイル・環境変数・ログ・クリップボードへ保存しない。Worker isolateのSetによる重複抑止はbest effortであり、Orchestrator受領が正式停止条件。取得後は直ちにtail停止、Webhook配送停止、Dormant化へ進む。

## 秘密情報の取扱い

Secret値、User ID、groupId、Channel Secret、Access Token、Webhook URLは表示、ログ、文書、Git、Artifact、ZIPへ保存しない。Secret一覧は名前だけ確認する。
