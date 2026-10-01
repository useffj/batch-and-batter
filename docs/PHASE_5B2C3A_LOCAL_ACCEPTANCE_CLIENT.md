# Phase 5B2C3A0 — localhost Stripe acceptance client

THIS TOOL IS NOT CUSTOMER-FACING AND MUST NOT BE DEPLOYED.

Payment admission remains disabled. C3A0 authorizes local tooling and mocked tests only:
no Cart/Drop creation, ConfirmationToken creation, payment/start request, PaymentIntent,
AWS deployment or Stripe mutation has been performed for this phase.

## Boundary and architecture

`tools/stripe-acceptance/` is a separate Node 24 entrypoint, outside Next.js routes,
public assets, backend build inputs and CDK. The Coming Soon page and production
frontend dependencies are unchanged. The server refuses any NODE_ENV except
`development` and binds only `127.0.0.1:4242`. Host and Origin checks, no CORS response,
a custom JSON request header and a static-file allowlist protect the loopback boundary.
No generic proxy, cloud route, restricted-key loader or capture/cancel operation exists.

The browser loads Stripe.js directly from `https://js.stripe.com/dahlia/stripe.js`.
There are no added npm dependencies. The browser SDK is hosted by Stripe, not bundled
or mirrored locally. Reference: [Stripe server-finalized Elements guide](https://docs.stripe.com/payments/finalize-payments-on-the-server?platform=web&type=payment).

## Display amount and flow

The relay reads the genuine capability-protected `GET /carts/{cartId}`, including its
ETag, and obtains pickup windows from `GET /drops/{dropId}`. It rejects expired or
non-ACTIVE Carts and non-OPEN Drops. The displayed amount is the safe-integer sum of
server-returned `quantity * priceCents`, under the currently deployed explicit
`DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE` / USD fixture. No manually entered amount exists.
If tax, fees, currency, or this API contract changes, stop: review a server preview
contract before using this harness. This tool is not pricing authority.

Elements uses `mode: payment`, that snapshot amount, `currency: usd`,
`captureMethod: manual`, `paymentMethodTypes: [card]`, and `paymentMethodCreation: manual`.
No Intent or client secret is required to render it. On a separately authorized Pay:

1. Block duplicate submission; validate the approved contact/pickup fixture.
2. Call `elements.submit()`; stop on validation failure.
3. Call `stripe.createConfirmationToken({ elements, params: { return_url: 'http://127.0.0.1:4242/' } })`.
4. Immediately submit the returned ID through the fixed local relay.
5. Keep one immutable request only in memory for identical replay after an ambiguous
   response. Never create a replacement token for a retry. Discard the retained request
   after acceptance. Acceptance is not proof of payment or local financial settlement.

The real start request is `POST /carts/{cartId}/payment/start`, with `X-Cart-Token`,
`If-Match` (the Cart GET ETag), fresh `Idempotency-Key` in the real
`v1.<milliseconds>.<32 random base64url bytes>` format, and `Content-Type: application/json`.
Body contains only `confirmationTokenId`, `pickupDate`, and `customer` with
`name`, `email`, `phone` (E.164), `smsTransactionalConsent` (boolean). No amount,
currency override, prices, tax/fee, deadline, Order or Intent ID is sent. The deployed
API independently recomputes and validates all financial authority and freshness.

## Relay and security

The only upstream is `https://7otpu9y03a.execute-api.us-east-2.amazonaws.com`.
Its CORS configuration was inspected read-only and is null. No deployed CORS change is
needed. Local `/cart` performs the two described reads; `/start` forwards only the
strict payment-start contract. Redirects are rejected. Bodies are bounded; credentials
and upstream errors are never logged or returned. There is no access/request logging.
The relay holds request data only transiently; it does not load SSM or restricted keys.

Raw card input belongs exclusively to Stripe's cross-origin iframe. There are no
application card inputs, card-field handlers or raw-card forwarding. Strict schemas
reject additional fields before upstream forwarding. Capabilities are password inputs,
cleared after setup, and retained only in browser memory. No URL/query credentials,
localStorage, sessionStorage, IndexedDB, analytics or application error dumps are used.
The publishable test key is browser-visible by design; no actual key is committed.
Use only approved synthetic contact data. Do not record screenshots/network traces
that contain tokens or customer information, and do not copy Stripe error objects.

## Manual startup (C3A0 rendering only)

From repository root, with Node 24 and existing dependencies installed:

```sh
export NODE_ENV=development
read -r STRIPE_ACCEPTANCE_PUBLISHABLE_KEY
export STRIPE_ACCEPTANCE_PUBLISHABLE_KEY
unset STRIPE_ACCEPTANCE_ALLOW_START
node tools/stripe-acceptance/server.mjs
```

Paste the sandbox account's `pk_test_...` publishable key into the `read` prompt;
it is not a restricted key. Open `http://127.0.0.1:4242` (not a LAN address or tunnel).
With no authorized Cart, only the setup screen is available. Do not create a Cart
for C3A0. The local Pay button and `/start` are disabled by default, independently
of AWS's `PAYMENT_START_ENABLED=false`. No token is created on page load/setup.

## Exact C3A handoff — separate human authorization required

The human must supply the matching sandbox publishable key, an authorized fresh dev
Cart ID/capability, an approved contact fixture, and an available pickup selection.
Obtain these through the separately reviewed live acceptance procedure. Do not use a
historical terminal Cart or put capabilities in shell commands, logs, repository files,
or URLs. The sole file exception is the explicitly authorized temporary handoff below.

Only after C3A authorization and its admission/preflight gates, restart this local
process with `STRIPE_ACCEPTANCE_ALLOW_START=true`. This local switch does not enable
AWS admission and is not permission to do so. Load the Cart to obtain its ETag and
snapshot; enter the approved fixture; enter sandbox card details only inside Payment
Element; click Pay test once. Four-minute grace begins only upon accepted server start.
The confirmation response is displayed as accepted/unknown, never as paid.

The transport/controller separation permits later payment GET, action_required,
Stripe.js client-secret handling and `/payment/confirm` support. None is implemented
in C3A0. If customer action is required, stop and follow separately reviewed C3B
instructions; do not declare success from an accepted start response.

Keep the tab/process open on unknown outcome and replay only the identical request.
If the page/process is lost, stop for recovery review; do not generate another token.
Closing the tool does not cancel/release a Cart. Accepted financial responsibility
must be settled by the real backend recovery flow. Release unstarted test Carts only
through the separately authorized normal DELETE procedure, never manual data edits.

For cleanup after a settled outcome: close the tab, stop Node, and unset both local
Stripe acceptance environment variables. Remove the temporary capability handoff file
as soon as the human confirms successful loading into the harness; never retain it
as acceptance evidence.

## Validation

Run sequentially; all harness tests use mocked Stripe and upstream responses:

```sh
node --test tools/stripe-acceptance/acceptance.test.mjs
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
node --test tools/stripe-acceptance/artifact.test.mjs
```

The artifact tests inspect actual Next route manifests, production browser/server
bundles and backend build metadata. The harness is absent from the shipped routes
and artifacts. These tests require the normal backend build as well. Also run relevant
backend/artifact and infrastructure regressions, synth/read-only diff in separate
output directories, formatting and git diff --check. Expected AWS diff: none.

No real Stripe rendering/token success is claimed by mocked tests. Browser rendering
with the supplied test key and an authorized Cart, followed by real token/start
acceptance, remains the separately approved C3A live gate.

### Local validation results

- Harness mocks: 13 passed; production-exclusion artifact checks: 2 passed.
- Existing frontend: typecheck/build passed, 7 tests passed; output routes remain `/`
  and `/_not-found` only.
- Backend: 752 functional and 7 artifact tests passed.
- Infrastructure: 30 tests passed; isolated synth passed.
- Read-only diff against dev in us-east-2: no differences (0 stacks with differences).
- Formatting and git diff --check passed. Existing web/backend/infra/CI files unchanged.
- No real ConfirmationToken, PaymentIntent, Cart or Drop was created, and no payment
  start was submitted. Live SDK rendering remains part of the later authorized gate.

## Phase 5B2C3A1 — explicit deployment-time admission

Local patch pending review; no deployment or payment enablement is authorized here.
`PaymentStartEnabled` is a nonsecret CloudFormation String parameter with Default
`false` and AllowedValues `false` / `true`. Only the Application Lambda's
`PAYMENT_START_ENABLED` environment references it. Only literal `true` allows NEW
payment admission; accepted-payment recovery, settlement, webhook and reconciliation
remain independent of this flag.

CloudFormation normally preserves previous parameter values on updates. The default
is therefore NOT the relock mechanism. The normal/dev deployment path is the following
helper, which explicitly supplies false and uses `--previous-parameters true` to
preserve all other values, including `StripeSandboxAccountId`:

```sh
cd infra
npm run deploy:dev
```

Only during a separately reviewed and authorized acceptance window:

```sh
npm run deploy:dev -- --payment-start-enabled=true
```

Post-test relock must explicitly deploy false:

```sh
npm run deploy:dev -- --payment-start-enabled=false
```

The helper targets `batch-and-batter-dev`, profile `batch-and-batter-dev`, region
`us-east-2`. It always supplies `--parameters batch-and-batter-dev:PaymentStartEnabled=VALUE`;
it never infers true from environment variables or previous stack state. The ordinary
no-option helper also explicitly relocks false even after a prior true deployment.
Direct `npx cdk deploy` or CloudFormation console calls bypass this helper and MUST
likewise explicitly supply the flag; do not use an omitted parameter as a safety gate.
Do not use `--previous-parameters false`, which could reset unrelated configuration.

Each enable/relock still requires its reviewed read-only diff and live pre/post checks.
Configuration deployment is not an instantaneous global barrier: account for in-flight
requests and verify Lambda update completion and the live environment. Disabling NEW
admission must never stop recovery of payments already accepted.

## Phase 5B2C3A0B — safe local diagnostics

The localhost harness reports fixed stage codes and `payment/start sent: no`,
`yes`, or `ambiguous`. It never renders or logs raw Stripe/browser/backend errors,
contact values, card data, capabilities, token IDs, keys, or request headers.

| Boundary                                                           | Diagnostic                        | Start sent |
| ------------------------------------------------------------------ | --------------------------------- | ---------- |
| Setup / initialization                                             | HARNESS_SETUP_INVALID             | no         |
| Contact fixture validation                                         | HARNESS_CONTACT_INVALID           | no         |
| Pickup selection                                                   | HARNESS_PICKUP_INVALID            | no         |
| Expired or invalid Cart deadline                                   | HARNESS_CART_EXPIRED              | no         |
| Elements submission (returned error or throw)                      | HARNESS_ELEMENTS_SUBMIT_FAILED    | no         |
| ConfirmationToken preparation (returned error or throw)            | HARNESS_CONFIRMATION_TOKEN_FAILED | no         |
| Request construction or relay rejection before dispatch            | HARNESS_START_REQUEST_REJECTED    | no         |
| Backend HTTP rejection                                             | HARNESS_START_REQUEST_REJECTED    | yes        |
| Transport failure after dispatch or lost/unreadable relay response | HARNESS_START_REQUEST_AMBIGUOUS   | ambiguous  |
| Backend HTTP 5xx                                                   | HARNESS_START_REQUEST_AMBIGUOUS   | yes        |

`yes` confirms dispatch, not financial success. A 5xx response may follow committed
work, so it preserves ambiguous-outcome semantics. A `no` result does not prove
that no ConfirmationToken exists: request construction follows token preparation.
The immutable pending request remains available for identical replay; diagnostics
never authorize retries, another token, or another Cart. Follow the human-reviewed
acceptance procedure. No real Stripe objects are created by mock validation.

This change is local tooling only. It does not enable payment admission or change
production routes, backend code, infrastructure, or deployed bundles. Do not restart
an existing acceptance session merely to load new diagnostics; review its state first.

## Revised C3A capability handoff — human-approved temporary file

This procedure supersedes clipboard-only handoff. It does not authorize a new Cart
or admission enablement by itself. Keep admission false until the next acceptance
attempt is explicitly authorized.

Before creating a Cart, verify the localhost harness is already running with the
sandbox publishable key loaded locally, and obtain human confirmation that the
Payment Element is visible. Never display or request the key. Validate admin auth,
verify live admission false, and complete the queue/alarm/recovery and business-state
safety gate. Review the narrowly scoped true-enable diff, deploy the approved true
override, and verify live true BEFORE creating the single fresh Cart.

For that authorized Cart, retain the existing generated capability using this exact
handoff contract:

- Set `umask 077` before creating the file.
- Write only the capability bytes, without JSON, metadata, or a trailing newline, to
  `/tmp/batch-and-batter-acceptance-cart-capability` with mode `0600`.
- Create exclusively without following symlinks; if the path already exists, stop
  and review it without displaying its contents. Verify owner and mode before handoff.
- Never print/log the capability, interpolate it into a shell command, or add it to
  the repository. Clipboard copying is optional; this file is the reliable temporary
  copy until the human confirms loading it.
- Report only Cart ID, expiry, pickup, amount, and remaining time. Require at least
  six minutes remaining and stop for human checkout; never ask the human to rush.
- The human transfers the capability locally into the harness without sending it
  through chat. After the human confirms it was successfully loaded, immediately run:

```sh
rm -f /tmp/batch-and-batter-acceptance-cart-capability
```

Confirm removal without reading or displaying contents. Do not persist the file in
logs, evidence, backups, or repository files. If the attempt is abandoned or the Cart
expires before loading, remove the obsolete handoff file as part of cleanup and
verify normal expiry; do not reuse its capability or create a replacement Cart
without authorization. Explicitly relock admission false after the attempt, including
failed or abandoned attempts. Recovery infrastructure remains active.

## C3A2 confirmation compatibility

Historical C3A exposed an incompatibility between Elements ConfirmationTokens and the originally selected manual confirmation. The corrected contract is **automatic confirmation + manual capture**. Initial server confirmation still sends the accepted ConfirmationToken after binding, with deterministic durable command identity. Stripe.js handleNextAction continues authentication; /payment/confirm only wakes canonical reconciliation, without a second confirmation generation.

The immutable four-minute payment deadline still closes customer action admission. In-flight activity remains subject to canonical financial reconciliation; absence of a browser acknowledgment never proves absence of provider activity. Only exact canonical requires_capture establishes authorization. Capture requires durable claim and DISPATCHED authority; succeeded alone never means customer paid. Local atomic RESERVED-to-SOLD, CONVERTED, PAID and CAPTURED settlement remains required. Client secrets remain capability-protected, no-store, ephemeral, and absent from logs/work/receipts/URLs.

This local correction does not enable payments or authorize deployment. A new C3A attempt requires review and a separately authorized deployment of the corrected code; payment admission remains false.

## Final C3A successful-payment acceptance — human approved

**PHASE 5B2C3A SUCCESSFUL-PAYMENT ACCEPTANCE: PASSED**, with the two non-blocking verification limitations below. Human approval records the completed DEV acceptance on 2026-09-30; it does not authorize payment enablement, another payment test, or production rollout. Final live admission was verified as `PAYMENT_START_ENABLED=false`.

### Historical progression

The earlier failures remain part of the acceptance history:

1. Initial C3A exposed the incompatibility of Elements-collected payment details with `confirmation_method=manual`.
2. The contract was corrected to automatic confirmation plus manual capture.
3. Historical-read compatibility was corrected without rewriting historical payment contracts.
4. The existing payment successfully reached `requires_capture` authorization.
5. Its initial capture request was rejected because `final_capture` was unsupported.
6. Deterministic provider-rejection classification and explicit capture-generation recovery were added.
7. Recovery inventory checks were corrected to use Cart-owned reservations while permitting unrelated RESERVED and SOLD quantities.
8. Reviewed generation-2 recovery successfully captured the existing authorization.
9. Local atomic paid settlement completed.
10. Operational cleanup completed, including normal Drop closure and queue drain.

The C3A6 deployment used merged main `98290cb851b269d39368878abc5b07862891dbb9`. Only the five existing shared backend Lambda code assets changed; the downloaded deployed bundles matched main byte-for-byte. Admission remained false throughout recovery.

### Accepted business outcome

| Record         | Identifier                    | Final state |
| -------------- | ----------------------------- | ----------- |
| Cart           | `01M3SG458J6KZX8XXEKX66CZMK`  | CONVERTED   |
| Order          | `01M3SG7XS0RWTC731258PXVQQF`  | PAID        |
| PaymentAttempt | `01M3SG7XS0Z8CAQ35D48RZJH0P`  | CAPTURED    |
| PaymentIntent  | `pi_3ULPnZDz3QSwRsAl2cj9rK9p` | succeeded   |
| Drop           | `01M3RQJ2EHMWMB7CV8D028Z05G`  | CLOSED      |

Canonical Stripe retrieval verified sandbox (`livemode=false`), automatic confirmation, manual capture, **2625 cents received and 0 capturable**. Final inventory is **20 total / 0 reserved / 5 sold / 15 available**. Closing the Drop through the normal admin API returned HTTP 200 and did not change settled inventory.

### Recovery and settlement evidence

Generation 1 remains historical rejected-command evidence: HTTP 400 `invalid_request_error`, unsupported `final_capture`, and no successful financial effect. The approved original Stripe request ID is `req_4Gi6DNTC69VCiw`; six subsequent requests were previously Dashboard-confirmed replayed rejections. Classification preserved the original command identity and preparation/dispatch timestamps.

Generation 2 was explicitly prepared through the reviewed recovery method. Its corrected request omitted `final_capture`. PREPARED persisted at `2026-09-30T17:08:28.787Z`, DISPATCHED persisted at `17:08:31.137Z`, and canonical full capture was verified at `17:08:33.333Z`. The command remains OBSERVED, with generation 1 retained in history. One application capture dispatch was observed.

Exactly one PAID settlement marker is shared by the Cart, Order, and Attempt; exactly one PAID outbox exists. This Cart's five RESERVED units became SOLD once. No duplicate capture evidence, PAID conversion, or SOLD movement was observed. Concurrent processing produced one RETRY, then terminal COMPLETED / STALE_WORK outcomes rather than another financial mutation. The genuine `payment_intent.succeeded` webhook was durably accepted and its receipt reached PROCESSED.

### Operational and security cleanup

Final counts are visible / not-visible / delayed:

| Queue                       | Final counts |
| --------------------------- | ------------ |
| Reservation                 | 0 / 0 / 0    |
| Reservation DLQ             | 0 / 0 / 0    |
| Recovery-infrastructure DLQ | 0 / 0 / 0    |
| Payment                     | 0 / 0 / 0    |
| Payment DLQ                 | 0 / 0 / 0    |

All messages drained normally; no manual queue deletion was used. All 32 alarms were OK, including WorkerBatchFailures and RecoveryAge returning naturally to OK. Reconciler completion and recovery heartbeat were healthy. No unresolved PAYMENT, PAYMENT_WORKFLOW, relevant STRIPE_EVENT, captured-but-unfinalized, or stale generation-2 durable responsibility remained. Historical command records remain audit evidence, not outstanding work.

No sensitive-data matches were found in reviewed AWS logs. The temporary admin token and capability files were removed and their absence verified. A prior local diagnostic output inadvertently included a deterministic command identity; its output filter was corrected, and no value is reproduced here. This local reporting incident is distinct from the AWS-log review.

No new Cart, PaymentIntent, or PaymentAttempt was created during recovery. No refund, cancellation, restock, or SOLD reset occurred. Final `PAYMENT_START_ENABLED=false` was verified.

### Non-blocking verification limitations

1. **Customer payment GET was not exercised after settlement** because the original Cart capability was unavailable. No replacement capability was manufactured to satisfy the test. Domain/provider evidence established the terminal paid state; the customer HTTP check is not recorded as passed.
2. **Exact generation-2 Stripe capture request count and HTTP request-ID verification were not independently confirmed through the Stripe Dashboard.** Application evidence showed one capture dispatch and no duplicate financial effect. The independent Dashboard check is not recorded as passed.

Human review accepted both limitations as non-blocking. The successful path now has DEV evidence for ConfirmationToken ingestion → automatic confirmation → requires_capture authorization → durable manual capture → deterministic rejection recovery → canonical succeeded verification → atomic RESERVED-to-SOLD settlement → Cart CONVERTED → Order PAID → Attempt CAPTURED → durable webhook processing → queue/recovery cleanup.

## C3B1 — requires_action / 3DS readiness (local only)

This prepares a later, separately authorized single sandbox authentication-success attempt. It does not authorize deployment, admission enablement, Cart creation, or Stripe object creation. `PAYMENT_START_ENABLED` remains false. C3A's accepted evidence and limitations above remain unchanged.

### Existing backend contract and local correction

`POST /carts/{cartId}/payment/start` is asynchronous: HTTP 201/200 accepts the durable handoff and returns the safe Cart DTO; it does not synchronously promise a requires_action result or client secret. The localhost relay preserves that acceptance contract. After acceptance, the harness makes capability-authorized `GET /carts/{cartId}/payment` calls through a new local-only `/payment` relay. It polls at most 30 times with one second between reads; individual upstream requests retain the existing 15-second timeout. Poll exhaustion reports processing and requires human review, never another token or start.

The backend GET returns `payment.status=action_required`, an ephemeral `clientSecret` when canonical Stripe still requires action, the immutable `paymentDeadline`, `continuationGeneration`, and the payment-specific ETag. Capability authorization precedes retrieval. Both API and local relay responses remain no-store. The relay explicitly projects these fields and does not forward raw upstream errors or other provider fields.

The harness calls exactly `stripe.handleNextAction({ clientSecret })`, supported by the hosted Dahlia Stripe.js used here. See [Stripe handleNextAction](https://docs.stripe.com/js/payment_intents/handle_next_action) and [server-finalized payments](https://docs.stripe.com/payments/finalize-payments-on-the-server?platform=web&type=payment). Submission stays locked while the call is pending. Browser-returned Intent state is not financial authority. The secret is used only in memory, removed from the local status object after the call, and never placed in application navigation, storage, logs, request URLs, or continuation bodies. This readiness scope is the embedded card authentication flow; redirects/reloads do not reconstruct a payment session automatically.

After successful authentication, the harness rereads backend status for a fresh ETag. If it remains actionable and before deadline, it sends one local `/confirm` request relayed to `POST /carts/{cartId}/payment/confirm`, with the existing capability, fresh payment ETag, one new continuation idempotency identity, and only `continuationGeneration` in the API body. If a webhook has already advanced the payment, the harness reports the backend state instead of submitting an unnecessary stale continuation.

**Automatic confirmation means no second server confirmation after next_action.** The existing backend continuation verifies capability, ETag, generation, deadline, and canonical association; it atomically records its receipt and wakes VERIFY_AUTHORIZATION. It does not append another CONFIRM command, call provider confirm, extend the deadline, or create another Intent. The harness never automatically replays an ambiguous continuation, repeats authentication, or creates another token/Cart. The backend retains its existing identical-request replay semantics.

### Canonical state and deadline behavior

| Canonical state after action                   | Existing backend behavior                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| requires_capture with exact amount             | AUTHORIZED / CLAIM_CAPTURE; existing durable manual capture path                                                                                  |
| processing                                     | VERIFY_AUTHORIZATION and reconciliation; no capture without authorization proof                                                                   |
| requires_payment_method with confirmed failure | Select safe cancellation/failure resolution; no SOLD movement                                                                                     |
| canceled                                       | Canonical cancellation proof permits failure settlement                                                                                           |
| requires_action                                | WAIT_FOR_CUSTOMER_ACTION; actionable only while admission/deadline permits; harness stops for review rather than repeating action                 |
| succeeded                                      | Existing capture-evidence/settlement rules apply; without matching dispatched capture authority, recovery is required, never browser-derived PAID |

The original four-minute paymentDeadline is immutable. Before it, successful browser action may wake verification. At or after it, new customer continuation is rejected and no action secret is returned. The harness checks the deadline before authentication and again before continuation. If authentication remains open or returns late, backend canonical reconciliation still owns the outcome. Provider processing/unknown financial state retains RESERVED responsibility; missing browser acknowledgment is never release proof. Existing canonical authorization, capture claim, cancellation verification, and bounded recovery rules remain authoritative.

### Safe diagnostics

New fixed codes are HARNESS_NEXT_ACTION_UNAVAILABLE, HARNESS_AUTHENTICATION_FAILED, HARNESS_CONFIRM_REQUEST_REJECTED, HARNESS_CONFIRM_REQUEST_AMBIGUOUS, HARNESS_PAYMENT_DEADLINE_ELAPSED, HARNESS_PAYMENT_PROCESSING, HARNESS_PAYMENT_STATUS_UNAVAILABLE, HARNESS_ACTION_INCOMPLETE, and HARNESS_PAYMENT_TERMINAL_FAILURE. All post-start diagnostics explicitly say start was already accepted and warn against creating another Cart/token after ambiguity. Raw Stripe exceptions, contact values, card data, capabilities, client secrets, and request identities are not rendered or logged. An ambiguous continuation does not imply an ambiguous initial start: start remains accepted.

### Later human acceptance procedure — not authorized by C3B1

1. Obtain separate live C3B approval. Stage the localhost harness, sandbox publishable key, local submission, Payment Element, approved contact fixture, and valid admin authentication before creating a Cart. Complete the live responsibility/queue/alarm gate with admission false.
2. Through the separately reviewed sequence, temporarily enable admission and create exactly one fresh Cart on a valid OPEN test Drop. Use the approved mode-0600 temporary capability handoff and require at least six minutes remaining. Remove the handoff file once loaded.
3. The human types Stripe's documented authentication-required sandbox card (obtain its number directly from the linked Stripe testing guidance), a future expiration, valid CVC, and any postal code directly into Stripe Payment Element. These values belong only in the human procedure, never application code, fixtures, logs, or automated requests. See [Stripe testing guidance](https://docs.stripe.com/testing).
4. Click Pay once. After payment/start acceptance, the harness polls for action_required and opens Stripe authentication UI. Complete successful authentication in that UI.
5. The harness refreshes status and calls the continuation endpoint once if still necessary. The same Intent continues automatically to requires_capture; no second server confirmation is issued.
6. Observe canonical authorization, the existing durable capture path, canonical full success, and atomic PAID settlement. A browser completion or accepted continuation is not proof of payment.
7. Verify Cart CONVERTED, Order PAID, Attempt CAPTURED, exact RESERVED-to-SOLD movement, one PAID outbox, genuine webhook processing, and cleared durable work. Close the test Drop normally only after settlement, without resetting SOLD.
8. Explicitly relock admission false and verify it, regardless of outcome. Perform the reviewed token/capability/harness cleanup and queue/alarm checks. Any diagnostic, ambiguity, additional action, or deadline issue stops the human attempt for review; no automatic new Cart/token/payment is allowed.

## Final C3B successful 3DS acceptance — human approved

**PHASE 5B2C3B SUCCESSFUL 3DS AUTHENTICATION ACCEPTANCE: PASSED**, with the non-blocking browser-counter limitation below. The successful payment occurred on 2026-09-30; normal operational cleanup completed on 2026-10-01. This record does not authorize another payment, payment enablement, or production rollout. Final live `PAYMENT_START_ENABLED=false` was verified.

### Historical C3B attempts remain failed

The earlier C3B2 attempt used Cart `01M3SXJXZAKW7H5ZYH744BC04P`, Attempt `01M3SXVZFPYFDX112ERHP468CF`, and Order `01M3SXVZFP5CG8A3R3Q98N4DNA`. A stale localhost server lacked the new payment-status route even though newer browser files were present. It did not complete 3DS or settle PAID. Normal expiry canceled the provider Intent and left Cart, Order, and Attempt EXPIRED, with zero received and inventory 20 / 0 / 0 / 20. It is not reclassified as successful.

The subsequent transport investigation found stale WORKFLOW revision 18 in the payment DLQ. Its original failure cause remained unproven. C3B2D added transport telemetry; C3B2E deployed it with admission disabled. The first targeted cleanup failed locally while parsing CLI input, before deletion. Separately authorized C3B2F verified and deleted only MessageId `43beb7e7-934b-4b39-8978-a94f2a1d1a7c`; queues emptied and all 32 alarms recovered. These historical transport events are separate from the successful payment below.

C3B3 initially stopped at `STOREFRONT_OCCUPIED`. Human-authorized closure of historical Drop `01M3SXE9BX594ZDGBD8A2QG1EP` allowed the already-created fresh Drop to publish. Cart `01M3T25ZH233JEX9KV52S408D7` was not submitted for payment because too little reservation time remained. Admission was relocked, normal expiry returned all inventory, and no Order, Attempt, payment/start request, or Stripe Intent was created for that Cart. Only after the clean baseline and separate human approval was the following replacement Cart created.

### Successful business outcome

| Record         | Identifier                    | Final state |
| -------------- | ----------------------------- | ----------- |
| Cart           | `01M3T39RTM449TF7HE14QDGMA2`  | CONVERTED   |
| Order          | `01M3T3EEJ1EJFGX48W35AQ7Y1W`  | PAID        |
| PaymentAttempt | `01M3T3EEJ1PH9JBXZS2A72YHVT`  | CAPTURED    |
| PaymentIntent  | `pi_3ULV2MDz3QSwRsAl2b1xljBx` | succeeded   |
| Drop           | `01M3T1XK2FK6F7YBH24WYWV4TE`  | CLOSED      |

Canonical Stripe retrieval verified `livemode=false`, `confirmation_method=automatic`, `capture_method=manual`, 2625 cents received, 0 capturable, and no next_action. One successful capture and one local PAID settlement produced one five-unit RESERVED-to-SOLD conversion: **20 total / 0 reserved / 5 sold / 15 available**. One PAID outbox was present. No duplicate confirmation command, capture financial effect, PAID settlement, or SOLD movement was observed; this is financial-result evidence rather than an independent count of Stripe HTTP requests.

### 3DS and continuation evidence

Exactly one payment/start request was logged as accepted with HTTP 201, request ID `EiC_DixdiYcEPUw=`. The durable ledger contains one initial server confirmation command, generation 0, OBSERVED. The pre-authentication checkpoint retrieved canonical `requires_action`, Attempt AUTHENTICATING, and workflow WAIT_FOR_CUSTOMER_ACTION on the same Intent, with no capture command and inventory still reserved. The customer-safe action_required projection and capability-authorized, no-store client-secret path were verified; successful status GETs and the visible challenge corroborated the path without exposing the secret.

The human completed one visible Stripe 3DS challenge. There was no second server confirmation command and zero `/payment/confirm` requests. Webhook-driven authorization made explicit continuation unnecessary. The same Intent reached requires_capture, the backend recorded AUTHORIZED, and the existing durable manual-capture path completed.

All times below are UTC on 2026-09-30:

| Evidence                                      | Time             |
| --------------------------------------------- | ---------------- |
| Authorization webhook receipt                 | 21:30:55.911     |
| requires_capture / AUTHORIZED observed        | 21:30:56.527     |
| Capture generation 1 PREPARED                 | 21:30:56.939     |
| Capture DISPATCHED                            | 21:30:57.239     |
| Capture OBSERVED / canonical success verified | 21:30:58.871     |
| Atomic settlement timestamps                  | 21:30:59.604–606 |
| Immutable payment deadline                    | 21:31:35.232     |

Settlement completed approximately 35.6 seconds before the deadline. Exact browser challenge-completion time was not recorded. Durable PROCESSED receipts exist for `payment_intent.amount_capturable_updated` and `payment_intent.succeeded`; canonical provider state remained authoritative. No unresolved PAYMENT, PAYMENT_WORKFLOW, or relevant STRIPE_EVENT responsibility remained.

### Transport evidence

Each listed post-authentication delivery had receiveCount 1 and belonged to the successful Attempt above:

| MessageId                              | Revision | Outcome / disposition |
| -------------------------------------- | -------- | --------------------- |
| `82553592-d5ff-4347-ba1f-4457b9443a0d` | 19       | CLAIMED / ACK         |
| `94cad922-2b04-4f46-9493-c9fbde90541f` | 20       | RECONCILED / ACK      |
| `e9f2c5b8-ffcc-4245-9779-f6841dfe3ea8` | 21       | STALE_WORK / ACK      |
| `7eb973d3-52e2-499c-815e-75e26b17e7ed` | 22       | SETTLED / ACK         |
| `238dcb60-c0f3-4d3d-958e-c1f584231c24` | 18       | STALE_WORK / ACK      |
| `d4905f5c-6784-4c51-aa83-7d1c1f3f7138` | 0        | STALE_WORK / ACK      |

Earlier message `06eeaa35-40b5-40d1-940c-e70aa9014e59` initially returned RETRY, then was received again with receiveCount 2 and ACKed as STALE_WORK at 21:30:41.078, before authorization. Its original RETRY cause was not established. No post-authentication RETRY appeared in the reviewed deliveries.

### Cleanup and non-blocking limitation

Normal authenticated admin closure returned HTTP 200 and left the C3B Drop CLOSED without changing inventory 20 / 0 / 5 / 15. No refund, restock, SOLD reset, manual capture/cancellation, or manual application-data repair occurred. Reservation, reservation DLQ, recovery-infrastructure DLQ, payment, and payment DLQ each reported 0 visible / 0 invisible / 0 delayed. All 32 alarms were OK. Admission was explicitly relocked and verified false.

The temporary admin token was deleted, the capability handoff file was absent, and the localhost harness was stopped. Stopping its process removed its process-local acceptance variables; task-local copies were unset. Variables in a separate human-owned terminal cannot be unset by this task and must be cleared there if retained. No secret values are included in this record.

**Non-blocking limitation:** no independent numeric `handleNextAction` invocation counter was recorded. Evidence comprises the harness's one-entry guard, the human's one visible challenge completion, one Intent, one initial server confirmation command, no second confirmation command, and no duplicate financial effect. The invocation count is not described as independently measured.

The harness displayed `HARNESS_PAYMENT_PROCESSING` because its post-authentication status refresh occurred before settlement and that path stops polling. This intermediate browser result did not prevent successful backend settlement and was not treated as financial authority.

C3B proves the reviewed path: ConfirmationToken → one automatic server confirmation → requires_action → safe client-secret delivery → browser 3DS → webhook-driven continuation without a second server confirmation → same Intent requires_capture → durable manual capture → canonical succeeded → atomic PAID settlement → queue/recovery cleanup.
