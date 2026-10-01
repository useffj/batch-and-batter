# Phase 5B2C3D1 — customer abandonment / payment deadline readiness

Local review and regression testing only. No live abandonment attempt has been performed. C3A, C3B and C3C acceptance remains closed and unchanged. This review does not authorize payment enablement, a new Cart, Stripe objects, deployment, or cleanup of live messages.

## Current implementation

`PaymentRepository.start` atomically moves ACTIVE to PAYMENT_PENDING while preserving reserved ownership, creates the Order/Attempt, and replaces SHOPPING responsibility with PAYMENT and PAYMENT_WORKFLOW responsibility. The one-time payment deadline is payment start plus 240000 ms. Replay returns the original identity/deadline; customer inactivity, polling, continuation, and recovery do not renew it.

`FinancialWorkflow.reconcile` retrieves canonical provider state and validates the Intent association, amount, currency and configuration. An ordinary incomplete `requires_action` Intent becomes AUTHENTICATING / WAIT_FOR_CUSTOMER_ACTION. Before deadline, capability-authorized customer status is action_required; only the authorized no-store response may carry the ephemeral action secret. At deadline equality, action/continuation admission closes and no action secret is returned. Processing is not proof of release or payment.

PAYMENT deadline work validates its exact Cart, start time and immutable deadline. Workflow recovery also detects elapsed deadlines. Durable work remains the authority; the reconciler can redeliver work independently of browser activity. Missing or stale work is acknowledged without resurrecting an Attempt.

For a canonically verified `requires_action` Intent with zero received/capturable amount at deadline, cancellation is selected with terminal reason EXPIRED. A durable CANCEL command is PREPARED, then DISPATCHED before the provider call. Redelivery retrieves the provider state first. A cancellation response alone is not release authority: the workflow retrieves canonical state again. Verified canceled state with zero received and zero capturable permits CANCELED release evidence and failure settlement.

The normal abandonment terminal convention is **Cart EXPIRED / Order EXPIRED / PaymentAttempt EXPIRED**, with customer status **expired**. A cancellation already observed before the deadline can instead retain the existing CANCELLED reason. An already selected FAILED/CANCELLED reason is not rewritten by a later clock tick. These are existing conventions, not new terminal states.

## Ownership and financial boundaries

Expiry settlement subtracts only the Cart's embedded owned quantities from each current Inventory.reserved value and leaves total/sold unchanged. Inventory Puts guard total, reserved, sold and updatedAt; business-record guards and deterministic settlement markers prevent duplicate release. Inventory updates, terminal Cart/Attempt/Order and exact deadline/workflow deletion commit atomically. Contention rereads aggregate inventory with bounded retries; unrelated reservations and historical sold units remain intact. A PAID outbox is written only by paid settlement.

For the planned isolated fixture, 20 total / 5 reserved / 0 sold / 15 available becomes 20 / 0 / 0 / 20 only after provider safety is proven. No authorization, capture command, capture, SOLD, PAID or PAID outbox is expected while the provider remains uncompleted requires_action.

**Browser abandonment is not proof of financial failure.** If canonical state advances to requires_capture near deadline, the existing authorization/capture authority and committing window take precedence. A regression proves that this can settle PAID rather than release inventory. Canonical succeeded requires valid capture authority/full-capture evidence; conflicting or unknown outcomes retain responsibility. Retrieval failures, uncertain dispatched mutations and unexpected financial state must not produce speculative release. Recovery retains reserved inventory, reports processing, and uses existing durable backoff.

## Races and regression coverage

Six focused backend cases supplement existing settlement, replay, webhook, HTTP-security and transport tests:

- Incomplete action through deadline: unchanged deadline, cancellation proof before release, EXPIRED states, secret-free customer result, no capture/outbox, exactly one release, duplicate deadline/stale workflow ACK.
- Provider already canceled just before deadline observation: canonical proof settles expiry without another provider cancellation.
- Cancellation webhook settles while expiry work is outstanding: duplicate webhook and stale workflow cannot release twice.
- Unrelated reservation arrives during inventory settlement, with prior SOLD units: retry preserves both unrelated quantities.
- Provider retrieval becomes unknown at cancellation: no release evidence, no release, both durable responsibilities retained, safe processing result and no raw exception log.
- Provider advances to requires_capture at deadline: financial authority wins; ownership stays reserved until legitimate paid settlement.

Existing tests additionally cover immutable replay/grace, deadline equality, out-of-order webhook responsibility transfer, hard-stop unknown capture, lost provider responses, rollback at transaction actions, and safe transport ACK/RETRY categories. No new telemetry design is introduced. Existing delivery logs expose safe MessageId, receiveCount, Lambda request ID, work kind/revision, business identifiers and disposition; raw bodies and provider exceptions are excluded.

## Local harness and future human procedure

The harness has a one-entry continuation guard and one accepted-start identity. It calls handleNextAction once and awaits the human-controlled challenge. While that promise is outstanding it does **not** poll the backend continuously and cannot report terminal expiry automatically. Leaving the challenge incomplete does not extend the backend deadline. A new mock holds the challenge pending across the deadline and proves no second start/token, authentication call or continuation; returning after deadline produces HARNESS_PAYMENT_DEADLINE_ELAPSED (sent=yes).

Existing HARNESS_PAYMENT_TERMINAL_FAILURE covers an authoritative expired/failed/cancelled response. HARNESS_PAYMENT_DEADLINE_ELAPSED only reports elapsed time, not settled expiry. HARNESS_AUTHENTICATION_FAILED may occur if the challenge returns an error; it likewise does not prove financial release. No new diagnostic or runtime change is required.

For a separately authorized live attempt, stage the current harness before creating timed state; use one Cart, one human Pay click and no automatic retry. Once requires_action / AUTHENTICATING / WAIT_FOR_CUSTOMER_ACTION is proven, deliberately leave authentication incomplete. Observe backend/provider state read-only through deadline and canonical cancellation, then verify exact expiry settlement, customer-safe terminal projection, work cleanup, queues and alarms. Preserve authorized capability access securely for the final customer GET; never expose it in evidence. Do not infer release from the browser, close/reload/retry to drive recovery, or manually cancel provider state. Relock admission explicitly on completion or stop. Any financial advancement or unknown state requires the existing financial-safety procedure and human review rather than a forced expiry.

## Security and scope

No runtime, infrastructure or dependency changes are made. New tests use synthetic fixtures only. Existing logs are allowlisted; canonical provider snapshots are reduced rather than raw payloads logged. The existing command ledger intentionally persists the accepted ConfirmationToken identifier and command idempotency identity for recovery; this review does not claim those fields are absent from authorized durable records. Cart capability is represented by its hash in storage. Customer business records retain their approved contact fields, not in diagnostic logs. Action secrets are transient through the authorized no-store path and excluded after terminal state. No new secret, card, capability or customer-data persistence is introduced.

## Validation

On 2026-10-01: 844 backend functional tests (six new abandonment cases), 7 backend artifact tests, 51 harness tests (one new incomplete-challenge case), 2 production-exclusion tests, 7 frontend tests, and 34 infrastructure tests passed. Backend/frontend/infrastructure typechecks and builds passed, as did frontend lint and repository formatting.

Backend audit: zero vulnerabilities. Frontend audit: one moderate and one high affected package (Next.js/PostCSS). Infrastructure audit: one high affected package (bundled brace-expansion). Every reported advisory URL matches the existing temporary development exceptions in [DEPENDENCY_RISKS.md](DEPENDENCY_RISKS.md); these are not clean frontend/infrastructure audits and remain pre-production follow-ups.

CDK synth passed, followed sequentially by a read-only diff with lookups disabled and no change set, using separate output directories and explicit authenticated DEV account / us-east-2. The diff reported no differences: no code-asset, IAM, queue, route, table, secret, admission, replacement or deletion changes. The read-only live Lambda environment check returned PAYMENT_START_ENABLED=false.

The local readiness gate passes under the documented dependency exceptions. One controlled live abandonment attempt is technically ready for separate human authorization and fresh safety checks. No live abandonment acceptance is claimed. No commit, push, deployment, AWS/Stripe mutation, payment object or payment enablement occurred.

## Final C3D live abandonment acceptance — human approved

**PHASE 5B2C3D CUSTOMER-ABANDONMENT / PAYMENT-DEADLINE ACCEPTANCE: PASSED**, with the non-blocking transport limitations below. This separately authorized DEV sandbox acceptance occurred on 2026-10-01 after the local readiness review above. It does not authorize another payment, deployment, or payment enablement. Final live admission was verified `PAYMENT_START_ENABLED=false`.

The earlier readiness results and historical C3A/C3B/C3C records remain unchanged. C3D initially stopped before timed state because local prerequisites were absent. Subsequent operational cleanup stopped on expired admin authentication, then on a stale payment DLQ item, and then on a failed targeted-delete command. Those stops are preserved below; business success was accepted before operational cleanup was complete. The final successful acceptance is recorded separately here.

### Final business evidence

| Record         | Identifier                    | Final state |
| -------------- | ----------------------------- | ----------- |
| Drop           | `01M3W947MRNBW80JHXXDRX71BZ`  | CLOSED      |
| Cart           | `01M3W9CXTJ128HZGDNA0X5ECYK`  | EXPIRED     |
| Order          | `01M3W9JFJ4ACMHZAXF6RFM2G5S`  | EXPIRED     |
| PaymentAttempt | `01M3W9JFJ4XVSKZ7RY4E1MK17J`  | EXPIRED     |
| PaymentIntent  | `pi_3ULoAMDz3QSwRsAl14YNU4hF` | canceled    |

Exactly one payment/start was accepted with HTTP 201, one PaymentIntent was associated with the payment, and one initial server confirmation (generation 0) was observed. Canonical Stripe state was requires_action, the Attempt was AUTHENTICATING, and workflow was WAIT_FOR_CUSTOMER_ACTION. The sandbox Intent had livemode=false, confirmation_method=automatic, capture_method=manual, amount_received=0 and amount_capturable=0.

The human intentionally left the visible 3DS challenge incomplete. No manual /payment/confirm continuation or second server confirmation occurred. The paymentDeadline remained immutable. Admission was explicitly relocked through the approved helper after the requires_action checkpoint, without interfering with existing recovery. The harness waited with the challenge open; no browser interaction was manufactured to obtain a terminal display.

### Canonical reconciliation and expiry ordering

All times below are UTC on 2026-10-01.

| Evidence                                 | Time         |
| ---------------------------------------- | ------------ |
| Immutable paymentDeadline                | 17:57:07.652 |
| Canonical requires_action reconciliation | 17:57:09.043 |
| Durable cancellation PREPARED            | 17:57:09.044 |
| Durable cancellation DISPATCHED          | 17:57:09.605 |
| Canonical canceled proof                 | 17:57:10.902 |
| Atomic expiry settlement                 | 17:57:11.363 |

Canonical provider cancellation/no-capture safety was proven before inventory release. The final Intent was canceled with amount_received=0 and amount_capturable=0. No evidence existed for AUTHORIZED, requires_capture, capture authority, a capture command, capture, SOLD movement, PAID settlement, or a PAID outbox. No manual financial intervention occurred; cancellation was performed by the existing durable worker path.

Inventory moved from **20 total / 5 reserved / 0 sold / 15 available** to **20 total / 0 reserved / 0 sold / 20 available**. The Cart's five-unit reservation was released exactly once, with no duplicate release, SOLD movement, or manual inventory repair.

Capability-authorized customer GET returned action_required before deadline and expired after safe terminal settlement. The terminal GET returned HTTP 200 with Cache-Control: no-store and no client secret. This was independently checked without completing or dismissing the challenge.

### Webhook and transport evidence

Stripe webhook receipts reached PROCESSED, including:

- payment_intent.created: `evt_3ULoAMDz3QSwRsAl1eCQAgAd`.
- payment_intent.canceled: `evt_3ULoAMDz3QSwRsAl1EvM1QTb`.

WORKFLOW revision-4 MessageId `2acdac1f-eb6d-4744-b6e1-fce8e769b176` returned RETRY on receive count 1 at 17:53:16.870 UTC, then STALE_WORK / ACK on receive count 2 at 17:56:15.696 UTC. Its initial RETRY cause remains unknown. No duplicate financial or inventory effect resulted.

A distinct stale DLQ message, `58f74480-32f5-42b0-a311-a0873593ddd2`, was conclusively identified as WORKFLOW / PAYMENT_WORKFLOW revision 18 for the same C3D Cart, authoritative Attempt `01M3W9JFJ4XVSKZ7RY4E1MK17J`, and Order. Its referenced durable work was absent/superseded; the terminal Attempt was revision 23. No matching PaymentWorker telemetry was returned for this exact MessageId, so no source-delivery sequence or failure cause is claimed. Identity was established from parsed message ownership and persisted records, not inferred from timing or the unrelated revision-4 RETRY.

The first authorized diagnostic receive reported count 6. Terminal ownership, canonical canceled state, zero received/capturable amounts, fully released inventory and absent financial responsibility satisfied the conditional-delete gate, but the first targeted-delete command failed. Its exact error was not recovered; the receipt handle was not persisted. A separately authorized fresh receive reported final diagnostic count 7 and matched the exact approved MessageId. The same ownership and safety gates were rechecked, and **one targeted delete succeeded** using the fresh in-memory receipt handle. No source-queue receive, purge, redrive, broad deletion, visibility-change command, IAM change or queue configuration change occurred.

Two cancellation DISPATCHED log entries were observed. They do not establish two distinct durable commands or duplicate financial effects; no independent exact provider cancellation-request count is claimed.

### Operational, local and security cleanup

Normal admin Drop closure initially returned 401 and stopped until valid authentication was available. The eventual authenticated closure returned HTTP 200, and the Drop was verified CLOSED with inventory unchanged at 20 / 0 / 0 / 20.

After targeted stale-transport cleanup and normal CloudWatch evaluation, the source payment queue, payment DLQ, reservation queue, reservation DLQ and recovery-infrastructure DLQ each reached **0 visible / 0 invisible / 0 delayed**. QueueAge and the payment DLQ alarm were OK; **32/32 alarms were OK**. No alarm thresholds or configuration were changed. No unresolved PAYMENT, PAYMENT_WORKFLOW, relevant STRIPE_EVENT or financial responsibility remained. Final admission was verified **PAYMENT_START_ENABLED=false**.

The admin token file was deleted, the capability temp file was absent, the localhost harness was stopped (no listener remained on port 4242), and task-held acceptance variables/capability references were cleared. Variables exported in a separate human terminal cannot be cleared by the task process and should be unset manually if still present. Reviewed logs showed no sensitive-pattern matches; this is a bounded review rather than an exhaustive security proof. No secret values, raw message bodies, receipt handles, card data or customer contact values are included in this record.

### Accepted non-blocking limitations and disposition

Human review accepts these historical limitations:

1. The original cause of the revision-4 PaymentWorker RETRY remains unknown; the same MessageId was later safely ACKed as STALE_WORK.
2. The original source-delivery failure cause of stale DLQ MessageId `58f74480-32f5-42b0-a311-a0873593ddd2` remains unknown.
3. The exact error from the earlier failed targeted-delete command was not recovered.

None left unresolved financial or inventory responsibility. Business acceptance and final operational acceptance are **PASSED**.

C3D proves: payment/start → requires_action → customer abandonment → immutable deadline → canonical reconciliation → durable provider cancellation → canonical canceled proof → atomic expiry settlement → exact reservation release → queue/DLQ cleanup → alarm recovery. **C3D is PASSED.**
