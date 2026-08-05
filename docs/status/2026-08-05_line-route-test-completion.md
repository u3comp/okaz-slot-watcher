# LINE Destination Route Test Completion

Status: `PRODUCTION_PERSONAL_CANDIDATE_READY_REVIEW_PENDING`

作業日: 2026-08-05 JST（personal／groupの実送信および人間確認を同日実施）  
実装ブランチ: `feat/line-destination-routing`  
実装・試験対象SHA: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`

## Remote workflow results

| Route | Run | Result | Test ID | Human confirmation |
|---|---:|---|---|---|
| personal | [30977666705](https://github.com/u3comp/okaz-slot-watcher/actions/runs/30977666705) | `success` | `LINE-PERSONAL-e46371a8-fce1-4a79-9761-0dd3009b8f28` | 個人トーク受信1件、グループ未受信、ID一致、重複なし |
| group | [30978218510](https://github.com/u3comp/okaz-slot-watcher/actions/runs/30978218510) | `success` | `LINE-GROUP-8019e933-7e27-498d-865e-4bea8fd15059` | グループ受信1件、個人トーク未受信、ID一致、重複なし |

両Runとも `workflow_dispatch`、ref `feat/line-destination-routing`、HEAD SHA `9a9ea475adbec3ad2b450725ce462a70ca091fa5`。`line-test`のみ成功し、`normal`、`diagnostic`、`discord-test`、`disable-after-cutoff`はskip。自動Retryはない。

## Safety verification

- remote feature branch SHA: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- remote `main` SHA: `6cf4d439c17c1899837452b43c3f903169df9dbf`（不変）
- Secret／User ID／groupId／Tokenの値: ログ・文書へ出力なし
- Test IDのログ出現: 各Run 1件
- Production変更: なし
- Production Active Version: `f655cd8e-e0c6-4768-b403-45b50bbd3b02`
- Production Active Deployment: `8406f8b7-f3b3-45d6-a072-c177713500a6`
- Production mode: `personal`
- Candidate Version: `fef3f4c1-d4cc-476e-ae98-51daff127df0`
- Candidate traffic: `0%`（未Deploy）
- Webhook delivery: disabled
- Dormant endpoint: active
- Repository Variable: 変更なし
- Cron／D1: 変更なし
- main統合／PR: なし

Cloudflare読み取り確認では、Active Deploymentは旧Production Version 100%のまま、候補Versionは未Deployであることを確認した。候補の`LINE_DESTINATION_MODE`は`personal`のままである。

## Gate

personal／groupの両経路と人間による着信確認は完了した。次の承認待ち操作はCandidate VersionのDeployおよびProduction切替であり、本記録作成時点では実施していない。

禁止された操作（Candidate Deploy、Production traffic変更、`LINE_DESTINATION_MODE`変更、Cron／D1変更、main merge、追加通知）は行っていない。

## Security scope

実際のSecret、User ID、groupId、Channel Access Token、Webhook URL、Cookie、Authorization値は記録しない。本文のTest IDは非秘密の配送証跡である。
