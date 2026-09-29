# Phase 5B2B — capture, settlement and financial recovery

**NO LIVE PAYMENT FLOW IS ENABLED.**

**NO 5B2B INFRASTRUCTURE IS DEPLOYED.**

Do not deploy this phase independently. Repository main before this branch was
`dee396f4495a23c72e85ff7de7b2afaeed5565ef` (merged 5B2A). Per the approved checkpoint,
AWS dev remains on Phase 5A2. This implementation neither contacts Stripe nor
provisions secrets. All adapter execution in validation uses controlled transport.

## Local boundary

`FinancialWorkflow` extends the existing local `PaymentWorkflow`. The financial
worker must explicitly receive this coordinator and the Catalog table dependency.
The older coordinator remains a foundation-only boundary for 5B2A regression tests;
its PHASE_5B2B_REQUIRED outcomes are not a financial settlement implementation.
No deployed factory, handler, route, environment configuration or CDK construct
initializes the financial coordinator. The existing payment worker factory now
recognizes PAYMENT messages in addition to WORKFLOW and STRIPE_EVENT.

The provider's former PHASE_DISABLED capture/cancel methods now implement official
SDK calls, still requiring explicit dependency injection. No environment or SSM
provider initialization was added. SDK automatic network retries remain disabled.

## Authorization and financial authority

The financial coordinator treats supplied snapshots, including webhook snapshots
and confirmation responses, only as wake-ups. It retrieves the bound Intent and
checks the unique reverse association, configured scope, sandbox mode, all five
metadata IDs/environment values, frozen amount/currency and manual capture/manual
confirmation. The Stripe projection rejects any payment-method family other than
its initial card-only configuration. The owning account is established by the
configured restricted key/scope; the Intent object does not independently attest
the account. Effective grants/account verification remains a 5B2C gate.

AUTHORIZED requires requires_capture, exact amount_capturable and zero received.
Processing preserves ownership. Canceled requires zero received before release.
Succeeded requires full verified capture evidence. Wrong association/configuration
or partial financial amounts enters recovery, without selling or releasing.
Succeeded without a previously DISPATCHED capture command is an invariant incident,
not authority to fabricate a capture ledger or complete a normal Order.

## Command history

Existing CREATE and up to eight CONFIRM generations remain embedded in Attempt
execution. Their existing createdAt is preparation authority; new commands also
record preparedAt. CAPTURE and CANCEL add immutable bound Intent, amount, currency,
finalCapture=true, preparedAt, retryUntil, command ID and state, with dispatch and
observation timestamps and sanitized outcome when known.

- CREATE: payment-create:<attemptId>
- CONFIRM: payment-confirm:<attemptId>:<generation>
- CAPTURE: payment-capture:<attemptId>
- CANCEL: payment-cancel:<attemptId>

There is one capture and one cancellation identity, never another generation.
The immutable 23-hour cutoff is a local safety cutoff, not a guarantee about exact
Stripe retention. Financial deadlines can prohibit dispatch much earlier. After
safe dispatch authority ends, retrieve/reconcile/escalate; never reuse a key blindly.
DISPATCHED means the request **may** have reached Stripe, not that it succeeded.
Neither a dead process nor an expired lease establishes absence of external effects.
History remains bounded; tests exercise the maximum eight-confirmation representation.

## Capture claim and timestamps

Different-key capture claim action order:

0. Commerce Cart Put, PAYMENT_PENDING -> PAYMENT_COMMITTING (or preserve existing
   committing timestamps for an already-admitted deadline-driven Attempt).
1. Commerce Attempt Put, AUTHORIZED -> CAPTURE_IN_PROGRESS, PREPARED capture command.
2. Commerce pending Order ConditionCheck.
3. Operations PAYMENT work Delete, exact identity or compatible absence.
4. Exact current workflow Delete.
5. Successor CAPTURE workflow Put conditioned on absence.

Same-key work uses one guarded Put instead of Delete+Put: five actions instead of
six. No Inventory movement or provider call occurs in this transaction.

Cart conditions include exact updatedAt/status, Attempt/Order IDs and paymentDeadline.
Attempt conditions include exact updatedAt/status and the complete prior execution
map (therefore revision, stage, Intent, command history and work pointer).
Order conditions include exact updatedAt, pending status, Cart/Attempt and amount/
currency. Loading also verifies the frozen Order lines against Cart quantities and
price/unit snapshots. Work guards include revision/stage/Attempt, or initial V2
createdAt/stage/Attempt. An absent PAYMENT item is compatible; another identity is not.

Before-deadline claim samples the server clock immediately before the winning write.
committingDeadline = committingStartedAt + 120 seconds. This is server-sampled
transaction authority, not an unavailable DynamoDB-generated commit timestamp.
Deadline-driven entry uses original paymentDeadline as committingStartedAt. Late
workers and duplicate messages do not receive fresh time. Ambiguous write results
are reread before proceeding. Existing committing timestamps cannot be rewritten.

The capture PREPARED -> DISPATCHED transition commits separately before any SDK call.
Every dispatch rereads exact current authority; stale work is inert. A local state
fence cannot recall a remote request already issued, so terminal provider evidence
remains essential for release.

## Capture and canonical verification

Capture targets only the bound Intent, explicit full frozen amount_to_capture,
final_capture=true and original deterministic key. No client amount, partial capture,
replacement Intent, tax recalculation or capture generation is supported.

Retrieve before redelivery and after every potentially executed call, including
4xx/5xx, timeout, connection failure and lost response. No raw response authorizes
business settlement. Succeeded must match identity/configuration, exact expected
amount_received and zero amount_capturable. Capture evidence stores only scope,
Intent ID, amounts, currency, succeeded status, verifiedAt and original command ID.

Persist that evidence and FINALIZE_ORDER work atomically. Until paid finalization:
Cart is PAYMENT_COMMITTING, Inventory RESERVED, Order pending, customer processing.
A crash before evidence persistence is recoverable from DISPATCHED authority and
canonical retrieval. Verified capture never regresses to authorization/action/cancel.

## Paid transaction and settlement identity

For N distinct product IDs sorted ascending:

- 0..N-1: Catalog DROP#<dropId>/INVENTORY#<productId> Puts;
  reserved -= quantity, sold += quantity.
- N: Cart Put -> CONVERTED.
- N+1: Order Put -> PAID, paymentStatus CAPTURED.
- N+2: Attempt Put -> CAPTURED.
- N+3: guarded PAYMENT work Delete.
- N+4: exact canonical workflow Delete.
- N+5: inert paid outbox Put conditioned on absence.
- Optional N+6/N+7: webhook receipt PROCESSED and exact inbox work Delete.

Ordinary N+6 (maximum 18); event-assisted N+8 (maximum 20).
No transaction targets any table/PK/SK twice.

Inventory conditions compare total, reserved, sold and updatedAt exactly. Validate
safe integer counters, reserved >= quantity and post-write nonnegative counters
with reserved + sold <= total. Cart/Order/Attempt guards preserve exact revisions,
associations and verified capture authority. No Drop OPEN, storefront or reusable
Product-active conditions participate.

All three business records receive the same deterministic settlement marker:
SHA-256 of Cart/Order/Attempt/scope/Intent/amount/currency/line-digest/outcome. The
line digest covers sorted product IDs and quantities. Outbox references that marker.
Already-completed handling checks terminal states, identity, marker and paid outbox.
Current global Inventory counters are NOT evidence of one Cart's historical outcome;
other owners may legitimately change them after this atomic conversion.

Inventory-only snapshot conflicts cause at most three rebuilt transaction attempts,
with injected bounded jitter. Exhaustion retains/reschedules FINALIZE_ORDER without
another capture. Missing/corrupt Inventory enters invariant recovery. Other stale
transaction conditions retain work and fail safely for retry/reconciliation.

## Deadlines and safe unpaid settlement

At now >= paymentDeadline, new customer confirmation/action admission closes both
by wall-clock checks and a persisted admissionClosedAt revision transition. Queue
lateness does not extend the customer window.

- No Intent and CREATE never dispatched: atomically fence authority; safely expire.
- CREATE possibly dispatched, no bound Intent: preserve ownership and original
  ledger; recovery may depend on a matching webhook/operator investigation.
- Requires action/confirmation/payment method: close admission, select cancellation
  where permitted, and verify its terminal outcome before release.
- Processing: preserve ownership; use original deadline-based committing timestamps.
- Requires capture: claim only within valid committing authority.
- Succeeded: verify capture; never issue another capture.
- Canceled: verify identity/zero received, then settle.
- Provider unavailable or an in-flight command: uncertainty never means unpaid.

Cancellation selects CANCEL_ONLY mode and closes admission before PREPARED and
DISPATCHED command execution. Canonical terminal canceled with zero received is the
release boundary; a response error, decline or requires_payment_method snapshot is
not sufficient. At unknown-outcome hard stop no new financial command is issued.

Failure transaction:

- 0..N-1: exact Inventory Puts returning RESERVED, SOLD unchanged.
- N: Cart terminal Put.
- N+1: Attempt terminal Put.
- N+2: unpaid Order terminal Put.
- N+3: guarded PAYMENT Delete.
- N+4: exact workflow Delete.
- Optional N+5/N+6: receipt completion and inbox Delete.

Ordinary N+5 (maximum 17); event-assisted N+7 (maximum 19).
Release requires persisted NEVER_DISPATCHED authority with no Intent/confirmation/
capture/cancel, or validated CANCELED evidence and closed financial admission.
Terminal Cart ownership becomes zero only in this transaction.

| Business reason                      | Cart      | Attempt   | Order/paymentStatus |
| ------------------------------------ | --------- | --------- | ------------------- |
| Grace ended/abandoned authentication | EXPIRED   | EXPIRED   | EXPIRED             |
| Definitive neutralized failure       | CANCELLED | FAILED    | FAILED              |
| Explicit safe cancellation           | CANCELLED | CANCELLED | CANCELLED           |

Deadline-induced provider cancellation still means EXPIRED. No new Cart state,
refund, restock or unpaid notification outbox is added.

## Unknown outcomes and backoff

At the hard stop, unresolved financial outcomes retain PAYMENT_COMMITTING and
RESERVED. Persist recoveryRequired, recoveryStartedAt/reason, last verified state/
time, consecutive read failures, recoveryPollCount, nextCheckAt and READ_ONLY mode.
Invariant incidents can enter read-only escalation earlier. Temporary provider-read
failure before the boundary retains normal reconciliation work; it never releases.

Base backoff is 60/120/300/900 seconds, positive injected jitter up to 20%, capped at
900 seconds. A unique durable read-claim ID prevents concurrent workers from both
interpreting the same transition as ownership of a poll. Background polling occurs
at most once per minute per Attempt after recovery begins. Duplicate work/webhooks
honor nextCheckAt and do not reset backoff. Definitive evidence clears the polling
wait so local settlement can proceed without another provider command.

Work persists indefinitely without TTL correctness. Queue loss, DLQ and outages do
not remove the obligation. Permanent uncertainty intentionally retains stock for
operator investigation. No automatic refund/replacement/release or timer reset.

## Webhooks, routing and fairness

Webhooks remain signed wake-ups. Bound events honor financial mode and polling
admission, retrieve canonical state when due, and either complete settlement or
transactionally transfer responsibility to retained canonical work. PROCESSED does
not mean PAID. Matching terminal settlements can finish late/out-of-order receipts
without recreating financial work.

The local routing model recognizes SHOPPING V1, PAYMENT V2, initial WORKFLOW V2,
revisioned WORKFLOW V3 and STRIPE_EVENT V3 on the unchanged 00-0F shards. PAYMENT,
WORKFLOW and STRIPE_EVENT route through the future payment port; SHOPPING stays on
the reservation port. Envelopes contain only schema/source/kind/key/revision.

Existing reconciler entrypoints do not supply the optional financial port. Local
mode interleaves both classes within fetched pages. Cursor advancement follows only
the contiguous chronological prefix actually examined, even after interleaving.
Rotating first shard, fixed cutoff, CAS cursor, bounded budgets and retained work
are unchanged. Poison/failed dispatch is revisited in subsequent rounds. Mixed
chronological traversal does not guarantee strict per-kind latency under unlimited
backlog; capacity and age alarms remain a deployment acceptance concern.

## Customer and operator projections

Local GET returns payment_pending, action_required, processing, paid, failed,
expired or cancelled. Captured-but-unfinalized and unknown outcomes are processing.
Paid requires committed local conversion. No action secret is returned after
admission closes. Capability and payment ETag checks remain in force.

Read-only internal recovery projection includes safe business/Intent IDs, stage,
financialMode, last verified state/time, committing deadline, recovery start/age,
sanitized category and next check. It exposes no mutation endpoint or PII.

## Observability and future IAM

Safe operations: paymentAuthorized, claimCapture, capturePayment, verifyCapture,
convertCartToOrder, paymentDeadline, settlePaymentFailure, paymentCancel,
paymentReconcile and paymentUnknownOutcome. Logs contain allowlisted identifiers,
stage/outcome/revision and safe error category, never raw SDK errors, objects,
customer fields, token references or secrets. Do not use IDs as metric dimensions.

Approved conceptual alarms (not created): invariant conflict immediately; unknown
past committingDeadline immediately; captured-unfinalized >60 seconds; three
consecutive retrieval failures; recovery >15 minutes; nonempty payment DLQ.

Future worker IAM: Catalog GetItem/PutItem; Commerce GetItem/PutItem/
ConditionCheckItem; Operations GetItem/PutItem/DeleteItem/ConditionCheckItem.
Operations ConditionCheckItem is needed by inbox responsibility transfer. Exact
queue receive/delete/attributes/send and exact worker-secret SSM GetParameter only.
Reconciler adds exact payment queue SendMessage. Application has no financial write
key; webhook has no financial-command key. No wildcard business permission.

## Deferred 5B2C gate

All payment queues/DLQ, worker/webhook Lambdas, routes, SSM references, key provisioning,
IAM, alarms/recipient, real routing, sandbox acceptance, fault injection and operator
recovery procedure remain deferred. No table/index/TTL, Scheduler, Cognito or S3
changes. Shared source can change existing Lambda assets; this is not permission
to deploy them. Production tax/fees, refunds/restock, notifications and frontend
payment UI remain later gates.

## Validation checkpoint

- Backend typecheck/build: passed.
- Backend functional suite: 732 passed (145 additional cases over 5B2A).
- Artifact tests: 6 passed.
- Infrastructure regression suite: 19 passed; build and synth passed.
- Backend and infrastructure audits: zero vulnerabilities each.
- Formatting and git diff --check: passed.
- Read-only CDK diff: existing ApplicationApi5D63FF39, CartExpiryWorkerD6838A04
  and CartExpiryReconciler320F0954 code assets only (Code.S3Key and aws:asset:path).
  No IAM/routes/queues/new Lambdas/SSM/tables/indexes/TTL/Scheduler/Cognito changes,
  replacements or deletions. No infrastructure source changes.

Tests include rollback at all 18/20 maximum paid action positions and all 17/19
maximum unpaid action positions, actual snapshot contention and three-attempt
exhaustion, crash/lost-response recovery, webhook-first settlement, terminal event
handling, preserved ownership, deadline equality, read-throttle races and bounded
hung-dispatch handling. All provider execution uses controlled transport/fakes.

Local validation evidence is in /tmp/5b2b-backend-tests.log,
/tmp/5b2b-infra-tests.log, /tmp/5b2b-backend-audit.json,
/tmp/5b2b-infra-audit.json, /tmp/5b2b-synth.txt and /tmp/5b2b-cdk-diff.txt.
These files are not repository artifacts. No commit, push or deployment occurred.

Suggested commit, not executed: feat: add payment financial settlement.
