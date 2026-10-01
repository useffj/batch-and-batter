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

## Final C3C live definitive-decline acceptance — human approved

**PHASE 5B2C3C DEFINITIVE-DECLINE ACCEPTANCE: PASSED**, with the non-blocking RETRY-cause limitation below. This separately authorized live acceptance occurred on 2026-10-01, after the local C3C1 readiness review above. It does not authorize another payment attempt, deployment, or payment enablement. Final live admission was verified `PAYMENT_START_ENABLED=false`.

Prior C3A/C3B acceptance records, including failed historical attempts, remain unchanged in [PHASE_5B2C3A_LOCAL_ACCEPTANCE_CLIENT.md](PHASE_5B2C3A_LOCAL_ACCEPTANCE_CLIENT.md). The earlier C3C preparation stop for absent local credentials created no timed customer/payment state. The successful definitive-decline attempt is recorded separately here; prior failures are not reclassified as successes.

### Accepted business and provider evidence

| Record         | Identifier                    | Final state |
| -------------- | ----------------------------- | ----------- |
| Cart           | `01M3W6D7VE3ABY2Q1T6FT6EQ4D`  | CANCELLED   |
| Order          | `01M3W6KE108ZGKKT1WCG1H7D35`  | FAILED      |
| PaymentAttempt | `01M3W6KE0ZS4AGG76F6FFGXEQM`  | FAILED      |
| PaymentIntent  | `pi_3ULnM8Dz3QSwRsAl0oBZ2psM` | canceled    |
| Drop           | `01M3W67X4Q5QGFBBPH8JEVR2A0`  | CLOSED      |

Exactly one payment/start request was accepted with HTTP 201 (request ID `Eku51iajCYcEMCw=`). Canonical requires_payment_method was observed. Read-only failed-Charge evidence established `card_declined` / `generic_decline`, `paid=false`, and `captured=false`. The final sandbox Intent was canceled with amount_received=0 and amount_capturable=0. No raw Stripe error messages or payment-method details are reproduced here.

The reviewed worker obtained durable cancellation proof before terminal failure settlement. Cart CANCELLED / Order FAILED / Attempt FAILED matched the customer-safe failed projection and the human-reported, subsequently observed `HARNESS_PAYMENT_TERMINAL_FAILURE` diagnostic with payment/start sent: yes. No retry/new Cart/token/payment was initiated by the acceptance procedure. Terminal status does not expose a client secret.

### Timing and financial safety

| Evidence                                          | UTC time on 2026-10-01 |
| ------------------------------------------------- | ---------------------- |
| Canonical requires_payment_method observed        | 17:01:22.645           |
| Durable cancellation PREPARED                     | 17:01:22.649           |
| Cancellation DISPATCHED                           | 17:01:23.777           |
| Canonical canceled proof observed                 | 17:01:25.116           |
| Terminal Cart/Order/Attempt settlement timestamps | 17:01:26.797–835       |
| Immutable paymentDeadline                         | 17:05:13.119           |

Settlement completed approximately 226 seconds before the deadline. No evidence existed for AUTHORIZED, requires_capture, capture authority, a capture command, capture-induced PAYMENT_COMMITTING, SOLD movement, PAID settlement, or a PAID outbox. No manual financial mutation occurred; provider cancellation was performed by the existing reviewed worker path.

Inventory moved from **20 total / 5 reserved / 0 sold / 15 available** to **20 total / 0 reserved / 0 sold / 20 available**. This Cart's five owned reserved units were released exactly once. No duplicate release, SOLD movement, or manual inventory repair occurred. Terminal records and cleared durable responsibility corroborated the result.

### Webhook and transport evidence

Durable receipts for `payment_intent.payment_failed` (`evt_3ULnM8Dz3QSwRsAl0C0dr65F`) and `payment_intent.canceled` (`evt_3ULnM8Dz3QSwRsAl02yKvc3C`) reached PROCESSED. Canonical provider retrieval remained authoritative. No unresolved PAYMENT, PAYMENT_WORKFLOW, or relevant STRIPE_EVENT responsibility remained.

The relevant safe worker dispositions were:

| MessageId                              | Receive count | Outcome / disposition         |
| -------------------------------------- | ------------- | ----------------------------- |
| `96443e55-999d-494e-9e6a-1c082bd8626e` | 1             | CREATED / ACK                 |
| `3dced077-59c2-4efc-b1fd-7ab04f27f3c4` | 1             | STALE_WORK / ACK              |
| `1fb78e66-b387-4a97-85ca-0e01867012a4` | 1             | BOUND / ACK                   |
| `13278f29-8350-4ff7-9839-8129e65f3b6b` | 1             | requires_payment_method / ACK |
| `0d81ebf5-cb75-4820-96ef-190d14d22e7a` | 1 → 2         | RETRY → STALE_WORK / ACK      |
| `efe97325-5525-4c5d-8f80-f207d28647b3` | 1             | RECONCILED / ACK              |
| `abc6a763-a361-4fbc-86f8-fcc87a1c132b` | 1             | STALE_WORK / ACK              |
| `05e2b630-c9a8-45ce-a843-59ade1e648b6` | 1             | STALE_WORK / ACK              |
| `478e65be-118a-4522-8797-ec7b293c1983` | 1             | STALE_WORK / ACK              |

The initial RETRY for `0d81ebf5-cb75-4820-96ef-190d14d22e7a` occurred at 17:01:22.777 UTC. Its second receipt was ACKed as STALE_WORK at 17:04:21.638 UTC. No additional financial or inventory effect resulted from that retry, and no DLQ message remained.

### Operational and local cleanup

Normal authenticated admin closure returned HTTP 200 and left the C3C Drop CLOSED with inventory unchanged at 20 / 0 / 0 / 20. Reservation, reservation DLQ, recovery-infrastructure DLQ, payment, and payment DLQ each reached **0 visible / 0 invisible / 0 delayed**. All **32/32 alarms were OK**. QueueAge recovered naturally after normal delayed-message processing; no manual queue deletion or alarm manipulation was used. Admission was explicitly relocked through the approved helper and verified false.

Reviewed AWS logs had no sensitive-pattern matches. The temporary admin token file was deleted, the capability handoff file was absent, the localhost harness was stopped, and its process-local acceptance variables were removed. Task-local copies were unset; any variables retained in a separate human-owned terminal must be cleared there. No secrets, capabilities, card data, or raw provider payloads are included in this acceptance record.

### Accepted non-blocking limitation and disposition

The exact cause of one initial PaymentWorker RETRY remains unknown. The same MessageId's subsequent receipt and STALE_WORK / ACK are proven, with no duplicate financial effect or inventory release. Human review accepts this as a **non-blocking observability limitation**, not a proven business defect; the original cause is not claimed to have been identified.

C3C proves: ConfirmationToken → definitive provider decline → canonical requires_payment_method → no authorization/capture authority → durable failure/cancellation settlement → exact reservation release → customer-safe failed status → webhook/work idempotency → transport cleanup → alarm recovery. **C3C is PASSED.**
