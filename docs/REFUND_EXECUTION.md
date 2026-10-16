# Milestone 1J — refund execution and reconciliation

Local implementation only. No real Stripe operation, AWS deployment, live Order or
inventory mutation, payment admission change, or customer message is authorized.
The deployed API does not install the refund coordinator. The Stripe adapter is
injected, never constructed by a production entrypoint. New API Gateway routes,
permissions, dispatch wiring and provider credentials are **not activated** here.
Accepted mixed Lambda artifact references remain unchanged.

## Financial authority

Refunds use existing Commerce and Operations tables. Authorization requires the
original Order, PaymentAttempt, captured-payment evidence, Intent association,
converted Cart, deterministic PAID settlement identity and PAID outbox to agree.
Original prices, currency, captured amount and settlement evidence are preserved.
Authorization holds, absent evidence, UNKNOWN or contradictory refund disposition
fail closed. The supported existing payment contract is captured DEV USD card
payments; there is no conversion or floating-point amount calculation.

A timely GUARANTEED request retains its full remaining refund entitlement after
the deadline. Its stored settlement, amount and currency must agree. Administrators
cannot authorize a smaller amount for that request. Exceptions and discretionary
refunds require an authenticated administrator and a nonempty reason. Request
intake and review remain separate from financial operations; intake does not claim
that Stripe execution has started.

Commerce `ORDER#id / REFUND_LEDGER` serializes one active refund per Order. It
contains captured, confirmed and reserved integer cents, revision, returned unit
counts and a reconciliation block. Completed plus reserved amounts cannot exceed
capture. Authorization atomically claims the available amount, guards original
payment/request/fulfillment authority, marks REFUND_DISPOSITION PENDING and creates
the operation, durable work pointer and first audit entry. Same-operation retries
retain the original result; changed actor or payload is rejected. Independent
concurrent commands cannot reserve the same remaining amount.

Operations `ORDER_REFUNDS#id / UUID` holds the immutable financial command,
administrator/reason, original Intent, explicit account/environment and ledger
namespace, currency/amount, inventory decision, deterministic
`refund:<orderId>:<operationId>` key, status, provider reference, check count and
server timestamps. `REFUND_AUDIT#id / operationId#revision` is append-only. No
receipt TTL can silently reopen an old financial command.

## Provider and recovery

`MockStripeRefundProvider` drives synthetic acceptance. The inactive
`StripeRefundProvider` uses the existing injected Stripe client/API-version
convention. It verifies the key's current account (`accounts.retrieve(null)`),
DEV PaymentIntent identity, captured amount, currency and Order metadata before
writing. Complete bounded refund-list traversal checks prior provider amounts
against the local ledger before creation. Unknown prior pending refunds or
contradictory amounts block the command. Historical ledger namespaces are never
interpreted as account authorization.

A conditional AUTHORIZED → DISPATCHED transition precedes the provider call. Only
that winner calls create, with exact cents, original Intent and deterministic
idempotency key, and SDK write retries disabled. The creation response is **not**
completion evidence. Subsequent work retrieves the original refund or searches
its durable operation metadata. Lost acknowledgements never cause a second
create. A crash between dispatch claim and provider call can therefore require
operator reconciliation: absence from a list does not prove a mutation never
occurred, and this implementation does not automatically reissue it.

Canonical statuses map to PENDING, SUCCEEDED, FAILED, CANCELED or
RECONCILIATION_REQUIRED (`requires_action` and uncertain reads). Read attempts have
bounded pagination and 1–15 minute backoff; durable responsibility remains until
resolved. Admin refresh reads state; processing/reconciliation acts only on the
original operation. A new process can resume by its durable Order/operation ID.
No new automatic scheduler, queue consumer or payment harness is installed.

The existing official SDK webhook-signature verification now accepts an optional
refund-event handler for `refund.created`, `refund.updated` and `refund.failed`.
Account/environment and signature checks precede handling. Signed payloads are
wakeups, not financial authority: the handler retrieves current provider state.
Create-only event receipts reject identity reuse; duplicate/out-of-order wakeups
cannot apply money or stock twice. Without the injected refund handler these
recognized events fail closed with 503. Existing payment event processing remains.
A contradictory provider transition after a recorded terminal result freezes the
ledger and marks reconciliation required; it does not invent a financial reversal,
reclaim already restocked goods or issue another refund. Operator resolution of
such contradictions is a live-release prerequisite, not automatic money movement.

Provider status references: [Stripe refund objects](https://docs.stripe.com/api/refunds/object),
[refund creation](https://docs.stripe.com/api/refunds/create), and
[refund events](https://docs.stripe.com/api/events/types).

## Completion, inventory and notification

Verified success commits the operation, cumulative amount, refund disposition,
Order state, financial audit, explicit inventory changes, inventory audit and
notification preparation atomically. Full refund records Order CANCELLED with
historical paymentStatus CAPTURED and refund disposition FULL; partial refunds
retain PAID/CAPTURED with PARTIAL. The payment worker's historical completion check
accepts a fully refunded Order only with matching complete refund-ledger proof.
Capture/Cart/Attempt settlement history is never rewritten.

DO_NOT_RESTOCK is the default. RESTOCK requires explicit product quantities and
an administrator's physical-availability attestation. Quantities are bounded by
original purchased units less previously returned units. Money never implies
units. Collected goods cannot be returned. Active refunds block fulfillment;
completion rechecks fulfillment and guards inventory total/reserved/sold/revision.
Eligible returns reduce sold, preserve total and unrelated reservations, and
record an append-only `REFUND_INVENTORY` audit. After a partial return, the
fulfillment screen shows remaining units alongside historical purchased items.
An entirely returned Order cannot be marked collected. Waitlist notification is
explicitly NOT_DISPATCHED; no cleanup or customer publication is performed.

A provider success followed by a database failure leaves the same durable
operation/reservation for reconciliation. Re-reading provider evidence retries
only the atomic local completion, never the refund creation. Inventory conflicts
retain responsibility; they do not authorize a speculative restock.

A create-only REFUND_COMPLETION receipt and ordinary `REFUND#operationId#email`
notification/outbox are committed with success. Existing notification delivery
claims and uncertain-send protections prevent automatic duplicate mail. Eligibility
rechecks the verified successful operation and matching unblocked refund ledger.
Refund messages omit pickup instructions and do not precede verified success.
Only mock delivery was exercised; no real email or SMS is enabled.

## Interfaces and security

Injected/local API contracts are GET `/admin/orders/{orderId}/refunds`, POST
`.../refunds/authorize`, and POST `.../refunds/reconcile`. All require the existing
Cognito access-token administrator group. Default deployed wiring returns
REFUNDS_DISABLED; no mock or environment switch activates production refunds.
SSR relays retain encrypted HttpOnly sessions, expiry, same-origin JSON writes,
no-store responses and bounded bodies/responses. No token, credential, provider
secret or binary is placed in browser storage. Unknown POST outcomes retain the
same in-memory command for retry; a reload requires reviewing authoritative state.

Orders show request/entitlement separately, capture/prior/reserved/remaining
amounts, exact full/partial amount, reason, explicit restock quantities,
confirmation, operation history and bounded financial audit. The secure customer
page shows selected financial status and confirmed totals without administrator
identity/reason or Stripe identifiers. Historical request status is retained.
History/audit queries are bounded to 25 records and visibly report truncation;
older records remain durable and require operator review rather than fabricated
complete history. No customer data appears in diagnostics.

## Validation and release gates

Use existing loopback-only disposable DynamoDB fixtures:
`backend/scripts/test-refunds-local.mjs`; compiled source is required first.
`web/scripts/preview-guest-orders.mjs --refund` exercises the real components,
local API and mock provider. It rejects production mode and binds only loopback.
No synthetic success is installed in deployed handlers.

Local acceptance covers guaranteed full and discretionary/approved-exception
refunds, partial/cumulative limits, duplicate submissions, concurrent authorization
and worker claims, pending/success/failure/canceled/uncertain outcomes, wrong
account/environment, UNKNOWN or absent capture, lost provider/database responses,
restart recovery, duplicate/out-of-order signed wakeups, explicit/no restock,
collected-goods rejection, once-only inventory and notifications, historical worker
compatibility and secure customer/admin projections. Unit tests cover signature
rejection, default-disabled execution, administrator authorization, same-origin
relay protection and exact decimal parsing. Mobile and keyboard flow is exercised
with synthetic data only.

Before live execution: separately approve compatible API/payment-worker/webhook
artifacts, exact account/namespace/credential binding, narrow routes and IAM,
durable dispatch/reconciliation ownership, external-refund/contradiction operator
procedures, physically available stock policy and notification delivery. Preserve
full-stack deployment restrictions, payment admission disabled, public Job 9 and
restricted Admin DEV Job 1. No security exception is granted. Managed DynamoDB,
real provider and live customer acceptance remain unproven by these local tests.
Hosted duplicate-activation acceptance remains **NOT PASSED**.

### Final local validation and checkpoint status

- Frontend: **566 passed**; typecheck, lint and production build passed.
- Backend: **1,111 passed**, plus **10 legacy artifact checks** and **1 isolated
  API ZIP check**; TypeScript and production builds passed.
- DynamoDB Local: **27 refund integration groups**, **11 cancellation groups**,
  **14 guest-order groups** and **10 notification groups** passed.
- Infrastructure: **133 passed**, with typecheck passed; no infrastructure source,
  dependency lockfile or accepted Lambda artifact reference changed.
- Backend dependency audit: **zero findings**. No exception granted.
- Formatting and `git diff --check` passed. Bounded changed-file secret/binary
  inspection found no real credential or binary artifacts.
- Mobile acceptance at 375px had no horizontal overflow. Keyboard authorization
  and processing showed durable full/partial outcomes. Editing a decision clears
  its confirmation; browser reload reads durable status without replaying writes.
- Focused review tightened command/ledger binding before dispatch and guarded
  customer/admin reads against mixing totals across a completion transaction.
  Regression cases verify those conditions fail closed.

The initial checkpoint attempt stopped at expired AWS SSO without pushing or
merging. After manual SSO renewal, the resumed read-only checks verified account
302154194958 in us-east-2, unchanged accepted Lambda artifacts, disabled payment
admission, disabled automatic Amplify deployments, public Job 9 and Admin DEV
Job 1. The reviewed source remains based on
`d35f74adc38c5b14132cac5829f89b12250075a8`; applicable local validation above is
retained. Source-control approval does not authorize deployment or real refunds.
The original testing workspace's tracked diff remains unchanged.
