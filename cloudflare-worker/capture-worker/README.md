# LINE groupId capture worker (local-only)

This is a dormant-by-default local implementation for the future Human
Checkpoint B. It is not deployed, has no Cron, no D1/KV/R2 binding, and has
observability and persistent logs disabled in the example configuration.

The handler accepts HTTPS `POST` only, verifies the raw-body
`x-line-signature` with `LINE_CHANNEL_SECRET`, parses valid JSON, and accepts
only `source.type == "group"`. Every correctly signed, valid JSON POST returns
HTTP 200, including LINE's `events: []` verification request, non-group events,
duplicate events, and an already-captured session. Those no-op cases emit no
log. A first valid group event emits exactly one dedicated JSON event to a
local `wrangler tail` stream; the HTTP body is only `ok` and contains no
destination or ID. No ordinary log contains webhook content, userId, roomId,
or message text. `capture-worker/orchestrator.ts` consumes the event in memory
and passes the groupId directly to secret-setting callbacks without printing
or persisting it. A Worker isolate may be recreated between requests, so its
in-memory duplicate suppression is best effort; the local orchestrator
receiving one event is the authoritative stop condition. Immediately after
capture, stop the tail, disable webhook delivery, and move to the dormant
sink. The Worker must not be deployed or registered as a LINE webhook until
Human Checkpoint B approval.

## Executable local pipeline

`capture-group-id.mjs` runs the project-local Wrangler binary, starts
`wrangler tail --format json`, parses the real top-level `logs[].message[]`
envelope, and stops the child process after the first valid event or timeout.
It drains both stdout and stderr, closes the line reader and timers, waits for
close after SIGTERM, and uses SIGKILL only after the grace timeout. A failed
stop is reported as `tail_stop_failed` / `tail_stopped=false` and blocks every
Secret operation.
Without `--apply` it only reports a coarse capture status. With explicit
`--apply`, it checks that `LINE_GROUP_ID` is absent by name using GitHub's JSON
list and project-local `wrangler secret list --format json` for the currently
deployed Worker, then sends the captured value through stdin to `gh secret
set` and `wrangler versions secret put`; the value is never an argument,
output, file, environment variable, or clipboard entry. Before and after the
Cloudflare write it reads `wrangler versions list --json`, and identifies the
new undeployed Version by a unique non-secret tag and message rather than by
parsing human-readable stdout. If that Version cannot be identified uniquely,
the GitHub Secret is deleted once, the possible undeployed Cloudflare Version
is left for human review, and the status is
`partial_cloudflare_secret_version_unverified`. No automatic retry or deploy
is performed. No command is run automatically by tests or CI.
