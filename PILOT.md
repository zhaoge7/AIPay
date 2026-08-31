# AIPay Design Partner Pilot

This runbook defines the evidence required for P11. It deliberately separates engineering readiness from external validation: repository examples, Fake Provider runs, automated loops, synthetic traffic, and work performed by the AIPay implementation itself never satisfy a real-partner checklist item.

## Admission Criteria

A merchant partner is admissible only when an external operator controls a real API or MCP capability, agrees to a CNY unit and positive unit price, operates its AIPay merchant/Quote/Delivery integration outside this repository, and can receive signed callbacks at an HTTPS endpoint. The capability must return a useful result derived from live partner logic or data; a static fixture is not admissible.

An Agent partner is admissible only when an external operator controls an Agent implementation outside this repository. The Agent must form its own request, use the public SDK or protocol, hold its own private key, receive a user-issued Mandate, handle HTTP 402 or MCP payment discovery, and consume the delivered result. AIPay maintainers may support setup but must not run a hidden hard-coded client on the partner's behalf.

Before onboarding, agree on:

- operator aliases and evidence URLs without personal data;
- merchant capability, service type, unit, CNY price, refund policy, and callback URL;
- Agent use case, expected legitimate volume, user Mandate limits, and stop conditions;
- UTC pilot window, environment URL, payment product, incident contact route, and global-pause owner;
- what constitutes a useful service call and how development, retries, load tests, loops, and synthetic traffic are excluded.

Create the private SDK kit in a new protected directory and verify the exact artifact in a temporary repository-external npm project:

```bash
pnpm run partner-kit:build -- .local-state/partner-kit-<partner>-<version>
pnpm run partner-kit:test
```

Send the named partner the required tarballs, `SHA256SUMS`, `KIT.json`, and `INSTALL.md` through the approved private channel. Every partner receives the role-based SDK plus its runtime Contracts; a FastGPT-compatible Agent operator also receives the MCP bridge, while an admitted API provider may receive the fixed Merchant adapter. Do not upload any package to npm until repository licensing and publication authorization are explicit.

For a FastGPT-compatible operator, use the private `examples/agent-mcp-bridge` package. The partner deploys it outside AIPay and configures its Streamable HTTP `/mcp` endpoint plus Bearer header in FastGPT. The bridge exposes start/resume/deliver tools so a redirect-based payment can cross Agent turns without changing the Payment Attempt or resource URL. Exact HTTPS origin, paths, query keys, Agent key and Mandate are operator configuration, not model input. Follow its README and verify its package tests before distribution.

For an API provider that cannot modify its upstream service in the pilot window, use the private `examples/merchant-http-adapter` package. The provider deploys it outside AIPay, owns the Merchant/upstream keys and PostgreSQL state, and configures one exact paid public GET plus one exact public upstream GET. The adapter persists consume/result/Receipt progress and uses the recovery API after a lost consume response. It is only suitable for the agreed low-risk JSON capability; it is not a generic reverse proxy or authority to resell a third party's API.

## Onboarding Sessions

Record start and completion times independently for merchant and Agent. Keep failures as stable phase/code entries rather than free-form secrets or payloads.

Merchant session:

1. Start the timer before reading AIPay documentation.
2. Create a merchant and service with the agreed fixed positive price.
3. Generate the merchant key in the partner environment and register only its public key.
4. Implement signed Quote/402, Payment Proof consumption, deterministic fulfillment, Delivery Receipt, and signed callback verification.
5. Prove one unpaid request returns 402 and one proof replay returns the stored result without a second charge.

Agent session:

1. Start the timer before installing the SDK or reading the protocol.
2. Create the Agent and generate its private key outside AIPay; register only the public key.
3. Have a user issue the bounded Mandate and review merchant, category, amount, count, validity, and confirmation threshold.
4. Discover the partner capability, pay from the Agent implementation, and consume the real result.
5. Prove an out-of-Mandate request is rejected and global pause blocks a new provider payment.

For each failed attempt, record `occurredAt`, `actor` (`merchant` or `agent`), `phase`, stable `code`, whether documentation or product caused it, `resolvedAt`, and the corrective action reference. Do not record tokens, keys, raw payment messages, personal data, or partner proprietary payloads.

## Evidence Manifest

Create `pilot/manifest.json` from `pilot/manifest.example.json`. Real manifests and generated reports are Git-ignored because they can link to private partner evidence. Store them in the approved evidence system with access control and retention; preserve hashes in the pilot decision record.

Evidence URLs may point to an access-controlled repository, ticket, signed document, or invoice. They must be HTTPS and independently accessible to the reviewer. An operator attestation is supporting evidence, not a replacement for AIPay database state.

The manifest fixes the accepted merchant, service, Agent, pilot window, external implementation evidence, capability and price evidence, traffic attestation, recorded integration failures, and commercial-intent status. Changing scope creates a reviewed new manifest version rather than silently widening the count.

Create private `pilot/traffic.json` from `pilot/traffic.example.json`. Every accepted entry binds one AIPay Transaction to one unique external workload hash and records when the partner accepted the useful result. Compute the hash from a pilot-specific random salt plus the partner's stable business/work item ID; keep the salt and original ID in the partner evidence system, never in Git. Every scoped development, synthetic, loop, replay, load-test or failed-workflow Transaction must appear in `exclusions` with its evidence URL. Anything in neither list remains unclassified and blocks Gate eligibility.

Generate a new non-overwriting `0600` report from the deployed database and both private evidence inputs:

```bash
pnpm run pilot:report -- pilot/manifest.json pilot/traffic.json pilot/reports/report.json
```

The command validates the Manifest and traffic ledger, verifies catalog/scope/classification, and calculates accepted/excluded/unclassified calls, missing ledger transactions, payment and delivery rates, preauthorized/manual-confirmation share, Fake Provider exclusions, missing reservations, multiple successful attempts, Provider call-ledger completeness, Proof/Receipt bindings, Outbox timeline completeness, onboarding duration, failure groups, and Gate MVP database eligibility. It prints only file/hash metadata; review the private report and external evidence together. Start the real pilot only after migration `1787788830000`; older terminal Transactions are not guessed as previously confirmed.

## Acceptance Rules

| Checklist item | Required evidence                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P11-01         | Merchant/service exist in the closed-test database; external capability and implementation evidence are reachable; unit and positive CNY price match the catalog                                                                                     |
| P11-02         | Agent exists in the database; external implementation evidence identifies a repository or deployed artifact outside AIPay; private key remains partner-controlled                                                                                    |
| P11-03         | One in-window Transaction binds the admitted Agent/merchant/service and has a successful non-Fake Payment Attempt, Payment Proof, successful signed Delivery Receipt, paid/delivered Outbox evidence, and complete timeline                          |
| P11-04         | At least 1,000 accepted in-window Transactions satisfy P11-03 and have unique salted external workload hashes plus useful-result acceptance; every scoped non-production call is explicitly evidenced/excluded and none is unclassified              |
| P11-05         | Merchant and Agent onboarding duration plus every recorded failure are aggregated into the generated developer-experience report                                                                                                                     |
| P11-06         | At least one partner has a signed paid-intent evidence reference or AIPay has evidence of the first software service fee; a sandbox service purchase alone is insufficient                                                                           |
| P11-07         | The review uses measured conversion, integration time, failure mix, accepted calls, payment/delivery success, incidents, unauthorized/duplicate payment, audit completeness, and commercial intent to choose orchestration or metering/billing focus |

P11 and Gate MVP remain incomplete until a reviewer can inspect this external evidence. A passing engineering test suite cannot waive an admission rule.

## Pilot Operation

1. Run `pnpm run gate:p10` before admitting either partner.
2. Keep global pause enabled while identities, keys, Mandate, callback, and price are reviewed.
3. Execute one bounded Transaction, reconcile it with the provider, inspect `/transactions`, and obtain partner confirmation of useful delivery.
4. Re-enable only the admitted Agent for bounded batches. Monitor failures, Outbox/Webhook backlog, reconciliation, budgets, unauthorized payments, and duplicate successful attempts.
5. Pause on any money/audit invariant breach and follow `INCIDENT_RESPONSE.md`.
6. Generate and review the evidence report before marking any P11 item complete.

External availability is still required. The current `aipay.localhost` deployment is not reachable by design partners; obtaining a real domain, DNS/TLS, firewall exposure, and partner authorization is a prerequisite, not an implementation detail to bypass with fabricated traffic.

For the authorized public pilot host, set `AIPAY_PUBLIC_ORIGIN` to a bare HTTPS port-443 origin and configure the Alipay Web sandbox/production variables in the protected `.env`; `AIPAY_ALIPAY_NOTIFY_URL` must equal `<origin>/v1/payments/alipay/webhook`. Then run:

```bash
AIPAY_PUBLIC_ORIGIN=https://pilot.your-domain.cn pnpm run deploy:pilot
AIPAY_PUBLIC_ORIGIN=https://pilot.your-domain.cn pnpm run deploy:smoke:pilot
```

External mode refuses localhost, non-443 origins and Fake Provider. Caddy obtains a public certificate and the Worker removes its loopback callback exception. Do not start this mode before DNS, inbound HTTPS, partner authorization and payment credentials are in place.
