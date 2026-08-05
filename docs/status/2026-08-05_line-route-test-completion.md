# LINE Destination Route Test Completion

Route Test Status: `LINE_ROUTE_TESTS_COMPLETE`
Overall Candidate Gate: `PRODUCTION_PERSONAL_CANDIDATE_PROVENANCE_VERIFIED_DEPLOY_REVIEW_PENDING`

作業日: 2026-08-05 JST（personal／groupの実送信および人間確認を同日実施）
実装ブランチ: `feat/line-destination-routing`
Route Test Execution SHA: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
Evidence Commit／Current Remote Feature HEAD（前回証跡時点）: `e7ce07001fa94d8c7ea2686d746354ee5232d546`
Main SHA: `6cf4d439c17c1899837452b43c3f903169df9dbf`
Current Evidence HEAD: `3f24b92652c74226e7f521e24e71733c00eecfba`

## Remote workflow results

| Route | Run | Result | Test ID | Human confirmation |
|---|---:|---|---|---|
| personal | [30977666705](https://github.com/u3comp/okaz-slot-watcher/actions/runs/30977666705) | `success` | `LINE-PERSONAL-e46371a8-fce1-4a79-9761-0dd3009b8f28` | 個人トーク受信1件、グループ未受信、ID一致、重複なし |
| group | [30978218510](https://github.com/u3comp/okaz-slot-watcher/actions/runs/30978218510) | `success` | `LINE-GROUP-8019e933-7e27-498d-865e-4bea8fd15059` | グループ受信1件、個人トーク未受信、ID一致、重複なし |

両Runとも `workflow_dispatch`、ref `feat/line-destination-routing`、HEAD SHA `9a9ea475adbec3ad2b450725ce462a70ca091fa5`。`line-test`のみ成功し、`normal`、`diagnostic`、`discord-test`、`disable-after-cutoff`はskip。自動Retryはない。

## Safety verification

- Route Test Execution SHA: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- Evidence Commit／Current Remote Feature HEAD（前回証跡時点）: `e7ce07001fa94d8c7ea2686d746354ee5232d546`
- remote `main` SHA: `6cf4d439c17c1899837452b43c3f903169df9dbf`（不変）
- Secret／User ID／groupId／Tokenの値: ログ・文書へ出力なし
- Test IDのログ出現: 各Run 1件
- Production変更: なし
- Production Active Version: `f655cd8e-e0c6-4768-b403-45b50bbd3b02`
- Production Active Deployment: `8406f8b7-f3b3-45d6-a072-c177713500a6`
- Production mode: `personal`
- Old Candidate Version: `fef3f4c1-d4cc-476e-ae98-51daff127df0`（`SUPERSEDED_UNAPPROVED_PROVENANCE`、Deploy永久禁止）
- New Candidate Version: `0a685610-dbbc-40b4-bd6e-76d84051598d`
- New Candidate source commit: `9a9ea475adbec3ad2b450725ce462a70ca091fa5`
- New Candidate script.etag: `ac7545d6811edb5bac09ff84de00339d2b0a0bc613212e156e00d6790a9cc550`
- New Candidate normalized artifact comparison: provenance-bound upload from clean detached source; `verified`
- Candidate traffic: `0%`（未Deploy）
- Webhook delivery: disabled
- Dormant endpoint: active
- Repository Variable: 変更なし
- Cron／D1: 変更なし
- main統合／PR: なし

Cloudflare読み取り確認では、Active Deploymentは旧Production Version 100%のまま、新Candidateは未Deployであることを確認した。新Candidateの`LINE_DESTINATION_MODE`は`personal`のままである。Versioned Preview `/health` はHTTP 200、exact 3-key、personal、user/group configured=true。GET直前・直後のD1 versionは524で、pendingは両方`[]`だった。

## Gate

personal／groupの両経路と人間による着信確認、および新Candidateのprovenance-bound Upload／Preview確認は完了した。Candidate VersionのDeployおよびProduction切替は人間承認待ちであり、本記録作成時点では実施していない。

禁止された操作（Candidate Deploy、Production traffic変更、Candidate再Upload、`LINE_DESTINATION_MODE`変更、Cron／D1変更、main merge、追加通知）は行っていない。

## Security scope

実際のSecret、User ID、groupId、Channel Access Token、Webhook URL、Cookie、Authorization値は記録しない。本文のTest IDは非秘密の配送証跡である。

## Provenance gate

`PRODUCTION_PERSONAL_CANDIDATE_PROVENANCE_VERIFIED_DEPLOY_REVIEW_PENDING`
新Candidateは9a9のclean detached worktreeからproject-local Wrangler 4.118.0で1回だけUploadし、tag/messageへSource Commit、Repository Tree、Worker Tree、Config Blob、mode、deployment禁止を固定した。Version ID、script.etag、handlers、compatibility date、D1 binding、runtime variable、Secret binding名、traffic 0%、Active Deployment未包含、Preview healthを確認済み。
