# AIPay Incident Response and Rollback Runbook

This runbook is the source of truth for closed-test payment incidents. It uses a lightweight NIST/SRE lifecycle: prepare, detect, contain, eradicate, recover, communicate, and learn. Safety takes priority over availability. Preserve state and evidence; do not repair payment, budget, delivery, refund, or Outbox rows with direct SQL.

## Severity and Roles

| Severity | Trigger                                                                                                                        | Initial response                                                        | Update cadence   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------- |
| SEV-1    | Unauthorized or duplicate charge, private-key exposure, broad incorrect payment state, or uncontrolled payment execution       | Global pause immediately; incident commander and operations lead engage | Every 15 minutes |
| SEV-2    | One Agent or merchant affected, provider outcome unknown, callback backlog, reconciliation mismatch, or recovery path impaired | Isolate affected identity; pause globally if the scope is uncertain     | Every 30 minutes |
| SEV-3    | Degraded non-payment function with no incorrect money or authorization state                                                   | Contain the component and monitor payment invariants                    | Every 60 minutes |

Assign one person to each active role. The incident commander owns severity, scope, decisions, and closure. The operations lead executes containment and recovery. The communications lead sends developer and merchant updates. The scribe records an append-only UTC timeline, commands, observations, transaction IDs, and decision owners. Never put credentials, private keys, session/API tokens, raw provider payloads, or personal data in the incident log.

## Detect and Declare

Declare an incident from any credible signal rather than waiting for certainty:

- Prometheus alert for payment failure ratio, callback/Outbox backlog, reconciliation difference, abnormal budget use, or target loss;
- a developer or merchant report of an unexpected charge, missing delivery, or repeated callback;
- a leaked credential or signing key;
- a Transaction whose AIPay state differs from the provider or whose payment outcome remains unknown;
- a deployment or migration that changes payment behavior unexpectedly.

Record the start time, reporter, affected environment, first known Transaction/Agent/merchant, suspected start time, current deployment commit, incident commander, and severity. Open the console transaction timeline before containment so its initial state is preserved in the incident record.

## Contain

1. For SEV-1 or uncertain scope, open `/controls` and enable global payment pause. Verify the control remains enabled after a page reload. Existing paid Transactions may still finish delivery or refund; no new provider payment may start.
2. Open `/agents` and disable each affected Agent. Revoke its active signing keys. If a developer credential may be exposed, revoke or rotate the API key/session as well.
3. Rotate an exposed Agent, merchant, system, provider, metrics, database, callback, or backup key at its authority. Update protected runtime configuration, restart only affected services, then revoke the prior key. Do not paste a secret into chat, tickets, logs, command history, or the timeline.
4. Preserve evidence before restarting: console timeline, aggregate metrics, service status, application log time range, provider reference, call-ledger state, Outbox state, current commit, and configuration version. Capture identifiers and hashes, not secret values or raw sensitive bodies.
5. If containment cannot be proven for one identity, keep global pause active. Availability is not evidence of payment safety.

Useful read-only checks:

```bash
systemctl --user status aipay-api aipay-worker aipay-caddy
pnpm run deploy:smoke
pnpm run monitoring:check
```

## Recover Transactions

Use `/transactions` and the immutable timeline to classify each affected Transaction. Recovery must use application/provider idempotency paths and create auditable events.

| State                                       | Required action                                                                                                                                                              | Forbidden action                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `authorized` with no provider call          | Keep global pause active until the cause is understood; later resume through the normal payment endpoint                                                                     | Creating a provider payment outside AIPay                                               |
| `payment_review` or unknown provider result | Query the provider using the existing Payment Attempt and provider reference. If create must be retried, use the same attempt and provider idempotency key, then query again | Creating a second Transaction/Payment Attempt or assuming timeout means failure         |
| `paid` with delivery pending                | Continue proof-bound fulfillment with the stored result and confirm delivery; if the exact consume response was lost, recover its original Delivery ID before retrying       | Re-consuming proof for a different resource or starting another payment                 |
| delivery/refund review                      | Query and reconcile the existing delivery/refund attempt; allow monotonic application transitions to write the result                                                        | Direct SQL state mutation, widening a refund, or replaying a terminal callback manually |
| stale Outbox/Webhook claim                  | Let the worker reclaim the expired lease; inspect retry/dead-letter evidence and repair the destination before an application-level redrive                                  | Deleting Outbox rows or marking delivery successful without a 2xx response              |

For every affected item, compare AIPay amount, merchant, service, Agent, provider order/reference, latest provider status, payment attempt, provider call ledger, Transaction status, budget reservation, delivery/refund state, and Outbox events. A later callback or query must never regress a terminal state. Keep global pause in place until this reconciliation is complete.

The deterministic tabletop drill exercises the supported recovery path without real funds:

```bash
pnpm run incident:drill
pnpm run test:faults
```

The drill must prove global pause, Agent isolation, provider timeout recovery from a new service instance using the same attempt, active query to paid, signed merchant notification, paid timeline evidence, and pause persistence.

## Roll Back an Application Release

Application rollback is a new audited Git change, not an untracked filesystem replacement.

1. Identify the first bad commit and confirm the prior version understands the current database schema and event formats.
2. Create a revert with `git revert <bad-commit>` and have it reviewed. Never reset shared history.
3. Run `pnpm run check`, relevant tests, `pnpm run security:scan`, and `pnpm run incident:drill` while payments remain paused.
4. Build and redeploy with `pnpm run deploy:local`, then run `pnpm run deploy:smoke`.
5. Verify metrics, console controls, an isolated non-money workflow, Transaction timelines, Worker leases, and reconciliation before gradually re-enabling Agents and finally removing global pause.

Database migrations are forward-only. Do not downgrade or delete an applied migration during an incident. If a data migration is defective, ship a reviewed compensating migration. A backup restore is disaster recovery, not the normal application rollback: create an encrypted backup with `pnpm run db:backup <new-file>`, restore and validate it only in an independent `_test` database, then perform a separately approved controlled cutover. Never restore over the source database.

## Communicate

Send factual updates without secrets or speculation. Each update includes incident ID/severity, detected time, affected function and known scope, containment state, whether payments are paused, user action if any, next update time, and owner/contact. Notify affected developers and merchants directly when their Agent, Transaction, delivery, refund, credential, or callback is involved.

Initial template:

> We are investigating an AIPay payment incident detected at `<UTC time>`. `<scope>` is affected. New payments are `<paused/not affected>`; existing successful payments will not be repeated. The next update is due at `<UTC time>`.

Resolution template:

> AIPay recovered `<scope>` at `<UTC time>`. We reconciled `<count>` Transactions against provider and audit records, confirmed `<result>`, and notified affected parties. Follow-up actions are tracked under `<incident ID>`.

## Verify and Close

Before removing global pause, the incident commander and operations lead must both confirm:

- the initiating cause is removed or bounded and exposed credentials are revoked;
- every affected Transaction is reconciled, with no unauthorized/duplicate charge and correct budget reservation;
- provider, delivery/refund, call ledger, timeline, Outbox, and merchant callback states agree;
- `pnpm run incident:drill`, `pnpm run test:faults`, `pnpm run deploy:smoke`, security checks, metrics, and alerts pass as applicable;
- affected users and merchants received the resolution and required remediation;
- rollback/recovery commit, deployment version, evidence locations, and residual risks are recorded.

Re-enable one isolated Agent first, observe payment and callback metrics, then expand in bounded steps. Re-enable the global control last. Within two business days, write a blameless postmortem covering impact, UTC timeline, detection gap, root and contributing causes, control performance, money/reconciliation evidence, corrective owners and due dates, and a regression test or alert for every preventable failure.
