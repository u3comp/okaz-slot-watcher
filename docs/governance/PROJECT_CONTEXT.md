# Project Context

## Metadata

- Governance Profile: `QUALITY_PRESERVED_SCRATCH`
- Environment: `SECONDARY_PC`
- Authority: `NON_AUTHORITATIVE`
- Repository Path: `C:\Users\user01\Desktop\repo-Yggdrasill\ai-tools-private\tools\okaz-slot-watcher`
- Branch: `feat/line-destination-routing`
- HEAD at review start: `0fb110160fbba8fef548677d6a8fb31c87250a53`
- Remote: `https://github.com/u3comp/okaz-slot-watcher.git`
- Working Tree State: tracked変更0件、untracked 8件。既存のdirty状態を維持
- Last Reviewed At: `2026-08-06T20:11:43+09:00` (Asia/Tokyo)
- Evidence Scope: Repository内の実装・Git履歴・文書・テスト・設定、および必要最小限のArchive。外部環境は未接続

## 1. Purpose

キャンセル等によって「茶と果実」の購入枠が復活した場合に、利用者が対象ページを確認して購入行動を開始できるよう通知する。自動購入、カート投入、ログイン、CAPTCHA回避は行わず、公開情報の状態判定と通知だけを行う。

## 2. Environment Boundary

- 本PJはサブPC上の軽量な非正本環境である。
- 親 `repo-Yggdrasill` は配置用ディレクトリとして扱い、親のGit管理を本PJの正本性やGovernanceとして継承しない。実測では親にGitメタデータが存在するが、今回の管理対象は本PJ自身の `.git` のみである。
- 業務PC側Yggdrasill、Bifrost、Canon、CI設定は対象外であり、継承を仮定しない。
- 業務PCへのPromotion、mainへの追加操作、外部環境の変更は今回行わない。
- Repositoryの旧Desktop配置は廃止済みで、現在は上記の新パスだけを標準作業場所とする。

## 3. Current Operational Topology

### Cloudflare Path

`Cron (毎分)`
→ `scheduled handler`
→ `毎分起動。UTC分が5の倍数のときだけEcwid観測`
→ `D1 watcher_state / watcher_lockのlease・CAS`
→ `状態遷移と通知Series`
→ `Discord / LINE`
→ `D1へ配送診断・pending状態を永続化`

- 起動条件: `cloudflare-worker/wrangler.production.toml` の `* * * * *` Cron。`scheduled()` は `runOnce()` を起動し、`fetch()` は `/health` と簡易200応答だけを提供する。
- 観測: 4枠を `catalog/product/overrides` 相当のPOSTで個別判定。HTTP取得はtimeout、manual redirect、429/502/503/504再試行、JSON・Content-Type・応答読取診断を持つ。
- 状態保存先: D1 `watcher_state`、lease用 `watcher_lock`、DRY_RUN専用 `dry_run_events`。
- 通知先: Discord Webhook、LINE Messaging API。記録されるのはSecret名ではなく配送診断とチャネル完了状態だけ。
- 通知回数: AVAILABLE復活は1 Series 5 Round、Round間隔は約1分。outage / recovered は各1回。成功済みチャネルは再送しない。
- 現在の有効状態: Repository内の2026-08-05証跡ではProduction Group Candidateが100%、health=group、D1正常、毎分Cronと記録されている。ただし今回はCloudflareへ接続していないため、現在値として再検証していない。
- 想定Production役割: 主監視・主通知経路。
- 根拠: `cloudflare-worker/src/index.ts`、`cloudflare-worker/wrangler.production.toml`、`cloudflare-worker/schema.sql`、`docs/status/2026-08-05_group-production-cutover.md`。
- 未確認事項: 現在のActive Version、実効Cron、Secret binding、D1値、外部通知の最新状態。

### GitHub Actions Path

`schedule / workflow_dispatch`
→ `gate`
→ `cutoff判定`
→ `normal / diagnostic / discord-test / line-test`
→ `Python watcher`
→ `専用GitHub Issueの状態JSON`
→ `Discord / LINE`

- 起動条件: `.github/workflows/availability-watcher.yml` は `*/5 * * * *` と `workflow_dispatch`。scheduleは `WATCHER_ENABLED == "true"` のときだけgate後にnormalへ進む。
- 判定: Playwright ChromiumをActions上で明示導入し、描画後DOMを解析する。4枠は `AVAILABLE`、`SOLD_OUT`、`MISSING`、`UNKNOWN`。
- 状態保存先: `Okaz slot watcher state (machine-managed)` という専用GitHub Issue本文の機械可読JSON。
- 通知先: Discord。`LINE_ENABLED == "true"` の場合は独立してLINEも対象とし、`LINE_DESTINATION_MODE` と `LINE_GROUP_ID` で宛先を解決する。
- 通知回数: 状態遷移ごとに1通知。配送失敗チャネルだけ次回再試行し、成功済みチャネルは再送しない。
- 現在の有効状態: Repository内証跡ではmainのgroup route検証、normal手動検証、4枠SOLD_OUTが記録されている。scheduleの自然発火は遅延し、承認済みnormal手動実行で代替確認したと記録されている。
- 想定Production役割: 手動diagnostic、テスト、障害時Fallback候補。scheduleが残っているため、Cloudflareとの同時稼働範囲は未確定。
- 根拠: `.github/workflows/availability-watcher.yml`、`watcher/cli.py`、`watcher/live.py`、`watcher/state.py`、`watcher/github_state.py`、`docs/status/2026-08-05_line-group-migration-complete.md`。
- 未確認事項: GitHub Variable、Secret名の最新値、自然scheduleの現在の発火状況、Cloudflareとの同時通知が現に発生していないか。

## 4. Historical Design Intent

以下はRepository内の実装・証跡から復元できる候補であり、正本Architecture決定ではない。

- Cloudflare Worker / Cronを自動監視の主経路とする。
- Cloudflareは毎分起動し、実ページ観測は5分境界で行う。
- `SOLD_OUT` 等から `AVAILABLE` への変化で通知Seriesを生成する。
- DiscordおよびLINEへ合計5 Roundを、おおむね1分間隔で送る。
- Production状態と配送診断をD1で管理する。
- GitHub Actionsは手動diagnostic、テスト、緊急Fallbackとして残す。
- CloudflareとGitHubが同時に通知対象となる場合、独立Storeによる通知回数・タイミング差や重複の可能性がある。
- 終了後は基盤を削除せず、Cron・通知・Secretを安全に休眠化する。
- 実装は今後の別イベント監視に再利用可能な型として維持する。

証跡だけで現在の役割を確定できない項目は `Inferred` または `Unknown` とする。

## 5. Active Contracts

実装・テスト・証跡から確認できる契約:

- Cloudflareの空き枠復活通知は1 Series 5 Roundで、6回目を生成しない。
- AVAILABLE継続中は同一状態の新Seriesを生成しない。
- 4枠全失敗が3回連続した場合にoutageを1回だけ生成し、復旧時にrecoveredを1回生成する。
- DiscordとLINEはチャネル別に成功・失敗・再試行を管理する。
- LINE Retry-Keyはpending IDから分離したUUIDを使用し、再試行では同じ値を再利用する。
- 通知本文には利用者が直接開ける対象商品ページURLを含める。
- Secret値、Webhook URL、Token、User ID、groupIdはコード、Git、Issue、D1、ログ、文書、Artifactへ保存しない。
- CloudflareのCron非観測分はpending配送だけを処理し、5分境界で観測する。
- cutoffは `2026-08-23 16:30 JST`。cutoff後は新規監視を停止する設計である。
- GitHub側はconcurrencyで多重実行を抑止し、normalだけがIssueを更新する。

## 6. Primary CUJ Candidate

`SOLD_OUT`
→ Cloudflareの5分境界観測
→ 対象ページの4枠を個別取得
→ `AVAILABLE`への変化を判定
→ D1へ状態と5 Round Seriesを保存
→ Discord / LINEへ1回目を配送
→ 毎分起動で残りRoundを配送
→ 5 Roundで完了し6回目は送らない
→ AVAILABLE継続中は新Seriesを作らない
→ 利用者が対象URLから購入行動を開始する

- Trigger: Cloudflare毎分Cron（5分境界で観測）。
- Input: 公開商品状態、4つの日時枠、D1の前回状態。
- Decision: 状態値と前回状態の遷移、cutoff、lease、CAS、通知済みフラグ。
- Effect: D1状態更新、通知Seriesの配送、配送診断更新。
- Proof: D1 `watcher_state`、配送診断、既存のControlled Production E2E証跡。
- Repeat: Seriesの各Roundを分境界で最大5回。
- Failure: `UNKNOWN`、retry、outage抑制、失敗チャネルだけの再試行。
- Recovery: 正常観測でrecoveredを一度生成し、配送成功後にpendingを除去する。
- Confirmed Steps: Controlled通知E2E、group route health、D1正常、5 Round設計。
- Inferred Steps: 実際のキャンセル発生から購入開始までの利用者行動。
- Untested Boundary: 実サイトが本当にSOLD_OUTからAVAILABLEへ変化した瞬間の完全なProduction CUJ。
- Current Acceptance State: `OPERATIONAL_ACCEPTANCE_PENDING`。

## 7. Current State

- Production Active: Repository内の2026-08-05証跡ではCloudflare Group Candidateが100%、health=group、毎分Cron、D1正常。
- Implementation Verified: Cloudflare・Python・PowerShellの実装とローカルテストがRepositoryに存在する。
- Controlled Production E2E Verified: Personal / GroupのLINE test、およびURL付き通知・5 RoundのControlled E2Eが証跡に記録されている。
- Governance: `GOVERNANCE_BOOTSTRAP_ACCEPTED`
- Operational Acceptance: `OPERATIONAL_ACCEPTANCE_WAIVED_FOR_CURRENT_CAMPAIGN`
- GitHub Schedule: `UNCHANGED_NOT_REPAIRED`
- Production: `CLOUDFLARE_MONITORING_CONTINUES_UNCHANGED`
- Governance Profile: `QUALITY_PRESERVED_SCRATCH`
- Next Governance Promotion: `AT_NEXT_CAMPAIGN_REUSE_REVIEW`
- Pending Investigation: Cloudflare Productionの最新Version、実効Cron、GitHub自然schedule、Cloudflare/GitHub同時通知の有無。
- Deferred: 実際の状態変化から5 Round配送までの完全CUJ証明、休眠化時のGitHub schedule整理、次回再利用時のLITE昇格判定。
- Hibernate予定: cutoff後の停止・休眠化。今回変更しない。
- Path Normalization Complete: 新Repository配置とArchive移動は2026-08-05に完了。

## 8. Confirmed

- 本PJのGit Repositoryは新パスに存在し、`.git`を保持している。
- Branchは `feat/line-destination-routing`、HEADは `0fb110160fbba8fef548677d6a8fb31c87250a53`。
- tracked変更は0件、untrackedは8件で、Validation時点の既存dirty状態を維持している。
- 旧Desktop配置は存在せず、Repository内の旧パス文字列参照は0件。
- Cloudflare canonical設定にはWorker名 `okaz-slot-watcher-cf`、毎分Cron、D1 binding `DB`、公開Target URL、`DRY_RUN` / `LINE_ENABLED` が記載されている。
- D1 schemaには `watcher_state`、`watcher_lock`、`dry_run_events` が定義されている。
- Cloudflare実装にはscheduled / fetch handler、lease、CAS、4枠観測、5 Round通知Series、配送診断がある。
- GitHub Workflowにはschedule、workflow_dispatch、concurrency、normal専用 `issues: write`、diagnostic/test系 `contents: read` がある。
- Repository内の2026-08-05証跡には、Cloudflare Active Deployment `8bc06f32-33f5-4065-80e9-1b5ce2a78ac6`、Active Version `e65c222d-49ba-4dff-95f4-a3059d26db32`、100%、health=group、D1正常が記録されている。
- Repository内の証跡には、GitHub main group route、line_test成功、normal手動検証、4枠SOLD_OUT、通知なしが記録されている。
- 今回のローカル検証ではPython `pytest` が83件全成功、Cloudflare WorkerのTypeScript `typecheck` が成功した。Worker `npm test` は132件中131件成功で、Capture CLIのWrangler capabilityテスト1件が5秒timeoutした。
- Productionや外部APIは今回のBootstrapで読み取り・書込みしていない。

## 9. Inferred

- Cloudflareが現在の主監視・主通知経路で、GitHub ActionsはFallbackまたは検証経路として残された可能性が高い。
- Cloudflare毎分起動とGitHub `*/5` scheduleが同時に有効なら、両者が同じ状態変化を独立に通知し得る。
- `wrangler.production.toml` の `LINE_DESTINATION_MODE = "personal"` は、2026-08-05証跡が記録するProduction `group` と同一の現行正本ではない可能性がある。
- Controlled E2Eは配送契約の証拠になるが、自然なキャンセル発生からの完全CUJの証明にはならない。

## 10. Unknown

- Cloudflareの現在Active Version、実効Cron、D1、Secret binding、LINE destination mode。
- GitHub `WATCHER_ENABLED` / `LINE_DESTINATION_MODE` の現在値と、自然なscheduleの現在の発火状態。
- `KNOWN_VALIDATION_LIMITATION_CAPTURE_CLI_WRANGLER_TIMEOUT`: Capture CLIのWrangler capabilityテストが5秒timeoutした原因と、次回実行時の再現性。今回のBootstrapではコード修正や再試行を行っていない。
- CloudflareとGitHubが同時にProduction通知しているか、また重複抑止が外部経路間でも成立するか。
- 実際のキャンセル復活時にEcwid応答が4枠すべて期待どおりに変化するか。
- cutoff後にCloudflareとGitHubの両経路が確実に停止・休眠化するか。
- untracked 8件の最終的な正本性・Archive要否。

## 11. Risk

- High: CloudflareとGitHubが同時Production通知となる可能性。独立Storeのため、通知回数・タイミング差や重複が起こり得る。
- High: `wrangler.production.toml` の personal設定とGroup Production証跡のprovenanceが一致しない。誤った設定を正本とみなすと切替・Rollbackを誤る。
- Medium: GitHub scheduleが存在し、`WATCHER_ENABLED=true`ならnormalが自動実行され得る。意図したFallback契約と異なる可能性がある。
- Medium: 完全な実状態変化CUJが未確認で、Controlled E2Eだけでは実際の在庫復活判定を保証できない。
- Medium: cutoff後の停止・休眠化を両経路で実行・確認していない。
- Low: サブPCが非正本環境であり、業務PC側のGovernanceを継承しない。
- Low: 過去Status文書は時点証跡であり、更新日時だけでは現在状態を証明できない。
- Low: untracked 8件の役割が未整理で、将来のCommitやArchive時に混入リスクがある。

## 12. Decision Conflict

### ARCHITECTURE_DECISION_CONFLICT

- Historical Design Candidate: GitHub Actionsは手動Fallback・diagnostic・テストに限定する。
- Current Implementation Candidate: GitHub Workflowに `*/5` scheduleが存在し、`WATCHER_ENABLED=true` ならnormalが自動実行され得る。
- Additional Provenance Conflict: Repository内のcanonical `wrangler.production.toml` は `LINE_DESTINATION_MODE = "personal"`、2026-08-05のProduction証跡は `group` を記録している。
- 判定: Active-Activeが技術的に不可能とは断定しない。過去設計、現在実装、Production正本の役割が未確定である。
- 今回の扱い: schedule修復・削除・無効化・有効化、設定切替、Deployは行わない。

## 13. Resolved Human Decisions

- Decision Date: `2026-08-06 JST`
- Decision Source: `Human`
- Superseded Decision: `none`

### Decision 1 — GitHub schedule

- Decision: `MAINTAIN_CURRENT_CONFIGURATION_WITHOUT_SCHEDULE_REPAIR_UNTIL_HIBERNATION`
- Current campaign: Workflow、cron、disable/enable、`WATCHER_ENABLED` は変更しない。
- Operational role: Cloudflare Production監視を継続し、GitHub scheduleを現キャンペーンの完了条件にしない。
- Revisit Trigger: 休眠化工程でManual Fallbackとの整合を実装・文書照合する。Active-Active採用は別Human Decisionとする。

### Decision 2 — Full real-state CUJ

- Decision: `CURRENT_CAMPAIGN_HUMAN_WAIVER_WITH_NEXT_REUSE_ACCEPTANCE_GATE`
- Current campaign: Controlled Production E2Eを有効な証拠とし、完全な実状態変化CUJは未確認のまま運用継続する。
- Operational state: `OPERATIONAL_ACCEPTANCE_WAIVED_FOR_CURRENT_CAMPAIGN`
- Residual Risk: 実サイトのSOLD_OUT→AVAILABLE、Series生成、初回通知開始の境界がProduction上で一本の証拠になっていない。
- Revisit Trigger: 自然なAVAILABLE復活が発生した場合は通常運用を妨げない範囲でRun/Worker log、D1遷移、5 Round、6 Round目なし、重複Seriesなしを確認する。発生しなければ次回再利用のAcceptance Gateへ繰り越す。

### Decision 3 — Governance profile

- Decision: `KEEP_QUALITY_PRESERVED_SCRATCH_UNTIL_NEXT_REUSE`
- Current profile: `QUALITY_PRESERVED_SCRATCH` を維持し、`PROJECT_CONTEXT.md`だけで運用する。
- Not introduced: `PROJECT_CANON.md`、ADR群、Operational Contract、CI Governanceは追加しない。
- Revisit Trigger: 次回キャンペーン再利用開始時にLITE昇格を判定する。休眠化だけでは昇格しない。

## 13.1 Decision Residual Risk

- CloudflareとGitHubの同時通知リスクは、schedule修復を行わないため残る。
- 完全CUJ未確認のHuman Waiverは、自然な状態変化の判定品質を証明するものではない。
- canonical設定とProduction証跡のdestination mode差異は、外部照合を行うまで未解決である。

## 14. Next Allowed Action

Human Decisions確定後に許可される行為:

- RepositoryとArchiveの読み取り
- 休眠化時の`PROJECT_CONTEXT.md`のCurrent State、未解決事項、再開条件の更新
- 根拠パスの追加
- 誤記修正
- 旧パス参照の報告

次回再利用開始時に、LITE昇格と完全CUJ Acceptance Gateを再判定する。

Human Review前に禁止される行為:

- GitHub schedule修復、削除、disable、enable
- `WATCHER_ENABLED` / `LINE_DESTINATION_MODE`変更
- workflow_dispatch、通知テスト、Production E2E
- Cloudflare Deploy、Cron変更、D1書込み
- Secret、Variable、Webhook変更
- Architecture決定の暗黙上書き

## 15. Promotion Triggers

`QUALITY_PRESERVED_SCRATCH` からLITEへ昇格する候補条件:

- 次回キャンペーンへ再利用する。
- 他者が保守する。
- 業務PC側へ取り込む。
- 長期Production化する。
- 再度Decision Conflictが発生する。
- 複数AI / 複数PCで継続する。
- Production障害または状態不整合が発生する。
