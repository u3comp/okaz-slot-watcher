# LINE groupId capture worker (local-only)

This is a dormant-by-default local implementation for the future Human
Checkpoint B. It is not deployed, has no Cron, no D1/KV/R2 binding, and has
observability and persistent logs disabled in the example configuration.

The handler accepts HTTPS `POST` only, verifies the raw-body
`x-line-signature` with `LINE_CHANNEL_SECRET`, parses valid JSON, and accepts
only `source.type == "group"`. It never logs, persists, forwards, or returns a
groupId. `extractGroupId` exists only for local unit tests and controlled
operator-side transfer. The Worker must not be deployed or registered as a
LINE webhook until Human Checkpoint B approval.
