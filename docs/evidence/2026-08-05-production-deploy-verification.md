# Production Deploy Verification Evidence

- Target Version: `0a685610-dbbc-40b4-bd6e-76d84051598d`
- Deployment: `3a959931-add6-4ced-9cfb-6fc7d1ee962d`
- Active traffic: `100%`
- Production mode: `personal`
- Deploy timestamp: `2026-08-05T06:23:56.548959Z`
- Health: HTTP 200, exact three-key JSON schema, personal, configured booleans true
- Effective Cron: one schedule, `* * * * *`, created/modified timestamps unchanged
- D1: version 527 before deploy; 529 after normal scheduled checks; pending empty; failures 0; lease 0
- Scheduled tail: three filtered scheduled envelopes, each `outcome=ok`
- Notifications: no deliberate test notification; none observed during verification
- Rollback: not performed

All values above are non-secret deployment metadata. Secret values and destination IDs are intentionally excluded.
