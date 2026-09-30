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
historical terminal Cart or put capabilities in shell commands, files or URLs.

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
Stripe acceptance environment variables. No persisted capability file is created.

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
