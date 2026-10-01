# Phase 5B2C3C1 — definitive decline readiness

Local review and mock validation only. No Stripe API calls, payment objects, live payment attempt, deployment, admission enablement, or AWS mutation are authorized by this document. C3A and C3B remain closed successful acceptances. A future live decline needs separate human approval.

## Existing behavior (production code unchanged)

Payment start atomically reserves payment responsibility and returns acceptance, not a payment result. Initial confirmation is dispatched under the durable command identity. The Stripe adapter normalizes most SDK failures, including card errors, to PROVIDER_UNKNOWN internally; it never trusts raw error text as financial authority. The CONFIRM workflow catches that exception and retrieves the same canonical Intent. A valid requires_payment_method snapshot with paymentFailed=true (derived from last_payment_error presence) resolves the exception into definitive failure handling. It does not persist indefinite PROVIDER_UNKNOWN merely because the SDK threw. If retrieval itself fails, or the Intent remains unconfirmed without failure proof, responsibility is retained for reconciliation. This distinction is deliberate: the adapter error alone is not decline proof.

FinancialWorkflow overrides the ingress observe hook with canonical reconciliation. Before the deadline, a proven failure selects CANCEL with immutable terminalReason=FAILED. A durable cancellation command is prepared/dispatched and canonical canceled/zero-received/zero-capturable evidence is required before inventory release. Therefore the later live test should expect requires_payment_method as an intermediate state and canceled as the final provider state; it should not require the Intent to remain requires_payment_method after safe settlement. Cancellation is performed by the reviewed worker, never an ad hoc operator request.

The resulting local states are Cart CANCELLED, Order FAILED, Attempt FAILED, with one common settlement identity. Customer GET projects failed. No AUTHORIZED or capture claim is warranted by a decline; no capture command, capture-induced PAYMENT_COMMITTING, PAID outbox, or SOLD movement occurs. If provider state unexpectedly proves authorization/capture instead, its financial authority takes precedence over the intended test scenario and inventory must not be released on an error/browser assumption.

## Inventory and races

For the intended 20-total/5-owned fixture, failure settlement changes 20/5/0/15 to 20/0/0/20. Settlement reads current Inventory and subtracts only this Cart's owned quantity. Its conditional Put guards total/reserved/sold/updatedAt; a concurrent change causes bounded reread/retry. Unrelated reservations and prior SOLD quantities are preserved. Cart/Order/Attempt settlement markers, guards, durable-work cleanup and Inventory Puts commit atomically; stale/duplicate work cannot release twice.

Deadline selection has explicit precedence: if the first failure resolution occurs at or after paymentDeadline, it selects EXPIRED rather than FAILED, producing Cart/Order/Attempt EXPIRED and customer expired. If FAILED was selected before the deadline, that immutable reason survives cancellation/finalization crossing the deadline. Both outcomes use the same exactly-once release proof. Unknown cancellation, processing, or capture outcomes retain responsibility rather than release speculatively.

Stripe payment_intent.payment_failed receipts/inbox work are durable and idempotent. Duplicate or late events retrieve canonical state and transfer/complete responsibility; they cannot resurrect terminal workflow or double-release. New tests exercise duplicate failure receipts before and after settlement. Existing tests cover unknown cancellation/capture, rollback, contention and out-of-order terminal events.

## Customer, harness and telemetry

Capability authorization precedes payment GET; API/local responses are no-store. The terminal response projects identifiers, safe status, deadline and continuation generation, not raw provider errors, decline messages, payment-method details or a terminal client secret. No customer decline-code allowlist is exposed. Internal provider diagnostics are schema-bounded; raw SDK messages/request/response data are not logged.

After accepted payment/start, the existing harness detects failed/expired/cancelled and emits HARNESS_PAYMENT_TERMINAL_FAILURE with payment/start sent: yes. Its submission/continuation guards prevent automatic new tokens, repeated starts, new Carts or repeated authentication. A processing observation may stop bounded polling before terminal settlement; it is not failure or paid proof. No harness runtime change is needed.

Existing payment-transport tests cover bounded messageId, receiveCount, Lambda request ID, work type/revision/owner identity, outcomes and ACK/RETRY, including sensitive-payload exclusion and logging failure isolation. A returned safe terminal/stale outcome ACKs; thrown unresolved work RETRYs. This telemetry does not itself establish financial truth.

## Added regression coverage

- Full SDK-style decline through canonical retrieval, cancellation proof, safe failed status, no capture/PAID, and exact five-unit release.
- First resolution at the deadline versus failure selected before the deadline.
- Duplicate terminal work does not double-release.
- Other-owner reservations and existing SOLD stock survive decline settlement.
- Duplicate payment_failed inbox delivery before/after settlement remains idempotent.
- Harness failed/expired/cancelled outcomes preserve accepted-start semantics with one token/start and no authentication or continuation.

No production, infrastructure, dependency or admission configuration changes were made.

## Later human-only sandbox scenario

Use Stripe's official [testing documentation, Generic decline scenario](https://docs.stripe.com/testing#declined-payments): card_declined / generic_decline. Obtain its sandbox card details directly from that page and enter them manually only inside Payment Element. Do not copy card numbers into source fixtures, logs, scripts or this document. Use a future expiry and the documented test-form requirements. Do not run this scenario during C3C1.

A future separately approved attempt must begin with admission false, clean responsibility/queues/alarms and a valid OPEN Drop; prepare the harness before reserving, enable only through the reviewed helper, create one Cart, and hand off with adequate time. One Pay click only. Confirm canonical failure, worker cancellation proof, terminal local settlement and released inventory; always explicitly relock false. Stop for review on unknown outcome, and never retry by creating replacement payment state.

## C3C1 validation result

On 2026-10-01: 838 backend functional tests (five new decline/settlement cases), 7 artifact tests, 50 harness tests (three new terminal cases), 2 production-exclusion tests, 7 frontend tests and 34 infrastructure tests passed. Backend, frontend and infrastructure typechecks/builds passed, as did frontend lint and repository formatting. Isolated CDK synth passed; the subsequent isolated read-only dev diff reported no differences, with zero replacements/deletions. No infrastructure source changed. Live admission was read-only verified false.

Backend audit reported zero vulnerabilities. Frontend audit reported one moderate and one high affected package (Next.js/PostCSS); infrastructure audit reported one high brace-expansion finding. These match the existing documented temporary risks in [DEPENDENCY_RISKS.md](DEPENDENCY_RISKS.md); they were not fixed or newly introduced in this tests/docs-only phase. Dependency changes require separate review.

The local decline-readiness gate passes under those existing dependency-risk decisions. One controlled live generic-decline attempt is technically ready for separate human authorization; no live decline acceptance has been performed or claimed.
