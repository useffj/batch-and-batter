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
