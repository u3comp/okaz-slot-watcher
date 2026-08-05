# Group Candidate Deploy Approval

- Decision: `APPROVE_GROUP_CANDIDATE_PRODUCTION_CUTOVER`
- Approved on: `2026-08-05 JST`
- Candidate Version: `e65c222d-49ba-4dff-95f4-a3059d26db32`
- Target-Mode: group
- Personal rollback Version: `0a685610-dbbc-40b4-bd6e-76d84051598d`
- Expected current mode: personal（GitHub Variable未設定による既定値）
- Expected effective Cron: `* * * * *`

承認範囲は、Group／Personal Remote WhatIf、Production health・Cron・D1・GitHub
VariableのGate確認、上記Group Candidateの100% Deploy、GitHub
`LINE_DESTINATION_MODE=group`設定、最初のscheduled実行とD1確認、および異常時の
Personal VersionへのRollbackとGitHub Variable未設定への復元である。

Worker Upload、Version Upload、Secret変更、Cron変更、D1直接変更、Webhook変更、
main統合、追加通知試験は承認範囲に含まれない。
