# Phase 5B1 — payment domain, storage, handoff and durable work

**LOCAL IMPLEMENTATION ONLY. NO REAL PAYMENT STARTS ARE ENABLED.**

The local payment API is not imported by `api.ts` or `handler.ts`; CDK contains
no payment or webhook routes. No provider is initialized, no Stripe SDK is added,
and no secrets or secret IAM are introduced. This foundation must not be enabled
for real carts until Phase 5B2 financial execution and settlement are complete.

## Approved policies

- New payment starts require OPEN and current storefront assignment. PAUSED/CLOSED
  reject new starts. Once started, later pause/close, pointer removal or Product
  deactivation does not invalidate payment ownership. Release and future conversion
  must not require OPEN or storefront assignment.
- Manual capture and server-controlled confirmation remain the future protocol.
  Authorization alone is not SOLD. Only confirmed capture can authorize conversion.
- A definitive decline ends the initial payment attempt. After safe external
  neutralization a future atomic payment settlement returns inventory; no second
  card attempt or new grace is implemented here.
- Create a durable pending Order before any future capture, eliminating a
  successful-capture/no-Order crash window.
- Unknown financial outcome at the committing hard stop retains ownership and
  recovery evidence. It prohibits new financial commands and requires continued
  reconciliation/escalation. The exceptional hold can exceed two minutes.
- Refund and restock are deferred: refund does not inherently mean restock.
  Future SOLD-to-available changes require a separate authorized idempotent workflow.
- Future Stripe secrets use SSM SecureString at
  `/batch-and-batter/dev/stripe/secret-key` and
  `/batch-and-batter/dev/stripe/webhook-signing-secret`. Neither exists as a new
  resource in this phase. Order-management tokens and notifications are deferred;
  Cart capability is not permanent Order authorization.

## Ownership and Cart schema

Commerce `CART#<cartId> / META` retains its original fields and embedded lines.
Exactly six statuses are accepted:

| State               | Ownership                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| ACTIVE              | Embedded quantities remain RESERVED, including after shopping time expires |
| PAYMENT_PENDING     | Embedded quantities remain RESERVED                                        |
| PAYMENT_COMMITTING  | Embedded quantities remain RESERVED, including exceptional recovery        |
| CONVERTED           | Quantities have transferred RESERVED to SOLD                               |
| CANCELLED / EXPIRED | Zero inventory; embedded lines are historical                              |

New optional fields, required together for payment-owned/converted states:

```text
paymentGraceUsed = true
paymentStartedAt
paymentDeadline
paymentAttemptId
orderId
```

ACTIVE cannot contain payment fields. Existing historical ACTIVE/terminal records
remain compatible. Payment start must precede shoppingExpiresAt and the exact
paymentDeadline difference is 240 seconds. shoppingExpiresAt never changes.

Committing fields are `committingStartedAt` and `committingDeadline`, exactly
120 seconds apart, with start between paymentStartedAt and paymentDeadline.
The internal exceptional marker is `recoveryRequired: true` plus
`recoveryReason: UNKNOWN_FINANCIAL_OUTCOME`. Those markers are not public DTO fields.

These schema rules validate shape; they are not permission to forge a financial
result. Only the local handoff persists a new payment state in 5B1. No conversion,
financial settlement, refund, or persisted committing mutation is implemented.

## Attempts, Orders and amount authority

Commerce `PAYMENT_ATTEMPT#<paymentAttemptId> / META` contains:

```text
paymentAttemptId, cartId, orderId, dropId, status,
amountCents, currency, createdAt, updatedAt
```

Allowed future attempt statuses: CREATED, AUTHENTICATING, AUTHORIZED,
CAPTURE_IN_PROGRESS, CAPTURED, FAILED, CANCELLED, EXPIRED. Handoff creates CREATED
only. No fake Stripe ID or speculative provider payload is persisted.

Commerce `ORDER#<orderId> / META` initially contains:

```text
orderId, cartId, dropId, status: PAYMENT_PENDING,
paymentStatus: CREATED, paymentAttemptId,
items: [{productId, name, quantity, unitPriceCents, cookieUnits}],
subtotalCents, taxCents, feeCents, totalCents, currency,
customer: {name, email, phone, smsTransactionalConsent},
pickup: {dropId, date, startTime, endTime, timezone, active, location, instructions},
createdAt, updatedAt
```

Independent Order/attempt ULIDs are allocated for a proposed transaction. Only the
winning transaction establishes identities; matching replay returns those same
IDs without generating new ones. Failed/losing proposals leave no records.

Maximum 12 unique lines. Names are read from reusable Products; price/quantity/
cookie-unit values come from accepted Cart snapshots, not current catalog prices.
Product activation is not an acquisition guard for already-owned quantities.
Customer strings and fulfillment text are bounded; no card data, extra PII or
unnecessary Product metadata is collected. No Order ITEM records or GSIs are added.

Subtotal uses checked safe-integer quantity-times-price arithmetic; total is
subtotal + tax + fee. Checkout input accepts only pickupDate and the named customer
fields, rejecting client price, amount, tax, fee, currency, deadlines and IDs.

There is no existing project currency setting to reuse. The local repository
requires explicit pricing configuration and accepts only the explicitly named
`DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE` fixture mode. Tests inject `currency: usd`
(USD), zero tax, and zero fee. There is no production initialization/default.
Production enablement is blocked until production tax/fee ownership is approved.

## Pickup authority and composition guard

Cart has no prior pickup selection. Start reads selected
`DROP#<dropId> / PICKUP#<date>` consistently and verifies its identity, activity and
that its published window has not ended in its own timezone. Same-day pickup is
allowed before the published end; no appointment capacity or new cutoff is invented.
Location/instructions come from Drop META. Browser text is never authoritative.

Pickup has no revision attribute. The exact condition below compares every
persisted authoritative pickup field. Existing `putPickup` and `removePickup`
use `DynamoCatalogRepository.transact`, whose first action is a Drop META Put
requiring DRAFT and exact updatedAt, and advancing updatedAt. Publication also
uses the Drop revision. Therefore supported writers cannot change published
pickup composition. Handoff's OPEN/revision check covers the Drop fields read.
A future published-composition writer must revisit this protocol.

## Exact fixed ten-action transaction

All validation reads are consistent. `c` = Cart ID, `d` = Drop ID, `a` = attempt,
`o` = Order, `p` = selected pickup date, `t` = freshly sampled server timestamp.

| Index | Action              | Table / PK / SK                                                           |
| ----- | ------------------- | ------------------------------------------------------------------------- |
| 0     | ConditionCheck      | Catalog / DROP#d / META                                                   |
| 1     | ConditionCheck      | Catalog / STORE#CONFIG / STOREFRONT                                       |
| 2     | ConditionCheck      | Catalog / DROP#d / PICKUP#p                                               |
| 3     | Put PAYMENT_PENDING | Commerce / CART#c / META                                                  |
| 4     | Put CREATED         | Commerce / PAYMENT_ATTEMPT#a / META                                       |
| 5     | Put PAYMENT_PENDING | Commerce / ORDER#o / META                                                 |
| 6     | Delete              | Operations / CART_EXPIRY#V1#shard / shoppingExpiresAt#SHOPPING#c          |
| 7     | Put                 | Operations / CART_EXPIRY#V1#shard / paymentDeadline#PAYMENT#c             |
| 8     | Put                 | Operations / CART_EXPIRY#V1#shard / paymentStartedAt#PAYMENT_WORKFLOW#c#a |
| 9     | Put receipt         | Operations / IDEMPOTENCY#hash / META                                      |

**Always 10 actions**, independent of line count; no Inventory action and no
repeated table/PK/SK target. All fail or commit together.

Conditions (names map directly to fields below):

```text
0: attribute_exists(PK) AND #status = :open AND #updated = :expected
   #status=status, #updated=updatedAt
   :open=OPEN, :expected=validated Drop.updatedAt

1: #storefront = :drop
   #storefront=storefrontDropId; :drop=d

2: attribute_exists(PK) AND #drop = :drop AND #date = :date
   AND #active = :active AND #start = :start AND #end = :end AND #zone = :zone
   #drop=dropId, #date=date, #active=active, #start=startTime,
   #end=endTime, #zone=timezone
   values: d, validated date, true, validated start/end/timezone

3: attribute_exists(PK) AND #status = :active AND #updated = :expected
   AND #token = :token AND attribute_not_exists(#grace) AND #expires > :now
   #status=status, #updated=updatedAt, #token=managementTokenHash,
   #grace=paymentGraceUsed, #expires=shoppingExpiresAt
   values: ACTIVE, validated Cart.updatedAt, caller capability hash, t

4,5,7,8,9: attribute_not_exists(PK)

6: attribute_not_exists(PK) OR (#cart = :cart AND #type = :type
   AND #deadline = :deadline AND #version = :version)
   #cart=cartId, #type=deadlineType, #deadline=deadline, #version=schemaVersion
   values: c, SHOPPING, original shoppingExpiresAt, 1
```

Cart writes preserve embedded quantities and historical shoppingExpiresAt, set
paymentStartedAt=t and paymentDeadline=t+240 seconds, and advance updatedAt
monotonically. Lifecycle/Drop eligibility is guarded by action 0, not by placing
foreign-item attributes in the Cart condition. Deadline equality is rejected.
As with 5A1, sampled time is not a DynamoDB wall-clock commit timestamp.

## Idempotency and cancellation mapping

Required: X-Cart-Token, existing timestamped Idempotency-Key, strong current If-Match.
Scope is `cart:v1:beginPayment:<cartId>`; key is SHA256(scope + ':' + raw key).
Fingerprint hashes fixed-field cartId, normalized pickup/customer input and If-Match.
The receipt stores a safe accepted Cart DTO, scope, fingerprint, capability hash,
createdAt and seven-day minimum retainUntil metadata. No PII, raw capability,
raw idempotency key, or provider secret appears in the receipt response/work.
No TTL or cleanup is enabled.

Replay checks capability then fingerprint before live revision/deadline checks.
It returns the accepted historical handoff; GET returns current state. A different
new request after grace was consumed returns PAYMENT_ALREADY_STARTED.

After ambiguous response/cancellation, reread receipt first, then current Cart.
A competing payment winner returns PAYMENT_ALREADY_STARTED. Conditional failure
at index 0/1/2/3 maps respectively to DROP_NOT_OPEN/STOREFRONT_CONFLICT/
INVALID_PICKUP_DATE/CART_CONFLICT. Other transaction failures return CART_BUSY,
requiring the same request/key. No automatic rebase or extra transaction loop.
Each SDK call has a bounded timeout; production end-to-end request budgeting
must be integrated before enabling the local adapter in 5B2.

## Race semantics

- Pause/close first: OPEN/revision guard fails, nothing hands off.
- Start first: later lifecycle changes preserve already-started ownership.
- Shopping expiry/PUT/DELETE first: Cart exact revision/status guard fails.
- Start first: shopping expiry rereads as obsolete; PUT/DELETE conflict.
- Two tabs: one Cart revision wins. Same-key loser replays; different-key loser
  returns PAYMENT_ALREADY_STARTED. No duplicate Order, grace, work, or attempt.
- Pickup field changes between read/commit: action 2 fails. Supported composition
  changes additionally conflict through Drop revision/state.

## State-aware reads, release and shopping messages

Cart GET marks shopping-expired only for EXPIRED or overdue ACTIVE. Payment-owned
and CONVERTED states are not labeled expired merely because shopping time passed.
Safe DTOs include payment IDs/deadlines and committing timestamps, not recovery
markers, hashes, internal keys, contact information or provider secrets.
Local payment GET additionally exposes customerWindowClosed; this is not evidence
that payment-owned inventory has been released.

Generic DELETE explicitly rejects PAYMENT_PENDING, PAYMENT_COMMITTING and CONVERTED
with CART_CONFLICT. ACTIVE and already-settled CANCELLED/EXPIRED retain prior behavior.
Historical idempotent DELETE replay retains its original response without writes.

Old SHOPPING messages against payment-owned states are obsolete, not authority to
release. Cleanup is exact Cart status/revision/shopping-deadline ConditionCheck
plus guarded deletion of only the old SHOPPING item. It does not rewrite Cart,
advance ETag, touch payment work, or decrement stock. Terminal states use the same
safe cleanup. The test inventory invariant now counts all three reserved-owning
Cart states, excluding attempt/Order rows and terminal history.

## Durable payment records and disabled execution

PAYMENT work:

```text
PK = CART_EXPIRY#V1#<unchanged 16-shard derivation>
SK = <paymentDeadline>#PAYMENT#<cartId>
schemaVersion = 2
cartId, paymentAttemptId
deadlineType = PAYMENT
deadline = paymentDeadline
createdAt = paymentStartedAt
```

Workflow work:

```text
PK = CART_EXPIRY#V1#<same shard>
SK = <paymentStartedAt>#PAYMENT_WORKFLOW#<cartId>#<attemptId>
schemaVersion = 2
cartId, paymentAttemptId
deadlineType = PAYMENT_WORKFLOW
deadline = paymentStartedAt
createdAt = paymentStartedAt
step = CREATE_INTENT
```

The workflow record is immediately due and points to durable Cart/attempt/Order
state. No quantities, PII or secret is in either work record. In 5B2 its versioned
step/next-check model must support create/bind/confirm/authorize/capture/finalize
recovery and conditional rescheduling; 5B1 intentionally supports CREATE_INTENT only.

The current reconciler recognizes and validates both new record kinds, visits and
retains them, counts PaymentWorkDeferred, and never dispatches/executes them. Existing
SHOPPING v1 query/cursor/send semantics remain intact. A valid v2 processPayment
wake-up sent directly to the worker fails closed as PAYMENT_NOT_ENABLED with a
partial-batch failure, leaving work and inventory untouched. No such messages are
produced by this phase. This is not a working payment deadline settlement service.

## Hard-stop policy model and provider port

`modelCommitting` is pure: a qualifying backend timestamp establishes the 120-second
window once; calling again on COMMITTING cannot reset it. `modelUnknownHardStop`
retains PAYMENT_COMMITTING and returns explicit retainWork/reconcile true and
releaseInventory/sellInventory/allowFinancialCommands false. It marks the internal
recovery/escalation condition and preserves it idempotently. Neither function
performs writes, financial calls, inventory sale, or financial-result fabrication.

PaymentProvider defines only createIntent, retrieveIntent, confirmIntent,
captureIntent and cancelIntent using narrow server-authorized command/snapshot types.
There is no Stripe SDK, implementation, secret, initialization or network transport.
A deterministic test fake exists only in tests and is never injected into handoff.

## Local API and errors

`localPaymentApi` accepts POST /carts/{cartId}/payment/start and
GET /carts/{cartId}/payment only when explicitly called by local tests. There is
no /payment/confirm or webhook handler/route. Production createHandler returns 404
for both local routes. Responses are no-store; logs use fixed operation names,
status and safe domain code only, never exception/request/object spreads.

| Code                    | HTTP | Meaning                                                     |
| ----------------------- | ---- | ----------------------------------------------------------- |
| VALIDATION_ERROR        | 400  | Invalid input/header/key or unsafe amount arithmetic        |
| INVALID_PICKUP_DATE     | 400  | Selected pickup missing/inactive/ended or snapshot changed  |
| UNAUTHORIZED            | 401  | Missing/wrong capability or missing Cart                    |
| RESERVATION_EXPIRED     | 410  | Shopping deadline reached before start                      |
| CART_CONFLICT           | 409  | Wrong revision/state or generic payment-owned DELETE        |
| IDEMPOTENCY_CONFLICT    | 409  | Key reused with changed accepted input                      |
| IDEMPOTENCY_KEY_EXPIRED | 409  | New key outside existing validity window                    |
| PAYMENT_ALREADY_STARTED | 409  | Another accepted start already consumed grace               |
| DROP_NOT_OPEN           | 409  | Drop missing/not OPEN/not yet open or revision changed      |
| STOREFRONT_CONFLICT     | 409  | Pointer does not name the Drop                              |
| PRODUCT_NOT_AVAILABLE   | 409  | Product identity needed for name snapshot is missing        |
| CART_BUSY               | 503  | Transaction outcome not resolved; retry same request/key    |
| INTERNAL_ERROR          | 500  | Invalid persisted/configuration state or unexpected failure |

No new quantities are accepted by payment start; existing Cart quantity-limit
validation remains unchanged. No financial success is returned in this phase.

## Validation and infrastructure boundary

Tests cover every handoff action rollback, deadline equality, stable replay,
lost commit response, concurrent starts, both race winners, lifecycle changes,
pickup-field snapshot conflicts, state-aware GET/DELETE, stale SHOPPING cleanup,
work retention, hard-stop policy, arithmetic, explicit fixture configuration,
production route isolation and secret-free success/error logging. Full existing
reservation, expiry/recovery, lifecycle and automatic-opening suites are retained.

No infrastructure source/dependencies are changed. Shared backend safety code
changes the packaged directory used by all three existing Lambda functions;
therefore existing Lambda code asset changes are expected in a CDK diff. No new
routes, IAM, parameters, Lambdas, queues, indexes, TTL or Scheduler changes are
permitted. Do not deploy this asset as part of Phase 5B1.

Validation results are appended after the final checks. Suggested commit, not run:
`feat: add payment state foundation`.

## Final local validation

- Backend typecheck and build passed.
- Full backend suite: **506 functional tests passed**, including 63 new payment
  foundation cases; **6 artifact tests passed**.
- Infrastructure typecheck/build and **19 regression tests passed**.
- Backend and infrastructure npm audit: **0 vulnerabilities** each; no audit fix.
- CDK synth with lookups disabled passed.
- Baseline template comparison: no added/deleted resources; only Code on the
  existing application, expiry worker and reconciler functions changed.
- Read-only live CDK diff (`--profile batch-and-batter-dev --no-change-set
--lookups=false`) confirmed those same three code-asset changes (plus associated
  asset-path metadata). No route, IAM, environment, table, queue, Scheduler,
  EventInvokeConfig, Cognito or other infrastructure change; no replacement/deletion.
- Shared asset: `ebd43969933e745be88e956aa08f77743d9c53ab9be562aa5452e41c97b57011`
  to `35a45e23e359148dd5ffa3f0d66e8c0a0ddbf6583fb9b43e16c5259b38bf51a4`.
- Formatting and git diff --check passed. Branch remains
  `feature/phase-5b1-payment-foundation`; all changes remain uncommitted.
- No Stripe calls/SDK, AWS mutation, deployment, secret creation, commit or push.

Local evidence: `/tmp/phase5b1-backend-tests.log`,
`/tmp/phase5b1-infra-tests.log`, `/tmp/phase5b1-backend-audit.json`,
`/tmp/phase5b1-infra-audit.json`, `/tmp/phase5b1-synth.log`,
`/tmp/phase5b1-cdk-diff.log`. CDK emitted the existing feature-flag advisory;
no feature flags were changed.
