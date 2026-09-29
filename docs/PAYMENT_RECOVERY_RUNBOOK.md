# Dev payment recovery runbook

Phase 5B2C1 is local infrastructure wiring only. NO LIVE PAYMENT FLOW IS ENABLED.
Do not deploy or perform recovery mutations without the separate rollout authorization.

## First response

Disable NEW admission through the reviewed rollout process if necessary; do not disable
workers, webhooks, deadline processing, or reconciliation for accepted payments.
An environment update is not an instantaneous barrier: account for in-flight requests.

Use safe Cart, Order, PaymentAttempt, and PaymentIntent identifiers in access-controlled
operator evidence. Never copy capability tokens, Idempotency-Key values, ConfirmationTokens,
client secrets, webhook signatures, full provider payloads, or customer PII into tickets/logs.

Read Cart/Order/Attempt and their settlement identities, immutable command ledger,
committing deadline, capture/release evidence, recovery reason, next check, and revision.
Read exact Operations work items and Stripe event receipts. Check payment queue visible,
in-flight, delayed and DLQ counts; worker failures/throttles; reconciler cursor progress;
financial metrics and monitoring coverage heartbeat. No runtime Scan is granted.

Using the separately approved READ-ONLY sandbox operator process, retrieve the canonical
PaymentIntent. Verify account/environment (livemode=false), association, metadata, amount,
USD currency, manual capture/confirmation, and received/capturable amounts. A webhook
snapshot or timeout is not proof of capture or cancellation.

## UNKNOWN FINANCIAL OUTCOME

PAYMENT_COMMITTING retains RESERVED inventory. Read DISPATCHED command authority before
interpreting provider state. No response does not mean the command failed. Never issue
another capture. Check provider/SSM/KMS access and worker/reconciler health. Dependency repair
requires its own operational authorization; after repair allow durable recovery to retrieve
canonical state and make the established decision. Recovery backoff is 60/120/300/900 seconds.
The normal technical deadline does not authorize an inventory release.

## CAPTURED BUT NOT FINALIZED

Verified capture with incomplete local settlement remains customer `processing`.
Inventory stays owned until the atomic RESERVED-to-SOLD, Cart CONVERTED, Order PAID,
Attempt CAPTURED transaction commits. Inspect contention/invariant failures and settlement
identity. Restore dependencies through approved operations and let recovery finalize once.
Never compensate by returning inventory merely because local finalization is delayed.

## Prohibited actions

- No manual DynamoDB edits or manual Inventory release.
- No manual capture retry or replacement Intent.
- No deletion of durable work, receipts, command history, or queue messages to “unstick” payment.
- No rollback to Phase 5A2 after any payment admission.
- No manual SOLD reset after a paid test; refund/restock remains deferred.

Escalate immediately for invariant conflict, partial capture, wrong association/account,
unexpected live-mode evidence, or failure to progress after dependencies are restored.
Retain financial responsibility and compatible readers while engineering investigates.

## Alarm readiness

`batch-and-batter-dev-payment-alerts` has no subscription in 5B2C1.
PAYMENT ENABLEMENT IS BLOCKED UNTIL A REAL EMAIL SUBSCRIPTION IS CONFIRMED.
5B2C2 must name an operator, confirm the subscription and test actual alarm delivery.
Email contains only metric/resource details and runbook references. Business IDs belong in
restricted logs, not metric dimensions or notification configuration.

A failed/missing recovery heartbeat also means bounded monitoring coverage may be incomplete;
do not interpret missing age gauges as evidence that there are no outstanding obligations.
