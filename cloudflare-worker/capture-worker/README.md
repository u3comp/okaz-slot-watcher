# LINE groupId capture worker (local-only)

This is a dormant-by-default local implementation for the future Human
Checkpoint B. It is not deployed, has no Cron, no D1/KV/R2 binding, and has
observability and persistent logs disabled in the example configuration.

The handler accepts HTTPS `POST` only, verifies the raw-body
`x-line-signature` with `LINE_CHANNEL_SECRET`, parses valid JSON, and accepts
only `source.type == "group"`. It emits exactly one dedicated JSON event to a
local `wrangler tail` stream; no ordinary log contains webhook content,
userId, or message text. `capture-worker/orchestrator.ts` consumes that stream
in memory and passes the groupId directly to secret-setting callbacks without
printing or persisting it. A Worker isolate may be recreated between requests,
so its in-memory duplicate suppression is best effort; the local orchestrator
receiving one event is the authoritative stop condition. Immediately after
capture, stop the tail, disable webhook delivery, and move to the dormant
sink. The Worker must not be deployed or registered as a LINE webhook until
Human Checkpoint B approval.

## Executable local pipeline

`capture-group-id.mjs` runs the project-local Wrangler binary, starts
`wrangler tail --format json`, parses the real top-level `logs[].message[]`
envelope, and stops the child process after the first valid event or timeout.
Without `--apply` it only reports a coarse capture status. With explicit
`--apply`, it checks that `LINE_GROUP_ID` is absent by name, then sends the
captured value through stdin to `gh secret set` and
`wrangler versions secret put`; the value is never an argument, output, file,
environment variable, or clipboard entry. A partial setup is rolled back once
without retry. No command is run automatically by tests or CI.
