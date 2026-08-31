# AIPay Pilot Participation and Commercial-Intent Record

This document records pilot scope and intent. It is not a payment instruction, production service agreement, data-processing agreement, or binding purchase commitment. Each organization should complete its own legal, security, privacy, tax, and procurement review before signature. Keep the signed copy in the approved private evidence system; commit only its URL/hash through the private pilot Manifest.

## Record

- Pilot ID:
- Document version:
- UTC pilot start/end:
- AIPay revision and environment origin:
- AIPay authorized representative:
- Partner legal name and operator alias:
- Partner authorized representative and role:
- Partner role: Merchant / Agent / both
- Incident contact route:

## Merchant Scope

- Merchant ID:
- Service ID and type (API/MCP):
- Capability and useful-result definition:
- Unit:
- Fixed CNY amount per unit:
- Price evidence URL/version/date:
- Refund policy:
- External implementation/deployment evidence:
- HTTPS callback:
- Upstream credential owner:
- Data categories processed:
- Explicitly excluded data/uses:

## Agent Scope

- Agent ID:
- Real workload/use case:
- External implementation/deployment evidence:
- Private-key owner:
- User/principal authorization owner:
- Mandate merchant/category/amount/count/validity limits:
- Expected legitimate calls:
- Useful-call evidence and traffic attestation method:
- Pilot-specific workload-hash salt custody (do not include the salt here):
- Transaction-to-workload ledger evidence URL/hash:
- Development/synthetic/loop/replay/load-test exclusion method:

## Acceptance

- One end-to-end Transaction must show a non-Fake successful Payment Attempt, correctly bound confirmed reservation, consumed Payment Proof, successful signed Delivery Receipt, paid/delivered Outbox evidence, and partner-confirmed useful result.
- Only transactions meeting `PILOT.md` and the fixed Manifest scope count toward 1,000 calls.
- Unauthorized payments and duplicate successful attempts must remain zero; audit completeness must remain 100%.
- Either party may activate global pause and stop the pilot on any money, authorization, privacy, security, legal, or audit concern.
- Private keys, tokens, credentials, personal data, raw provider messages, proprietary results, and signatures are never committed to Git.

## Integration Measurement

- Merchant onboarding started/completed UTC:
- Agent onboarding started/completed UTC:
- Failure log evidence URL:
- Documentation/product corrective-action evidence URL:
- Final report URL/hash:

## Commercial Intent

Select and complete one statement:

- [ ] Pending: no commercial intent has been expressed. This does not satisfy P11-06.
- [ ] Paid intent: if the acceptance conditions above are met, the partner intends to begin a good-faith commercial evaluation of AIPay at the following target pricing/budget and decision date, subject to definitive agreements and internal approval:
- [ ] Paid fee: the partner has paid the following AIPay software service fee; invoice/payment evidence is stored at the private reference below:

- Target commercial model (per-call/platform/integration/other):
- Target price or budget range:
- Target decision date:
- Paid-intent or fee evidence URL/hash:

## Sign-off

By signing, each representative confirms that the recorded pilot facts and their organization's stated intent are accurate to the best of their knowledge and that they are authorized to participate in the pilot. Signature does not authorize AIPay to move funds outside the explicit Mandate or publish confidential evidence.

- AIPay representative / role / date / signature:
- Partner representative / role / date / signature:
