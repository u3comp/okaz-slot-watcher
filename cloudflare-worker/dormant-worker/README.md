# Managed dormant sink (local-only)

After groupId capture and human-approved Webhook shutdown, the same endpoint
can be replaced with this minimal sink. It accepts `POST` with status 200
without reading the body and returns 405 for other methods. It emits no logs,
performs no subrequests, and has no bindings, secrets, or Cron trigger.

This file is a local implementation only. It has not been uploaded or
deployed.
