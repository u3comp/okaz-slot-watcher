# Controlled Production CUJ Runbook

This runbook describes the isolated Cloudflare acceptance harness for the
purchase-page URL notification path.

## Safety contract

- The harness is disabled by default (`ACCEPTANCE_HARNESS_ENABLED=false`).
- Acceptance rows are stored in `acceptance_state`; canonical
  `watcher_state`, normal pending, slot observations, outage counters, and
  leases are not used as test state.
- The start and observe endpoints require a bearer token, a strict Test ID,
  and a bounded JSON body. The token is never placed in a URL or log.
- The observe request supplies a normalized `AVAILABLE` observation for the
  synthetic `Acceptance Test Slot`. The normal series generator creates five
  rounds with one-minute spacing; no pending row is injected by the operator.
- The normal scheduled delivery function delivers at most one due round per
  invocation. Each round carries the Test ID, the warning marker, and the
  configured purchase URL. A sixth round is never generated.

## Procedure

1. Confirm the candidate is 100%, destination mode is `group`, normal D1
   pending is empty, the lease is free, and the cutoff has not passed.
2. Enable the harness only on the candidate version and create a unique
   `CF-CUJ-...` Test ID. Keep the token in process memory only.
3. `POST /__acceptance/start` with `{ "test_id": "..." }`.
4. `POST /__acceptance/observe` with the normalized observation and the exact
   synthetic slot label.
5. Allow the existing Cron Trigger to deliver rounds 1/5 through 5/5. Do not
   call Discord or LINE directly and do not write D1 manually.
6. Inspect only `acceptance_state` for the test row and separately verify that
   canonical state remains healthy and has no normal pending.
7. After human receipt confirmation, deploy a final version with the harness
   disabled. Remove or disable the temporary harness secret and verify the
   endpoint returns 404.

## Stop conditions

Stop without retrying if canonical state changes unexpectedly, a normal
notification is emitted, a URL or warning is missing, a duplicate or sixth
round appears, a secret is exposed, a CAS conflict is ambiguous, or the
harness cannot be disabled safely.

Full natural `SOLD_OUT -> AVAILABLE` on the real site remains unverified by
this controlled procedure.
