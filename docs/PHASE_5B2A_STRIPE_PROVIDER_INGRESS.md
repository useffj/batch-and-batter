# Phase 5B2A — durable Stripe provider and webhook ingress

**NO LIVE PAYMENT FLOW IS ENABLED.**

Local implementation only. Do not deploy this phase independently or enable payment starts until 5B2A, 5B2B and 5B2C are reviewed together. Main before this branch was `61b19ff14046a6b69f9a8545bcf34fdc49a6d268`; the development deployment remains Phase 5A2 according to the approved checkpoint. No live Stripe calls or credential provisioning are part of this phase.

## Submission and immutable ownership

The local start body is strictly `{ confirmationTokenId, pickupDate, customer }`. It rejects Intent IDs, amount, currency, taxes, fees, deadlines and Order IDs. A future browser calls Elements submission validation and creates a Stripe ConfirmationToken before submitting Pay. There is no frontend implementation here.

After capability, revision, Cart, Drop and pickup checks, the read provider retrieves the token. It must identify the requested token, be sandbox-only, unexpired, card-compatible, and not already consumed by a PaymentIntent or SetupIntent. The adapter rejects future-use setup configuration. Provider projection discards billing/card/shipping details; raw provider objects are not persisted. Account/sandbox isolation comes from the explicitly configured restricted key; token objects do not expose an account identity field that could independently prove their account. Future credential provisioning must verify the account associated with that key.

Only after validation is `paymentStartedAt` sampled from the server clock. `paymentDeadline = paymentStartedAt + 240000 ms`. The existing shopping deadline and one-use grace invariant remain unchanged. The token participates in the hashed start-request fingerprint but is absent from the accepted response.

The Commerce Attempt holds `execution.confirmationTokenId`, the immutable submission reference. A separate Commerce ownership guard uses:

- PK: `STRIPE_SUBMISSION#<sha256(scope + ':' + confirmationTokenId)>`
- SK: `META`
- Fields: `paymentAttemptId`, `cartId`, `orderId`, `createdAt`
- Put condition: `attribute_not_exists(PK)`

The guard does not store the raw token ID. A matching start replay resolves the existing application receipt before validating the now-consumed token again. A changed submission under the same key conflicts. Another Attempt cannot acquire an existing ownership guard; its entire handoff rolls back. A token-ownership conditional failure maps to `VALIDATION_ERROR` without exposing another Cart.

## Eleven-action payment start

Phase 5B1 historically used ten actions; its historical document remains unchanged. Phase 5B2A adds submission ownership at index 10:

| Index | Action                                                            |
| ----- | ----------------------------------------------------------------- |
| 0     | Catalog Drop ConditionCheck: OPEN and exact revision              |
| 1     | Catalog storefront ConditionCheck                                 |
| 2     | Catalog pickup ConditionCheck                                     |
| 3     | Commerce Cart Put: ACTIVE → PAYMENT_PENDING                       |
| 4     | Commerce PaymentAttempt Put, including immutable create authority |
| 5     | Commerce pending Order Put                                        |
| 6     | Operations exact SHOPPING work Delete                             |
| 7     | Operations PAYMENT deadline Put                                   |
| 8     | Operations initial PAYMENT_WORKFLOW Put                           |
| 9     | Operations payment-start idempotency receipt Put                  |
| 10    | Commerce unique submission-ownership Put                          |

All eleven keys are distinct. No Inventory action occurs. The Amount remains the frozen development-only USD, zero-tax/zero-fee fixture; this is not a production tax policy. Tests cover rollback at every action.

## SDK and restricted keys

Official `stripe@22.6.2` is pinned in package.json and package-lock.json. The adapter explicitly uses API version `2026-08-26.dahlia`, matching that SDK's generated types. It sets `maxNetworkRetries: 0` and a 3000 ms provider timeout. Durable commands own retries; mocked official-SDK transport tests prove one transport request on failure. No live Stripe request is required or made by these tests.

Stripe restricted keys grant resource-level permissions, not independent create/confirm/capture/cancel permissions within PaymentIntents. Payment Intents Write is broader than confirmation alone. Do not claim a write key can forbid capture while allowing confirm.

Future secret paths, not created or wired here:

- Worker: `/batch-and-batter/dev/stripe/payment-worker-key`
- Application reads: `/batch-and-batter/dev/stripe/payment-read-key`
- Webhook: `/batch-and-batter/dev/stripe/webhook-signing-secret`

The future worker needs Payment Intents write/read capability and any required ConfirmationToken read capability. Application reads need Payment Intents Read and ConfirmationToken Read, never Payment Intents Write. The exact restricted-key configuration must be verified in the intended sandbox during a separately approved credential/acceptance gate; mocked tests do not prove a deployed key's permissions. Never compensate for insufficient permissions with an unrestricted key.

The local SDK factory rejects unrestricted `sk_*` and live keys. It accepts only sandbox restricted-key form. This checks key form, not effective grants.

`StripePaymentReader` exposes only token retrieval, Intent retrieval, and action-state retrieval. `StripePaymentProvider` extends it with command methods. Application customer operations accept a read interface and repository methods; they do not require a write-provider interface. Webhook verification uses no API key. Shopping expiry receives no Stripe dependency or secret.

## Command ledger and provider protocol

Authority is embedded in Commerce `PAYMENT_ATTEMPT#<attemptId> / META`, under `execution`:

- scope, immutable token reference, revision and stage;
- frozen amount/currency, manual capture/automatic confirmation, card-only methods;
- metadata exactly `environment`, `cartId`, `orderId`, `paymentAttemptId`, `dropId`;
- create command and bounded confirmation command history;
- candidate/bound Intent ID and sanitized observed status;
- exact workflow pointer/revision and optional recovery reason.

Each command records deterministic ID, kind, generation, createdAt, retryUntil, PREPARED/DISPATCHED/OBSERVED state, dispatch timestamp and, for confirmation, bound Intent ID. Initial confirmation references the immutable token on the Attempt; customer-action wake-ups do not append confirmation commands or resubmit a consumed token. No command stores client_secret, raw token contents, customer details, or raw provider errors.

Identities:

- `payment-create:<paymentAttemptId>`
- `payment-confirm:<paymentAttemptId>:<generation>`

`retryUntil = createdAt + 23 hours` is a **LOCAL SAFETY CUTOFF**, conservative relative to Stripe's documented minimum idempotency retention. It is not a claim that Stripe guarantees exactly 23 hours. Commands cannot change identities, frozen parameters, scope, submission, generation history or retry horizon during a workflow transition. Past the cutoff, work moves to RECOVERY_REQUIRED; no replacement create/confirmation is issued. The four-minute customer deadline can stop dispatch earlier.

CREATE_INTENT first commits DISPATCHED authority and successor work, then rereads exact authority before provider dispatch. The adapter creates an unconfirmed Intent with `confirm=false`, `capture_method=manual`, `confirmation_method=automatic`, explicit `['card']`, server amounts and approved metadata. The initial token is used at confirmation, not creation.

On success, the workflow stores the candidate ID and BIND_INTENT stage. A timeout/lost response leaves the original command and work intact; a retry uses the identical command/key/parameters. No replacement Intent is allocated. A crash after remote success but before persisting the candidate is recovered the same way.

## Binding and unique association

Commerce reverse association:

`STRIPE_PAYMENT_INTENT#<scope>#<paymentIntentId> / META`

Fields: scope, Intent/Attempt/Cart/Order IDs, `environment: dev`, createdAt. Scope must identify the intended sandbox/account at later wiring; local fixtures use a synthetic scope.

Binding retrieves current Intent state, verifies amount/currency/manual configuration/metadata and an unconfirmed, uncharged state. It atomically:

1. Puts the Attempt with bound Intent, OBSERVED create command, initial PREPARED confirmation command and next revision.
2. Checks exact pending Cart revision/state.
3. Replaces exact current workflow work, guarded by its revision.
4. Puts the reverse association with `attribute_not_exists(PK)`.

Moving to another work key uses old Delete + new Put; same-key transitions use one conditional Put. An existing conflicting association is never overwritten; recovery work records ASSOCIATION_CONFLICT. A concurrent bind loser rereads on subsequent delivery. A lost bind response cannot create another Intent or confirmation generation.

## Confirmation and customer state

Confirmation executes only after binding, reverse association validation and durable DISPATCHED confirmation authority. Generation zero uses the accepted ConfirmationToken; later generations confirm the same bound Intent without another submission. Before dispatch, reread current work/Attempt/Cart and deadline. SDK exceptions are not treated as financial failure: retrieve current Intent state; unresolved cases retain original command/work for retry.

| Provider outcome                   | Local stage                                             | Attempt                                            |
| ---------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| requires_action                    | WAIT_FOR_CUSTOMER_ACTION                                | AUTHENTICATING                                     |
| requires_confirmation              | VERIFY_AUTHORIZATION                                    | AUTHENTICATING                                     |
| processing                         | VERIFY_AUTHORIZATION                                    | AUTHENTICATING                                     |
| requires_capture                   | CLAIM_CAPTURE, after exact capturable-amount validation | AUTHORIZED                                         |
| requires_payment_method / canceled | RESOLVE_FAILURE                                         | AUTHENTICATING, pending future safe settlement     |
| succeeded                          | FINALIZE_ORDER                                          | AUTHENTICATING, pending future verified settlement |

Neither a succeeded snapshot nor authorization makes the Order PAID. Cart remains PAYMENT_PENDING and owns RESERVED throughout 5B2A. No inventory or Order settlement writer exists here.

`/payment/confirm` retains capability, payment-specific If-Match, Idempotency-Key and expected `continuationGeneration` checks. After canonical Intent configuration/association validation, it atomically wakes VERIFY_AUTHORIZATION with a receipt. It never appends a confirmation command. The generation field remains an optimistic identity check against the existing initial command count. Replay resolves the same receipt. No Attempt, Order, Intent or grace is created. Customer action continues at Stripe automatically; canonical worker retrieval determines authorization or failure, never the browser acknowledgment.

Payment ETag is quoted SHA-256 of the JSON array `[cart.updatedAt, attempt.updatedAt, execution.revision]`. Every workflow/Attempt transition advances revision and monotonic Attempt updatedAt. No secrets enter the ETag. Stale continuation requests fail.

Capability-authorized GET can retrieve a narrowly scoped client secret for current requires_action state through the read adapter. It is returned only in the no-store response, never persisted in work or receipts or put into a URL. Other customer states remain payment_pending/processing; this phase cannot truthfully return paid/settled failure. Frontend/HTTPS route wiring remains absent.

## Canonical work and queue contract

Existing Phase 5A2 `expiryShard(cartId)` remains unchanged: SHA-256 first byte low four bits, uppercase hexadecimal padded to two characters, **00–0F**. The first payment-message validator incorrectly accepted one character; it is corrected to `^CART_EXPIRY#V1#0[0-9A-F]$`.

Cart workflow keys continue using `expiryShard(cartId)`:

- PK: `CART_EXPIRY#V1#<00–0F>`
- SK: `<due timestamp>#PAYMENT_WORKFLOW#<cartId>#<attemptId>`

Stripe-event work hashes event ID to one of the same sixteen partitions using the identical low-four-bit/two-character representation. It does not introduce another partition family or change shopping sharding. Tests cover 00/0F and reject single-character, lowercase and out-of-range forms.

The initial handoff uses existing version-2 CREATE_INTENT work. Its first transition is guarded by initial identity/createdAt/step and upgrades to version-3 revisioned work. Subsequent work holds schemaVersion, deadlineType, Cart/Attempt IDs, due/created timestamps, revision and step. Attempt revision and pointer are authoritative. DynamoDB Get keys contain only PK/SK, not queue-envelope fields.

Queue envelope: schemaVersion 1, source `batch-and-batter.payment`, kind WORKFLOW or STRIPE_EVENT, PK, SK and revision. No provider key, token reference, PII or raw event payload. The local worker validates exact queue ARN and SQS source and returns partial batch failures. Stale revisions are inert. Queue delivery success never deletes final work; failed dispatch leaves successor authority recoverable.

Future approved queue configuration: separate standard queue/DLQ, worker timeout 30s, reserved/max concurrency 2, batch size 1/window 0, visibility 180s, retention 4d/DLQ 14d, maxReceiveCount 5, SSE-SQS. None is provisioned here.

## Webhook raw bytes and durable inbox

The local webhook factory has no API Gateway/CDK route. It preserves raw bytes, decodes base64 only when indicated, bounds decoded payload at 256 KiB, and invokes the official SDK signature verifier before business processing. Default configured tolerance is 300 seconds; tests use an injected clock and generated signatures. It rejects live mode, mismatching supplied account and wrong environment. Direct-account events may omit account; the configured endpoint signing secret is then the account/sandbox trust boundary. It never logs raw bodies, signatures or SDK exceptions.

Recognized wake-ups: payment_intent.created, amount_capturable_updated, processing, succeeded, payment_failed and canceled. No irreversible action is based on the event snapshot.

Acceptance transaction creates two items atomically:

1. `EXTERNAL_EVENT#STRIPE#<eventId> / META`: RECEIVED receipt, scope, event/Intent IDs, type, createdAt, revision and work pointer.
2. `<timestamp>#STRIPE_EVENT#<eventId>` in the canonical due-work partition: version 3, STRIPE_EVENT type, event ID, due/created timestamps and revision.

Only after persistence is conceptual HTTP 200 returned. Queue dispatch is optional and best-effort; lost dispatch retains the inbox. No raw payload is stored. A matching PROCESSED duplicate returns 200 without effect. A RECEIVED duplicate verifies work; if absent, it conditionally restores the SAME original work key while checking receipt state/revision. Conflicting/damaged work is not overwritten and produces 503. Acceptance failure is 503; invalid signature 400; oversized decoded body 413.

Processing retrieves trusted current provider state and resolves local Attempt authority. Before binding, it requires a durable dispatched create command and full provider validation; no orphan metadata blindly allocates an Attempt. Missing association retains RECEIVED/inbox work. Once canonical workflow durably owns progression, a transaction checks its Attempt revision and exact canonical workflow revision, marks receipt PROCESSED, and deletes exact inbox work. A processing conflict leaves the inbox for retry. Out-of-order event types never roll back inventory or sell it.

## Execution boundary and 5B2B handoff

Executable local stages: CREATE_INTENT, BIND_INTENT, CONFIRM, WAIT_FOR_CUSTOMER_ACTION, VERIFY_AUTHORIZATION.

Non-executable handoff stages: CLAIM_CAPTURE, CAPTURE, VERIFY_CAPTURE, FINALIZE_ORDER, RESOLVE_FAILURE, RECOVERY_REQUIRED. The worker reports PHASE_5B2B_REQUIRED and retains authority. Capture/cancel adapter methods throw PHASE_DISABLED without transport access. Passing a deadline or reaching unknown recovery does not release inventory.

5B2B must implement capture claim, immutable committing clock, full capture validation, atomic RESERVED→SOLD/Cart→CONVERTED/Order→PAID/Attempt→CAPTURED, captured-but-unfinalized recovery, cancellation proof, safe release, payment deadline execution, unknown-outcome escalation and bounded reconciliation. It must integrate event/work routing and finalization receipt guards. The paid-event outbox is an accepted future concept, not created by 5B2A.

5B2C must review combined infrastructure, actual restricted-key grants, secret provisioning, alarms/delivery, all financial race cases and controlled sandbox acceptance before route enablement. Existing reconciler still defers version-2 payment work; version-3 routing is deliberately not connected yet. No standalone 5B2A deployment is safe or authorized. Future worker IAM must include narrowly scoped Operations `ConditionCheckItem` for atomic inbox-to-workflow obligation transfer; no permission is added here.

## Security and validation

Structured logs emit only operation/outcome/status fields. They do not include ConfirmationToken IDs, client_secret, restricted/API keys, webhook signing secrets, signatures, raw responses/errors/bodies, capabilities, Idempotency-Key values or customer PII. Only the explicitly authorized action DTO may carry a client secret. ConfirmationToken ID is confined to required Commerce Attempt authority and the transient provider call.

Tests use in-memory transactional fixtures and fake official-SDK HTTP transport. They cover token validation/ownership, all eleven handoff rollbacks, command-before-dispatch crashes, lost responses, bind crashes/collision, stale work, retry cutoff, immutable command authority, all provider outcomes, confirmation generations/ETags/deadlines, webhook signatures/base64/size, inbox repair/damage/duplicates/dispatch loss, event-before-bind/out-of-order retrieval and secret exclusion. Production entrypoint tests require 404 for all payment routes and webhook.

Required validation: backend typecheck/build/full functional/artifact tests and audit; infrastructure regression/synth/audit; formatting and git diff --check; read-only CDK diff. There must be no new route, queue, Lambda wiring, SSM parameter, Stripe IAM, table/GSI/TTL or Scheduler change. Shared existing backend code assets may differ from live Phase 5A2. Test totals and live-diff authentication status are reported with the implementation review rather than inferred from mocks.

Sources: [Stripe ConfirmationTokens](https://docs.stripe.com/api/confirmation_tokens/retrieve), [server-finalized Payment Element](https://docs.stripe.com/payments/finalize-payments-on-the-server), [restricted keys](https://docs.stripe.com/keys/restricted-api-keys), [idempotency](https://docs.stripe.com/api/idempotent_requests), [confirmation semantics](https://docs.stripe.com/api/payment_intents/confirm), [webhook verification](https://docs.stripe.com/webhooks).

## C3A2 compatibility correction

The original 5B2A implementation and historical validation used manual confirmation. Live C3A accepted payment/start once and dispatched a confirm containing the ConfirmationToken, but Stripe rejected it with HTTP 400 on confirmation_method: Elements-collected details cannot use manual confirmation. This was not a decline, missing token, serialization failure, or absent dispatch. C3A2 corrects the contract to automatic confirmation + manual capture. Historical test totals above describe the earlier implementation.

Stripe.js handleNextAction completes customer authentication on the same Intent; the server does not reconfirm it. See [Stripe server-finalized payments](https://docs.stripe.com/payments/finalize-payments-on-the-server) and [confirmation semantics](https://docs.stripe.com/api/payment_intents/confirm).

Existing pre-C3A2 Attempts retain their historical manual-confirmation evidence. The persisted read schema accepts manual or automatic confirmation without normalization. A separate execution guard requires automatic confirmation and blocks outstanding legacy manual-confirmation workflows. Before a separately authorized deployment, recheck that legacy financial responsibility is settled; do not migrate or replay historical records as part of this local fix.

### C3A2A historical reads and rollout gate

Historical records preserve their original confirmationMethod. Structurally valid manual and automatic records remain readable; only automatic confirmation with manual capture is executable. No migration or normalization occurs. Terminal legacy EXPIRED, FAILED, CANCELLED, and CAPTURED history remains customer-readable without provider access or new work. Unresolved legacy GET returns non-actionable processing without a client secret.

LEGACY_PAYMENT_CONTRACT blocks unresolved legacy workflow execution and customer continuation before provider dispatch or inventory mutation. Queue processing records this fixed classification and reports the message as failed, preserving durable work for operator review and existing retry/DLQ handling. This is escalation, not automated recovery or inventory release. Terminal work is inert. For a terminal legacy webhook, consistent local settlement and linkage are required before acknowledging the inbox; only the receipt/work acknowledgment changes, with no Stripe retrieval or financial resurrection.

Before any separately authorized deployment, prove zero unresolved legacy PAYMENT_PENDING/PAYMENT_COMMITTING responsibility, zero unresolved PAYMENT/PAYMENT_WORKFLOW work, zero unresolved Stripe-event responsibility, and no old-contract Attempt requiring continuation. Historical terminal manual-confirmation records may remain. PAYMENT_START_ENABLED must stay false during rollout.
