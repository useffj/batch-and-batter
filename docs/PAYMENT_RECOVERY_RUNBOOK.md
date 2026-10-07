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
USD currency, manual capture/automatic confirmation (C3A2 corrected contract), and received/capturable amounts. A webhook
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

## Recovery infrastructure separation (Phase 5B2C2A; pending deployment)

PAYMENT_START_ENABLED remains false. This local change does not authorize deployment
or payment admission. C2's confirmed subscription and successful human-confirmed
synthetic email delivery are historical acceptance evidence; the C1 readiness notes
above describe the earlier checkpoint.

After the separately approved deployment:

- `batch-and-batter-dev-reservation-dlq` receives business messages whose processing
  on `batch-and-batter-dev-reservation` exhausted retries. Its existing alarm stays
  unchanged. Triage the SHOPPING work identity, Cart ownership, inventory and durable
  work before proposing recovery. A dead letter does not authorize inventory release.
- `batch-and-batter-dev-recovery-infrastructure-dlq` receives expiry reconciler Lambda
  asynchronous OnFailure records and expiry recovery Scheduler delivery failures only.
  It has no consumer or redrive policy. Inspect envelope type, failure condition,
  timestamps, exact request ID and corresponding successful/failed invocation logs.
  These infrastructure envelopes are not reservation work and must not be blindly
  replayed into the reservation queue. Check durable-work progress independently.
- Payment-worker business dead letters remain on the separate payment DLQ and retain
  the financial recovery rules above.

Neither queue may be automatically purged. Envelope-specific investigation and separate
human authorization are required for targeted cleanup. The old reservation DLQ can
still contain legacy infrastructure records: changing destinations does not move them.
In particular, message `071e449a-f9bc-428f-9e99-fe5344117cbc` remains untouched pending
separately authorized cleanup/deployment.

The new `batch-and-batter-dev-payment-RecoveryInfrastructureDlqNonEmpty` alarm triggers
on one visible message (Maximum, one minute, one datapoint) and uses the existing
payment-alerts SNS topic. Its physical name matches the existing account-scoped
`batch-and-batter-dev-payment-*` SourceArn condition; no topic-policy expansion is needed.

### Unresolved EventAgeExceeded follow-up

Three known recurring reconciler OnFailure records carried `EventAgeExceeded` with
`approximateInvokeCount=0`. Each exact request ID correlated with an earlier successful
invocation. Duplicate asynchronous delivery is a hypothesis only: root cause remains
unresolved and requires pre-production investigation. Queue separation corrects the
operational/observability boundary; it does not fix EventAgeExceeded. Preserve sanitized
request-ID/timestamp evidence and investigate delivery/deployment timing without assuming
that an infrastructure envelope represents unfinished business work.

### C3A2A historical reads and rollout gate

Historical records preserve their original confirmationMethod. Structurally valid manual and automatic records remain readable; only automatic confirmation with manual capture is executable. No migration or normalization occurs. Terminal legacy EXPIRED, FAILED, CANCELLED, and CAPTURED history remains customer-readable without provider access or new work. Unresolved legacy GET returns non-actionable processing without a client secret.

LEGACY_PAYMENT_CONTRACT blocks unresolved legacy workflow execution and customer continuation before provider dispatch or inventory mutation. Queue processing records this fixed classification and reports the message as failed, preserving durable work for operator review and existing retry/DLQ handling. This is escalation, not automated recovery or inventory release. Terminal work is inert. For a terminal legacy webhook, consistent local settlement and linkage are required before acknowledging the inbox; only the receipt/work acknowledgment changes, with no Stripe retrieval or financial resurrection.

Before any separately authorized deployment, prove zero unresolved legacy PAYMENT_PENDING/PAYMENT_COMMITTING responsibility, zero unresolved PAYMENT/PAYMENT_WORKFLOW work, zero unresolved Stripe-event responsibility, and no old-contract Attempt requiring continuation. Historical terminal manual-confirmation records may remain. PAYMENT_START_ENABLED must stay false during rollout.

## C3A5 single-capture rejection and controlled recovery (local, not deployed)

Confirmed sandbox evidence: the original capture at 2026-09-30T15:52:07Z returned HTTP 400, invalid_request_error, request ID req_4Gi6DNTC69VCiw. The message identified unsupported final_capture; no structured code or parameter was shown. Six further requests replayed that same rejection. Canonical Stripe state remained requires_capture, 2625 capturable, zero received. No successful capture or SOLD movement occurred.

Ordinary Batch & Batter capture now sends only the exact amount_to_capture. It omits final_capture entirely: that option belongs to multicapture-capable flows, which this application does not use. Existing local finalCapture=true fields remain readable as full-settlement intent, not a wire parameter. See [Stripe capture API](https://docs.stripe.com/api/payment_intents/capture).

Only HTTP 400 plus invalid_request_error is classified PROVIDER_REQUEST_REJECTED. The adapter retains bounded HTTP status, request ID, allowlisted error type/code/parameter, Stripe-Should-Retry, and provider-response versus network/SDK boundary. Unsupported diagnostic strings are omitted. Raw messages, bodies, headers, secrets and idempotency values are not copied. Network/SDK exceptions and 5xx remain PROVIDER_UNKNOWN. A deterministic capture rejection marks the command PROVIDER_REJECTED and retains READ_ONLY recovery, RESERVED ownership, and customer processing; it never automatically resubmits that command.

Existing commands without a generation remain generation 1 with their original identity. New commands record SINGLE_CAPTURE request shape. Old capture commands without that marker are blocked from dispatch, preventing changed parameters from reusing an already-submitted identity. No migration occurs.

The local-only classifyRejectedCapture operator method can attach independently reviewed HTTP 400 evidence to a generation-1 DISPATCHED record after canonical no-capture and ownership proof. It preserves original preparation/dispatch timestamps. The separately approved prepareReplacementCapture method atomically archives the complete rejected command and creates generation 2 PREPARED with a distinct deterministic identity. The original history is immutable. No HTTP route, CLI execution tool, webhook, worker, or reconciler invokes either operator method automatically. This phase does not authorize their live use.

Both operator steps require explicit approval, exact Intent/configuration/metadata/reverse association, requires_capture, expected capturable amount, zero received, PAYMENT_COMMITTING Cart, CAPTURE_IN_PROGRESS Attempt, PAYMENT_PENDING Order, and no settlement/cancel/release/capture evidence. C3A5A uses the existing ownership representation: PAYMENT_COMMITTING retains the Cart's embedded reservations, and load validates their exact Drop/product/quantity and price against the pending Order and associated Attempt. Aggregate inventory is not ownership proof. Each inventory row must match its Drop/product, have valid nonnegative counters with reserved + sold <= total, and have reserved >= this Cart's quantity. Other Carts' reservations and earlier SOLD stock are allowed. Cart/Order guards compare the embedded lines and Drop; Cart/Order/Attempt guards require no settlement marker. A preparation inventory race can be retried from a fresh read without changing the rejected command. After capture, settlement rereads inventory on each bounded contention retry, subtracts only this Cart's quantity from RESERVED and adds it to SOLD. Exhausted contention reschedules FINALIZE_ORDER; it does not issue another capture. No duplicate ownership records are introduced. Inventory and Order conditions join the Cart/Attempt/work compare-and-swap transaction so competing recovery or ownership changes cannot create another generation.

Generation 2 has its own bounded two-minute dispatch window; original Cart/payment/committing timestamps are never extended. DISPATCHED is persisted before provider mutation. Canonical association, zero-received authorization and inventory are rechecked before dispatch. Retries reuse the generation-2 identity. Window expiry returns to read-only recovery without cancellation or release. Canonical succeeded/full amount is required before the existing atomic RESERVED-to-SOLD, Cart CONVERTED, Order PAID, Attempt CAPTURED and single PAID outbox settlement. This implementation supports at most generation 2; any generation 3 requires another reviewed change.

### Proposed later recovery, not authorized here

Keep admission false. First deploy only after separate review and a responsibility-aware rollout approval. Reconfirm the same Stripe request evidence and canonical authorization, inspect the current durable command and inventory, then explicitly classify the rejected original command. Re-read the committed classification; separately authorize and atomically prepare generation 2 through the local operator boundary. Observe its ordinary durable dispatch and canonical settlement. Do not reuse generation 1, manually capture/cancel, alter inventory, or enable customer payment admission. If any predicate fails, retain responsibility and stop.

## C3B2D payment transport telemetry (local implementation; not deployed)

The 2026-09-30 C3B attempt reached requires_action / AUTHENTICATING /
WAIT_FOR_CUSTOMER_ACTION, but a stale localhost relay prevented customer status
polling. It did not complete C3B acceptance. Deadline recovery safely ended with
Cart, Order and Attempt EXPIRED, Stripe canceled with zero received, inventory
20 total / 0 reserved / 0 sold / 20 available, and no durable financial
responsibility. There was one initial confirmation and no capture command.

A separately authorized single payment-DLQ receive with visibility zero identified:

- MessageId: `43beb7e7-934b-4b39-8978-a94f2a1d1a7c`.
- Cart: `01M3SXJXZAKW7H5ZYH744BC04P`.
- Attempt: `01M3SXVZFPYFDX112ERHP468CF`.
- Order: `01M3SXVZFP5CG8A3R3Q98N4DNA`.
- WORKFLOW / PAYMENT_WORKFLOW, revision 18; exact durable work absent.
- Sent at 19:53:35.408 UTC; first received at 19:53:50.409 UTC.
- Returned ApproximateReceiveCount 6, including the diagnostic receive and
  receipts across queues; source maxReceiveCount 5.

Automatic redrive is supported by source metadata and receive-count evidence.
The exact application failure sequence remains **UNKNOWN**. Attempt-level RETRY
logs cannot safely be attributed to this MessageId. Successful STALE_WORK
invocations had zero batch failures; no business-logic or queue-policy change was
justified. The message was left visible in the DLQ. This telemetry patch does not
resolve the historical cause or authorize deletion, redrive, deployment, payment
enablement, or another C3B attempt. PAYMENT_START_ENABLED remains false.

The local patch emits one `paymentTransportDelivery` and one
`paymentTransportDisposition` JSON record per SQS record. Fields are messageId,
receiveCount, lambdaRequestId, queueArn, workType, revision, cartId and attemptId;
the final record adds outcome and ACK/RETRY. Valid SQS MessageIds are retained
exactly, never hashed. Missing or invalid metadata is null. Only positive safe
integer receive counts are accepted. Cart/Attempt identifiers are extracted from
validated work envelopes and strict ULID positions; absent identities are not
inferred from timing. STRIPE_EVENT bodies do not contain these IDs, so those
fields remain null. Raw storage keys and Stripe event IDs are not logged.

All successfully returned processing outcomes retain ACK, including STALE_WORK,
COMPLETED, SETTLED, NOT_DUE and recovery/rescheduling outcomes. Unknown returned
labels are reported as RETURNED without changing ACK. A processing exception
retains its MessageId in batchItemFailures and logs RETRY; the existing
LEGACY_PAYMENT_CONTRACT category remains allowlisted. Initialization failures also
produce per-record RETRY telemetry. No exception message or object is serialized.

Transport logs and the worker's existing financial-event/metric emissions are
best-effort: a throwing sink must not turn ACK into RETRY, suppress a required
RETRY, or repeat processing. If the sink fails, records may be absent; telemetry
cannot guarantee delivery or prove SQS deletion. Correlate the final disposition
with Lambda REPORT and queue evidence. MessageId and receiveCount make delivered
application invocations traceable, but failures before invocation still require
service-level evidence.

Never log ReceiptHandle, raw Body, arbitrary attributes, capabilities, client
secrets, ConfirmationTokens, command/idempotency identities, keys, customer
contact fields, card data, or provider exception payloads. No workflow, retry,
visibility, redrive, concurrency, batch-size, IAM, admission, capture or
reconciliation configuration changes are part of this phase.

## DEV account identity and ledger namespace correction (local, not deployed)

Human approval on 2026-10-07 designates `acct_1UL8LdDz3QSwRsAl` as the actual
DEV Stripe sandbox. Historical payment acceptances used that sandbox, although
the prior configuration/approval named `acct_1UL8xeDXKfaUH9bm`. The deployed read
and worker keys, hosted publishable key, and webhook signing secret were verified
against the actual sandbox without exposing credentials. This correction does
not rotate or replace them, migrate data, or authorize a payment/deployment.

Reviewed nonsecret DEV configuration lives in `infra/config/dev-payment.json`:

- `Environment=dev` is validated locally and pinned in CDK context.

- `StripeSandboxAccountId=acct_1UL8LdDz3QSwRsAl` is the actual Stripe account.
- `DevPaymentLedgerNamespace=dev:acct_1UL8xeDXKfaUH9bm` preserves existing ledger
  identities and compatible subsequent DEV operations.
- `DevPaymentLedgerAccountId=acct_1UL8LdDz3QSwRsAl` explicitly binds that namespace
  to the actual account. It must match `StripeSandboxAccountId`.

The deploy helper supplies these three parameters explicitly and still defaults
`PaymentStartEnabled=false`. This is a future deployment change, not a deployed
state claim. The two new parameters default empty in generic synthesis so an
unconfigured deployment fails closed. Runtime requires DEV, a valid actual
account, a valid DEV namespace, and a matching account binding. The namespace is
not an account alias or alternate webhook authorization. Webhook validation uses
the actual account; direct-account events without an account field continue to
rely on the independently verified endpoint signing secret and test-mode checks.

Scope consumers: API admission execution, ConfirmationToken ownership guard,
Intent associations, workflow/recovery authority, capture evidence, settlement
identity, customer recovery, and webhook receipt/inbox deduplication all retain
the configured namespace. Reconciliation routes existing work keys without
reinterpreting the account. Cart/request idempotency scopes are unchanged.
No runtime derives account authorization from historical record namespaces.

Before a separately authorized deployment, review the configuration and shared
backend artifact diff. Expect API, payment worker and webhook environment updates,
two new CloudFormation parameters, and shared Lambda code asset updates. No IAM,
queue, table, secret, Stripe, Amplify, frontend or payment-admission change is
intended. Recheck disabled admission, empty unresolved responsibility, alarms,
queues and recovery heartbeats. After deployment repeat read-only identity,
historical lookup and operations checks. No payment is part of this validation.

Keep the namespace immutable. Do not repair account mismatches by changing stored
records or by broadening accepted webhook accounts. Rollback must preserve both
the namespace and existing-payment recovery; do not roll back to code that derives
the ledger namespace solely from the corrected actual account. Keep admission
false and use a reviewed compatible rollback or forward fix.

### Available artifacts and matching configurations (2026-10-07 read-only inspection)

All five deployed functions (`batch-and-batter-dev-api`, `payment-worker`,
`stripe-webhook`, `expiry-worker`, and `expiry-reconciler`, with the same prefix)
returned the same downloaded deployment ZIP SHA-256:
`5233e95cda7dabd026ce8a517fe718e37e2cf28bae463642038eaf59787c88d1`.
Each is `$LATEST`; no published Lambda versions were returned. The API, financial
worker and webhook bundles do not contain explicit ledger-namespace support.
Their matching current identity is `STRIPE_ACCOUNT_ID=acct_1UL8xeDXKfaUH9bm`,
with neither new ledger variable configured. API admission was read as false.
Expiry worker/reconciler need no Stripe identity configuration and remain running.

This is a verified currently downloadable legacy artifact, not a retained rollback
version or a new approved deployment. Its old account-derived namespace matches
historical records, but its account configuration retains the known identity
mismatch. Do not pair it with the corrected actual account value. No previously
deployed explicit-ledger-compatible artifact was identified in the five functions,
their published versions, or repository history. Job 9 is a frontend artifact and
is not a backend recovery artifact.

The new artifact is only the uncommitted local build, not a published Lambda
version or deployed release. The reviewed local runtime file SHA-256 values are:

| File                         | SHA-256                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| handler.js                   | d062c3c2e24adfa1356fc2e7c94e47f005f6486d4e10493cd0546e374255aefd |
| payment-worker-handler.js    | e257693fb07e6a4603184abf8e0361f25d0e5ca212c7629e941a585b7f036f96 |
| stripe-webhook-handler.js    | a0e23fd14e397a9cae8dc94838c6490f7e940257e31271d2058d969c03aeb77a |
| expiry-worker-handler.js     | e700b43cae1d32e5540944cc09e7faad69b12f34cfc4a2db42fdae4efc43f5d2 |
| expiry-reconciler-handler.js | 8786be670eb3f6992488d07ef665998b0fd9621a5ab7265928c5de0157fc286f |

These identify individual local files, not a deployment ZIP. Rebuild and verify
fingerprints after any further code changes. Its final matching parameters are
the reviewed JSON values above plus `PaymentStartEnabled=false`.

### Recovery-preserving rollout proposal; separate approval required

Do not run the normal deployment helper as the initial transition: it selects the
final corrected account. Lambda code/config updates across functions are not an
atomic fleet switch. Old code paired temporarily with the corrected account would
derive a different namespace; new code without its ledger settings fails closed.
The following staged transition needs separately reviewed templates/artifacts and
explicit human authorization, including the temporary legacy binding in stage 1.
No staging artifacts or change sets have been created during this local task.

1. Resolve the dependency audit gate. Require disabled admission, no unresolved
   commerce responsibility, healthy queues/alarms/heartbeats, and supervision.
   Before mutation, retain and checksum the currently available legacy ZIP and
   full deployed template/parameters, plus an immutable reviewed new build. Do not
   assume `$LATEST` or an expiring download URL remains a rollback archive.
2. **Configuration preparation, legacy code unchanged:** use a reviewed template
   that preserves the verified legacy code asset for every function. Add ledger
   namespace `dev:acct_1UL8xeDXKfaUH9bm` and ledger account binding
   `acct_1UL8xeDXKfaUH9bm` to API/worker/webhook; leave the existing account value
   `acct_1UL8xeDXKfaUH9bm` and admission false. Old code ignores the new fields.
   This temporarily preserves the existing mislabelled configuration, not a new
   approval of that ID as the actual Stripe sandbox. Verify the full configuration
   on all three functions before proceeding. Reject any code/IAM/resource drift.
3. **Compatible code introduction, parameters unchanged:** deploy the reviewed
   explicit-ledger code while retaining the stage-1 parameter set. Both old and new
   instances use exactly the historical namespace during this transition. Keep
   expiry worker/reconciler, queue mappings and webhook ingress enabled. Verify
   all five artifacts, historical reads, receipt/settlement compatibility, and
   recovery health before changing account identity. Do not admit a payment.
4. **Correct identity, compatible code unchanged:** now change both
   `StripeSandboxAccountId` and `DevPaymentLedgerAccountId` together to
   `acct_1UL8LdDz3QSwRsAl` on each identity-bearing function. Preserve the namespace
   and admission false. This is the final JSON/helper configuration. Review the
   configuration-only diff; verify all three identities/bindings, all five code
   fingerprints, historical lookup, keys/webhook association, queues, alarms,
   heartbeats and unresolved responsibility. Stop for review without payment.

Before stage 4, reverting code to the retained legacy artifact is only compatible
with the complete legacy account parameter set; it preserves the old mismatch and
is an emergency return to the pre-correction state, not successful correction.
After stage 4 begins, prefer roll-forward with the explicit-ledger-compatible build
and final configuration. Do not independently revert readers, worker, or webhook.
If returning to the legacy artifact is unavoidable, a separately reviewed reverse
transition must first restore the complete stage-1 identity/binding set on the
compatible code fleet, verify its health, and only then restore the retained legacy
code. Never remove the ledger configuration while new code is still running.

At every stop, leave admission false and retain durable work, queues, consumers,
webhook verification, deadlines, and reconciliation. Diagnose/roll forward through
compatible artifacts; never delete records/work, reset inventory, rotate keys, or
disable recovery to make rollout checks pass. A failed checkpoint prevents the
next stage. The normal helper is for the final configuration, not the bridge.

### Local HTTP and deployment preflight behavior

Payment runtime construction occurs inside the normal payment HTTP error boundary.
Missing/malformed/mismatched identity configuration returns HTTP 503,
`PAYMENT_UNAVAILABLE`, a generic message and `Cache-Control: no-store`. Logs retain
operation/status/code only; no configuration or secret details are emitted.
Failed service construction is not cached and does not initialize provider clients.

Before invoking CDK, the helper requires the exact four JSON keys, string values,
DEV environment/namespace, valid account format, and matching account binding. It
pins `environment=dev`, preserves unspecified previous stack parameters, accepts
only zero arguments or one literal admission flag, and defaults to false. No
configuration file value can override payment admission.

The single registry/package availability check in this task found latest official
`aws-cdk-lib@2.272.0` still bundles `brace-expansion@5.0.9`. Dependencies remain
unchanged. The existing three-advisory audit blocker is not waived; an official
bundle with at least 5.0.12 and validated compatibility is still required.
