# LINE通知先切替Runbook（Production candidate pending）

最終更新: 2026-08-05 JST

## 構成

- `LINE_USER_ID`: 既存の個人宛先Secret。削除・改名・上書きしない。
- `LINE_GROUP_ID`: グループ宛先Secret。GitHubへ登録済み。Cloudflareでは未Deploy Secret Versionにのみ存在し、Production trafficは0%。
- `LINE_DESTINATION_MODE`: `personal` または `group`。未設定は `personal`。
- GitHub Actionsの通常監視は `LINE_TEST_DESTINATION` を無視し、Repository Variableだけを使う。
- `line_test`だけが `configured` / `personal` / `group` の手動overrideを受け付ける。
- Cloudflare Workerの `/health` はモードと設定有無だけを返し、ID値を返さない。
- Productionの正本設定は `cloudflare-worker/wrangler.production.toml`。`.example`や無指定configをDeploy元にしない。
- `-Apply`は`-HealthUrl`と`-ExpectedGroupConfigured true|false`を必須とする。Health JSONは`line_destination_mode`、`line_user_id_configured`、`line_group_id_configured`の3キーだけを許可し、HTTP 200、mode、boolean設定状態を検査する。未知キーやIDらしき追加キーはfail-closed。Wrangler 4.118で実効Cron一覧を取得できない場合も変更せず停止する。

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
powershell -File scripts/set-line-destination.ps1 -Mode group -Apply -CloudflareVersionId <approved-version-id> -ApprovalRecord <review-record> -HealthUrl <approved-health-url> -ExpectedGroupConfigured true
```

4. 片側失敗時は前Versionと前Variableへrollbackし、事後preflightが通らなければ`INCONSISTENT_DESTINATION_STATE`として追加操作なしで停止する。

## ロールバック

```powershell
powershell -File scripts/set-line-destination.ps1 -Mode personal -Apply -CloudflareVersionId <approved-personal-version-id> -ApprovalRecord <review-record> -HealthUrl <approved-health-url> -ExpectedGroupConfigured true
```

Cloudflare Versionの承認済みIDがない場合は、推測でDeployせずHuman承認へ戻る。

## Candidate route tests（feature branch only）

Production候補VersionのUploadとPreview `/health`が成功しても、remote mainにdestination overrideがない場合は実送信しない。Human承認後に`feat/line-destination-routing`だけをpushし、branch上のWorkflow入力を読み取り確認してから次を各1回だけ実行する。

```powershell
gh workflow run availability-watcher.yml --repo u3comp/okaz-slot-watcher --ref feat/line-destination-routing -f mode=line_test -f line_destination=personal
gh workflow run availability-watcher.yml --repo u3comp/okaz-slot-watcher --ref feat/line-destination-routing -f mode=line_test -f line_destination=group
```

personal成功と人間着信確認の後にgroupへ進む。同じTest IDの再送、main変更、Production Deploy、Variable変更、Cron／D1変更は行わない。

## Capture／Dormant

Capture Phaseは2026-08-05 JSTに完了した。Remote ProbeでHTTP 200、Worker outcome正常、capture eventなしを確認後、署名検証済みgroupイベントの専用イベントをローカルOrchestratorが1件だけ受領した。groupIdは同一プロセス内で扱い、表示・ファイル・環境変数・ログ・クリップボードへ保存していない。Capture結果は`secrets_set`、`tail_stopped=true`。Webhook配送は無効化済みである。

実行ファイルは `cloudflare-worker/capture-worker/capture-group-id.mjs`。Probeは`node capture-worker/capture-group-id.mjs --probe --timeout-seconds 120`、Captureは人間承認後に`node capture-worker/capture-group-id.mjs --apply --timeout-seconds 600`を使用する。CLIはproject-local Wranglerを直接起動し、Secret値を引数・出力・ファイルへ渡さない。Cloudflare側の既存名は`wrangler secret list --format json`で確認し、Secret作成前後の`wrangler versions list --json`を一意な非秘密tag/messageで照合する。新Versionを一意に確認できない場合はGitHub側だけを1回削除し、`partial_cloudflare_secret_version_unverified`として人間判断へ戻る。Production Deployは行わない。

Capture後、同一endpointはDormant Workerへ置換済みである。Dormant WorkerはPOST 200／その他405、bindings 0、Secret 0、Cron 0、永続ログ無効。Webhook URLは保持し、LINE DevelopersのWebhook配送は無効のまま維持する。Production通知先切替のためにWebhook配送を再有効化してはならない。

## 秘密情報の取扱い

Secret値、User ID、groupId、Channel Secret、Access Token、Webhook URLは表示、ログ、文書、Git、Artifact、ZIPへ保存しない。Secret一覧は名前だけ確認する。
