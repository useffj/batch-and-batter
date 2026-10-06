# Phase 9A — customer checkout contract review

## Final human-reviewed hosted UI disposition — 2026-10-06

**PHASE 9A HOSTED CHECKOUT UI ACCEPTANCE: PASSED — PAYMENT SUBMISSION LOCKED.**

This separate final disposition records human review of the Job 7 hosted evidence.
It supersedes the earlier NOT PASSED hosted-UI dispositions below without erasing
those observations or the implementation and acceptance history. No application
code change is required by this decision. This closeout is documentation-only;
commit, push, deployment, configuration changes, payment enablement and live
AWS/Stripe/Cart/Drop mutations are not authorized as part of it.

Accepted main: `7a293a77bf63ddfefd5f0f8a5064ba08bccdda06`.
Accepted deployment/artifact: **Amplify Job 7**.
Artifact SHA-256:
`1bcb038d98f3766eb19f6e1774f1c7ab6d1cbc346383ecc2b67f9e8db37dfcdd`.
The accepted Job 7 artifact-security review was not repeated for this hosted UI
review because the serving revision and configuration remained unchanged.

### Keyboard and focus interpretation

Observed forward traversal:

Name → Email → Phone → Pickup → SMS consent → Stripe Card number → Expiration →
CVC → Country → ZIP → parent document → Stripe Card number again.

Observed reverse traversal: **Shift+Tab from Stripe returned to SMS consent**.
Keyboard focus was therefore demonstrably able to leave the Stripe component:
forward traversal reached the parent document, and reverse exit succeeded using
standard keyboard navigation. Stripe was not demonstrated to trap keyboard focus.
The observed browser/Stripe/automation cycle is not a confirmed application defect.

Human review determined that requiring forward Tab to reach a subsequent
application-owned control was too strict for this locked checkout state. Pay is a
native disabled control, intentionally excluded from sequential keyboard focus.
Express Checkout is intentionally not mounted while submission is locked. There
is therefore no guaranteed focusable application-owned payment control following
the Payment Element. This qualification does not claim that forward traversal to
other application navigation controls was demonstrated.

**Future enabled-mode acceptance item:** when `CHECKOUT_SUBMISSION_MODE=enabled`
and Pay is a legitimate interactive/focusable target, verify Stripe Payment
Element → forward keyboard exit → enabled Pay / appropriate next application
control. This belongs to separately controlled payment-enabled sandbox acceptance
and does not block the locked hosted-UI acceptance recorded here.

Hosted application accessibility evidence **PASSED**: visible focus on
application-owned controls; keyboard-usable customer fields, pickup selection and
SMS consent; native validation identifying and focusing the invalid pickup field
with understandable feedback; and background polling preserving phone-field focus
and continued typing. Locked Pay was visibly and semantically disabled. This is
not exhaustive accessibility certification of Stripe-hosted iframe internals or
final Phase 25 accessibility certification.

### Phone and locked-payment evidence

The final hosted phone UX **PASSED**: a fixed noneditable +1 prefix beside ten
visible national digits, no automatic punctuation, sanitization of formatted and
already-prefixed +1 pastes, and rejection of short, long, letter-containing and
unsupported international-prefix input. Accepted deployed-code evidence confirmed
normalization to the existing backend +1 E.164 contract without starting payment.
The NANP country-allocation limitation remains: +1 syntax does not independently
prove that a number belongs to a U.S. allocation rather than another NANP territory.

Before and after the hosted acceptance:

- `CHECKOUT_SUBMISSION_MODE=locked`.
- `PAYMENT_START_ENABLED=false`.
- Automatic builds remained disabled.

Pay was visibly and semantically disabled; pointer and keyboard interaction
produced no payment. No actionable Express Checkout control was mounted. Refresh
preserved the same Cart and shopping deadline, fixed +1 UX and submission lock.
No payment deadline was created, and checkout use did not move the Cart into
PAYMENT_PENDING or PAYMENT_COMMITTING. No financial workflow began.

| Acceptance-window financial activity | Count |
| ------------------------------------ | ----: |
| Payment-start requests               |     0 |
| ConfirmationTokens                   |     0 |
| PaymentIntents                       |     0 |
| Paid Orders                          |     0 |
| Task-caused payment-worker events    |     0 |
| Task-caused Stripe webhook events    |     0 |

These results are supported by the locked UI, observed browser request evidence,
authoritative commerce state and reviewed API/worker/webhook logs. Global Stripe
inventory was not queried, and no card details or wallet payment were entered.

### Cleanup, health and exposure

The single controlled DEV Drop `01M48W19BV19C26RYEVHGZ2WRX` ended **CLOSED**.
The single customer Cart `01M48W52P901FVANTF369HCZSK` ended **CANCELLED** after
removing its final item through the normal UI. Final inventory was **20 total / 0
reserved / 0 sold / 20 available**. The session cleared, no replacement Cart was
created, the storefront pointer was released, and no unexpected external activity
was observed.

Final operational health: all seven queues/DLQs empty, all 32 alarms OK, recovery
heartbeats current, and no unresolved Cart or payment responsibility. The delayed
shopping-expiry message drained after the original deadline before final health
was accepted.

Targeted responsive evidence at **320 / 375 / 390 / 1280 px** showed no horizontal
overflow and a usable national-number field beside its fixed prefix. localStorage,
sessionStorage and first-party IndexedDB were empty. Contact data was absent from
the URL, and no Cart-capability exposure was observed. Reviewed application,
runtime and API logs had no sensitive findings. Responsive evidence was targeted,
not exhaustive per-width accessibility certification.

An initial inspection snapshot displayed a Stripe URL containing the public
Stripe publishable-key configuration. That value was not a Stripe secret or
restricted key. Subsequent evidence redacted URLs. Future acceptance evidence
must continue redacting publishable-key-bearing URLs even though the publishable
key is browser-public by design. No actual key value is recorded here.

### Phase status and remaining gates

| Scope                                   | Final disposition                  |
| --------------------------------------- | ---------------------------------- |
| Phase 9A local implementation           | COMPLETE                           |
| Phase 9A deployment/artifact acceptance | PASSED — Job 7                     |
| Phase 9A hosted checkout UI acceptance  | PASSED — PAYMENT SUBMISSION LOCKED |
| Governing Phase 9                       | NOT COMPLETE                       |

Still outstanding, under separate approval and acceptance:

- Payment-enabled hosted acceptance, including the enabled-mode keyboard recheck.
- An ordinary sandbox payment through the customer site.
- Customer-site requires_action / 3DS acceptance.
- Decline/abandonment acceptance as separately approved.
- Express Checkout / Apple Pay / Google Pay configuration and device acceptance.
- Governing later Phase 10/11 gates.
- Production pricing authority.
- CSP hardening.
- Broader accessibility certification, including final Phase 25 requirements.

Live payment and wallet acceptance remain separate. This human-reviewed locked-UI
disposition does not mark governing Phase 9 fully complete.

## Historical implementation and acceptance record

The statuses and baselines below describe their respective earlier review stages.
The final human-reviewed disposition above is the current locked-UI status.

Status: hosted checkout UI acceptance is **NOT PASSED**: complete live keyboard
exit and visible-focus evidence remains incomplete. Repository finalization
(commit, branch push and PR) is human approved. Deployment, Amplify builds,
payment enablement and AWS/Stripe/live Cart/Drop mutation remain unauthorized.

Starting main: `a28bcc8bbb22e39d671b9b714e483cbeca947047`.
Branch: `codex/phase-9a-simple-phone-entry`.
Current accepted deployment/artifact baseline: Job 6, SHA-256
`e8620d88a8de27d7a4f04df52d4624dd006b3281ece1d887b88728a9fe60e6a2`.
Job 6 artifact acceptance passed; hosted UI acceptance remains NOT PASSED.
Historical Job 4/5 results below remain unchanged.

## Simple national phone entry follow-up

The intended phone control has one accessible label, “Mobile phone — United
States (+1)”, and a separate non-editable +1 prefix hidden from accessibility APIs
to avoid duplicate announcement. The editable telephone field uses a numeric
keyboard hint and national-number autocomplete. It displays only national digits,
never visual punctuation formatting. Complete accepted entries contain exactly ten
digits; before payment-start the existing client normalizer produces +1 E.164.
Backend validation is unchanged.

Formatted paste/autofill such as `(303) 555-0123`, `303-555-0123` or
`+1 303 555 0123` is sanitized to `3035550123`. Digit paste respects the selection.
Partial digits remain editable but cannot validate for submission. Excess digits,
letters and unsupported international prefixes are rejected rather than truncated
or silently reinterpreted; the previous value remains, with custom validity and
associated visible, politely announced error text until corrected. The normal
instruction is “Enter a 10-digit U.S. phone number.”

No country selector or dependency is added. NANP formatting does not independently
distinguish U.S. numbers from other +1 territories. Contact data remains transient;
submission locking, existing-payment recovery and polling focus behavior remain
unchanged. A later approved deployment and complete hosted keyboard/visible-focus
verification are still required.

Local validation for this follow-up: 302 frontend tests, 2 frontend
production-exclusion tests, 902 backend tests, 7 backend artifact tests and 34
infrastructure tests passed. Frontend/backend/infrastructure typechecks, frontend
lint, production build, repository formatting, offline infrastructure synthesis
and `git diff --check` passed; backend dependency audit reported zero
vulnerabilities. Existing submission-lock, same-payment recovery and polling
regression tests remain passing. These automated results do not close the
outstanding hosted keyboard/visible-focus evidence requirement.

## Local checkout submission lock follow-up

Most hosted rendering, pricing, restoration, privacy, inventory-release and
operational checks succeeded. However, Pay remained enabled while backend payment
admission was locked, and complete keyboard/focus acceptance was not established.
These results do not mark hosted acceptance passed.

`CHECKOUT_SUBMISSION_MODE` is a server-side secondary UI safety gate. Only the
exact value `enabled` allows new submission; `locked`, missing and invalid runtime
values project `paymentSubmissionAllowed: false`. The SSR helper accepts only
`locked` or `enabled` when configured and rejects invalid build configuration
without writing an environment file. Missing configuration stays absent and
therefore locked. Neither the raw setting nor `PAYMENT_START_ENABLED` is projected
to customers. This gate is not financial authority: `PAYMENT_START_ENABLED`
remains the unchanged backend authority, including when the UI gate is enabled.

Locked checkout retains contact/pickup fields, pricing, summary and Payment
Element rendering. Pay is a native disabled submit button associated through
`aria-describedby` with “Payments are temporarily unavailable.” It never uses a
fake loading label to communicate the lock. Interactive Express Checkout is not
mounted while locked; enabled mode preserves its existing integration/options.
Form submission stops before validation/Stripe delegation when locked. The
checkout client also checks both the displayed projection and a fresh relay read
before Elements submission, token creation or start. The server relay rejects
new starts while locked, including a stale enabled client. Reads and recovery of
an already admitted payment remain available; the lock does not abandon existing
payment responsibility.

Approval checklist: locked mode never calls `handleNextAction` unless recovering
an already-admitted same-PaymentIntent `requires_action` state (represented as
`action_required` by the backend checkout contract). Recovery uses only the
backend-provided existing intent client secret, rereads authoritative status after
authentication, and can wake reconciliation for the same attempt. Browser action
success cannot mark PAID. It cannot create a token, new intent or replacement
attempt. New submission stays locked throughout recovery; backend admission need
not be re-enabled to finish an already-admitted payment. Focused tests cover both
locked unadmitted checkout and locked existing-payment authentication.

The explicit SSR allowlist now consists only of:

- `STOREFRONT_API_BASE_URL`
- `STOREFRONT_CURRENCY`
- `CHECKOUT_PRICING_MODE`
- `CHECKOUT_SUBMISSION_MODE`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

No wildcard or unrelated public-variable propagation is introduced. Existing
secret exclusion, cookie/session, pricing and backend admission contracts remain.

Background status polling previously disabled the contact fieldset, potentially
interrupting keyboard focus every five seconds. Only an actual submission now
disables that fieldset. Native control order, labels, optional consent, pickup
selection, name/phone constraints, phone-help association and visible focus styles
remain intact. Native `reportValidity` provides validation and invalid-field
focus before enabled submission. The disabled Pay explanation is visible even
though native disabled buttons are skipped in keyboard navigation.

Local tests cover the gate, server projection, stale-client locking, real form
handler guards, rendered native disabled semantics, mocked enabled Pay/Express
flows and polling focusability. Node form-handler tests do not certify browser
keyboard navigation or Stripe iframe accessibility. Any local browser smoke uses
mocked Stripe components, with no external financial calls. Real Stripe iframe
inspection and complete hosted keyboard/focus verification remain bounded and
require a fresh hosted review.

Earlier repository-finalization validation: 283 frontend tests passed, plus 902
backend regression tests, 7 backend artifact tests, 2 frontend production-exclusion
tests and 34 infrastructure tests. Offline infrastructure synthesis also passed. Typecheck, lint, production
build, repository formatting and `git diff --check` passed. The production browser
chunks contain none of `CHECKOUT_SUBMISSION_MODE`, `CHECKOUT_PRICING_MODE` or
`PAYMENT_START_ENABLED`; server configuration is represented to the client only
by the strict boolean projection, not the raw mode value.

A localhost smoke of the actual checkout component with synthetic Cart data and
mocked Stripe verified name → email → phone → pickup → optional consent keyboard
order, focus retained across background polling, keyboard pickup selection,
Space toggling consent with a visible focus outline, and disabled Pay skipped in
tab navigation. Enabled-mode empty-form activation focused Name and displayed
native required-field feedback. These observations cover application-owned
controls only, not real Stripe iframe internals or hosted deployment acceptance.
No actual provider or payment-start requests were made by this smoke.

The earlier redaction miss originated in external acceptance inspection tooling,
not repository application/tooling code. No unrelated application change was
made for it. Future inspection must redact all cookie values/identifiers,
capabilities, admin tokens and provider secrets before output; retain only safe
metadata and comparison results.

A future deployment requires separate human approval, a new build and independent
artifact-specific security acceptance, including SSR propagation, boolean-only
projection, browser-bundle exposure, locked UI/Express behavior, keyboard/focus,
network/log safety and backend admission remaining false. Job 5 is not acceptance
evidence for this new code. Hosted acceptance remains **NOT PASSED**.

## Earlier U.S. phone input follow-up (superseded visible-entry UX)

The phone field labels the fixed country context “United States (+1)” and accepts
10-digit input with ordinary punctuation/spacing or an already prefixed +1 value.
The client normalizes it before the existing E.164 payment-start contract;
backend validation is unchanged. Unsupported explicit country prefixes receive a
specific native validation message. No country selector or dependency was added.
There is no existing geographic phone metadata utility: this validates NANP
syntax, not U.S. allocation, residence, mobile status or ownership. Canadian and
other NANP numbers cannot reliably be distinguished by this implementation.
Hosted acceptance remains NOT PASSED.

## Existing HTTP contracts

The production handler delegates three fixed routes to `localPaymentApi`, constructed
with `PaymentRepository` and `PaymentCustomer`. The historical function name does
not mean these routes are absent from the current production handler.

| Route                                  | Input                                              | Successful response                     |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| POST `/carts/{cartId}/payment/start`   | Strict `{confirmationTokenId,pickupDate,customer}` | 201 `{cart}`; no response ETag          |
| GET `/carts/{cartId}/payment`          | No body                                            | 200 `{payment}` and payment ETag        |
| POST `/carts/{cartId}/payment/confirm` | Strict `{continuationGeneration}`; integer 1–7     | 202 `{accepted:true}`; no response ETag |

All require `X-Cart-Token`, a canonical 32-byte base64url Cart capability, hashed
server-side and checked against Cart authority. Both POSTs require a quoted
64-lowercase-hex `If-Match` and timestamped `Idempotency-Key` of the form
`v1.<13-digit epoch milliseconds>.<43 canonical base64url characters>`.
Start uses the Cart ETag; continuation uses the payment ETag, which includes Cart
and Attempt revisions plus execution revision. GET returns no-store; so do POSTs
and errors. POST bodies are bounded to 16,384 characters at the backend boundary.
A frontend relay must additionally enforce a byte bound while streaming.

Start input matches the requested fields exactly. Customer name is trimmed,
1–200 characters; email uses Zod `z.email()` and maximum 254 characters; phone
matches `^\+[1-9]\d{7,14}$`; `smsTransactionalConsent` is a required boolean and
may be false. The object rejects unknown fields. ConfirmationToken ID matches
`^ctoken_[a-zA-Z0-9]+$` with maximum total length 255. Pickup date uses Zod `z.iso.date()`.
No browser amount, currency, tax, fee, deadline, Order ID or Intent ID is accepted.

Start fingerprints Cart ID, token ID, pickup date, normalized customer and exact
If-Match. Matching receipt replay returns the original accepted Cart, including
Attempt/Order identities and deadline. Conflicting reuse returns an idempotency
conflict. New keys expire after 24 hours and may be at most five minutes ahead.
Receipt lookup precedes disabled-admission rejection. A competing accepted start
cannot allocate a second winning payment or restart grace.

Token retrieval must return the requested identity, sandbox mode, unexpired card
submission, and no existing PaymentIntent or SetupIntent consumption. The provider
adapter also rejects future-use setup. An atomic token-ownership record binds the
accepted submission to its Attempt. The backend owns amount, capture and payment
method configuration. Automatic confirmation and manual capture are authoritative.

Start validates ACTIVE Cart, unexpired shopping deadline, OPEN/current Drop,
revision, pickup activity and pickup window not ended in its own timezone. Same-day
pickup remains eligible until its published end. Location/instructions come from
Drop META; hours and timezone come from the chosen pickup record. The handoff
freezes Order items, customer, pickup and financial totals.

The accepted Cart exposes Cart/drop IDs, state, creation/update/shopping timestamps,
reserved items `{productId,quantity,priceCents,cookieUnits}`, one-use grace,
`paymentStartedAt`, immutable `paymentDeadline`, Attempt/Order IDs, and committing
timestamps when applicable. The payment deadline is sampled after token validation
and is exactly 240,000 ms after payment start. Merely reading/opening checkout does
not start it.

Payment GET exposes only `orderId`, `paymentAttemptId`, `status`, `paymentDeadline`,
`continuationGeneration`, and optional transient `clientSecret`. States are
`payment_pending`, `processing`, `action_required`, `paid`, `failed`, `expired`,
and `cancelled`. It does not expose frozen Order lines, pickup or financial totals.
A pre-payment Cart with no executable Attempt returns `CART_CONFLICT`, not a null
payment. Frontend recovery must account for that distinction.

`paid` requires Cart CONVERTED and Attempt CAPTURED. Provider/browser success alone
is insufficient. Action secret retrieval additionally requires automatic
confirmation, PAYMENT_PENDING, open admission for that Attempt, no recovery flag,
current time before the immutable deadline, and WAIT_FOR_CUSTOMER_ACTION. Legacy
manual-confirmation responsibility is non-actionable processing. The secret is
not persisted in workflow/receipts. Browser handling must remain transient.

Continuation validates current payment ETag and existing confirmation count,
canonical Intent association/configuration, observed initial confirmation and
WAIT_FOR_CUSTOMER_ACTION/VERIFY_AUTHORIZATION. It wakes VERIFY_AUTHORIZATION on the
same Intent; it does not perform another normal confirmation, create an Attempt,
create an Order or extend the deadline. After `handleNextAction`, authoritative
GET must determine the customer state. C3B accepted webhook-driven continuation
without a second server confirmation.

Relevant errors: VALIDATION_ERROR/INVALID_PICKUP_DATE 400; UNAUTHORIZED 401;
RESERVATION_EXPIRED 410; PAYMENT_ALREADY_STARTED, CART_CONFLICT,
IDEMPOTENCY_CONFLICT, IDEMPOTENCY_KEY_EXPIRED, DROP_NOT_OPEN,
STOREFRONT_CONFLICT, PRODUCT_NOT_AVAILABLE, INSUFFICIENT_INVENTORY and
QUANTITY_LIMIT_EXCEEDED 409; CART_BUSY/PAYMENTS_DISABLED 503; INTERNAL_ERROR 500.
Unexpected workflow/provider exceptions are projected to INTERNAL_ERROR by the HTTP
handler. A frontend must not expose upstream messages, request IDs or raw errors.

## Human-approved DEV pricing boundary

The pricing decision was explicitly human-approved after the initial contract
review. `CHECKOUT_PRICING_MODE=dev-zero-tax-fee` is a server-only gate in
`web/src/lib/checkout/pricing.ts`. Both this exact mode and the existing
`STOREFRONT_CURRENCY=USD` are required. Missing, unsupported or inconsistent
configuration returns no summary and prevents payment start. No zero-tax fallback
exists. No environment value or real key was added to a repository environment
file; no Amplify setting or environment allowlist was changed.

Cart `priceCents * quantity`, using safe-integer checked arithmetic, supplies each
line and subtotal. Current catalog prices never replace reserved prices. Tax and
fees are exactly zero only under this explicit approved gate. Displayed total is
subtotal. Stripe's card presentation bounds (50–99,999,999 cents) also fail closed.
The customer sees Subtotal, Tax, Fees and Total, plus selected pickup hours,
timezone, location and instructions. No implementation jargon is added to the form.

This is a DEV-only presentation projection, not financial authority. The same
projection supplies deferred Payment Element and Express Checkout display amount
and currency. The payment-start body is still exactly the existing contract;
no amounts/currency/tax/fees are submitted. Backend payment and settlement remain
authoritative. No backend implementation changes were made.

**Production pricing gate:** this DEV-only zero-tax/zero-fee projection MUST NOT
be treated as the final production pricing architecture. Before production commerce
where policy differs from reserved Cart subtotal, an authoritative server-side
checkout quote/preview contract or equivalent approved backend authority is required.
Production readiness must not rely on browser-calculated financial totals.

Payment GET has no frozen Order summary/pickup projection. Therefore recovered paid
state claims only canonical payment confirmation. The UI does not misrepresent
current Drop data or lost browser pickup selection as a historical Order snapshot.
No displayOrderNumber, guest order-management feature or notification promise is added.

## Checkout architecture and recovery

An eligible ACTIVE Cart offers an intentional `/checkout` link. Pending/committing
and converted Carts offer payment-status recovery instead. Absent, expired, terminal,
invalid-session and pending Cart-journal states cannot pay. Opening checkout performs
reads only and never creates a Cart or starts the four-minute payment window.

`GET /api/checkout` reads the established HttpOnly Cart session, fixed upstream Cart
route and, when an Attempt exists, fixed payment route. Drop data uses the existing
bounded storefront reader. It does not clear the capability on terminal payment
reads or copy the Cart pending-operation cookie strategy. Cart and payment revision
identities remain distinct. The safe projection omits capability, raw provider data,
customer contact records and upstream request/error messages.

`POST /api/checkout/start` and `POST /api/checkout/continue` have exact fixed upstream
paths, streamed 16 KiB body bounds, strict input shapes, exact same-Origin checks,
Fetch Metadata rejection, redirect rejection, timeouts and private/no-store output.
Capability is added server-side. Only the required If-Match and Idempotency-Key are
forwarded. Cookies, raw request payloads and provider errors are not logged. The
relay has no Stripe financial-write key. Read responses include narrowly authorized
transient action secrets; they are never cached or placed in URLs.

The browser shares the existing Cart Web Lock across Cart and checkout operations.
A synchronous per-form/per-client guard prevents duplicate clicks. Under that lock,
submission rereads current Cart/revision/availability before Elements validation and
token creation. A durable localStorage marker named `bb-payment-unresolved:<cartId>`
with the literal value `unresolved` is written and acknowledged **before** provider
work. It contains no capability, token, contact fields, secret, provider object or
idempotency identity. Unsupported locks/storage fail closed. This marker is not a
retry body or a financial authority; it only inhibits a replacement submission.

One explicit logical start generates one timestamped random backend-compatible
idempotency key and sends one exact start request. Neither key nor body is durably
stored. There is no automatic start replay. If validation fails before any backend
start, the marker can be cleared. Explicit known definitive rejection (including
PAYMENTS_DISABLED) can clear it. Transport/5xx/malformed/conflicting/unknown outcomes
retain it. Accepted starts recover through canonical GET. An ACTIVE Cart with a
retained marker stays unavailable after refresh, tab changes or a lost response;
it is never interpreted as permission to mint a new token or Attempt. A crash before
start may therefore conservatively strand checkout until reservation expiry. This
is deliberate and follows the approved unresolved/recovery rule.

Status is reread after outcomes, on focus/pageshow/visibility return, through Cart
BroadcastChannel signals, and at five-second visible-tab intervals while nonterminal.
Read failures disable stale payment eligibility and offer an explicit status check.
Timers derive from backend timestamps and server receipt time plus monotonic elapsed
time. The payment deadline is never created before acceptance or reset after action,
rerender or reload. A changed deadline for the same Attempt fails closed. Deadline
closure does not fabricate expiry or inventory release; canonical processing remains
processing until the backend settles it.

## Stripe, Elements and action handling

Exact dependencies: `@stripe/stripe-js@10.0.0`, `@stripe/react-stripe-js@7.0.0`.
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is public configuration. This sandbox-only slice
accepts `pk_test_` shape and fails closed when absent/malformed/live. Later deployment
must explicitly allowlist it and the server pricing gate through hosting review.
No live key, restricted key, webhook secret or provider configuration was installed.
The `/pure` loader prevents unsolicited Stripe script loading when checkout is
unavailable. Stripe.js is loaded from Stripe rather than bundled or mirrored.

Elements uses deferred `mode: payment`, manual capture, manual payment-method
creation and Stripe.js 10's `allowedPaymentMethodTypes: ['card']`. The older
acceptance harness spelling is not copied into the new SDK. No CustomerSession,
future-use setup or saved payment methods are configured.

On explicit Pay (or Express Checkout confirm), native form validation checks the
required contact/pickup fields, then `elements.submit()` validates hosted payment
details, then `stripe.createConfirmationToken({elements})` creates the token. Only
its ID enters the strict start request. Application code has no raw card/CVC inputs,
inspection, storage or submission. Provider error text is replaced with safe copy.

Express Checkout uses the same submission lifecycle and projection. Apple Pay and
Google Pay are `auto`; Link, PayPal, Amazon Pay and Klarna are `never`. Card is the
only allowed payment method type. Wallet buttons must pass the contact/pickup form
before opening. Payment Element wallet duplication is disabled. Mock tests exercise
wallet click/confirm; real account availability, registered domains, devices and
wallet acceptance remain a separately controlled **Phase 9B gate**. No unrelated
payment method is intentionally enabled.

Action-required state offers explicit bank authentication. Under the same lock it
rereads current action authority/deadline, calls `handleNextAction` with the transient
secret, then rereads the backend regardless of browser success/error. It never calls
`confirmPayment` or creates a second ordinary server confirmation. Only if successful
browser handling leaves the same Attempt still action_required within its deadline,
a conditional `/payment/confirm` wake-up uses the fresh payment ETag and existing
generation. Conflict or ambiguity is followed by GET, not another financial start.
Browser action success cannot produce PAID; only canonical payment GET can.

Source references: [server-finalized Elements](https://docs.stripe.com/payments/finalize-payments-on-the-server?platform=web&type=payment),
[deferred Elements options](https://docs.stripe.com/js/elements_object/create_without_intent),
[Express Checkout](https://docs.stripe.com/elements/express-checkout-element/accept-a-payment).

## Accessibility, responsive behavior and privacy

Forms have explicit labels, autocomplete hints, native required/email/pattern/date
selection validation and explanatory E.164 text. SMS consent is an unchecked optional
checkbox; false is transmitted explicitly. No marketing consent/account/address or
saved-payment workflow is added. Dynamic pickup choices are filtered against the
published end in the pickup timezone and revalidated on submit/backend admission.

Status changes use role=status; safe errors use role=alert. Countdown text has
aria-live=off to avoid per-second announcements. Submission/action outcomes focus
the Checkout heading. Fields/buttons have visible keyboard focus and touch targets.
Totals use a definition list; pickup is a labeled select. Layout has bounded-width
controls, a single-column phone layout and two desktop columns. Mocked browser checks
cover 320, 375, 390 and 1280 pixels, form error focus, outcome focus, wallet lifecycle,
status recovery and overflow. Stripe-hosted real iframe/device behavior is deferred
to controlled acceptance, not claimed from mocked rendering.

Security review: capability/cookies remain server-side; browser handles only safe
Cart/payment projections, public key, contact/pickup state and transient token/action
secret. No contact/token/secret/command identity is stored in URLs, cookies, localStorage,
sessionStorage or logs. The sole payment marker is the Cart ID plus literal unresolved.
There are no Stripe secret keys, raw provider objects or raw card fields in application
forms. No client financial amounts enter start. Existing Cart behavior and no-Drop
branding remain unchanged except the intentional checkout/recovery links.

No CSP was present. This slice leaves it unchanged rather than adding a wildcard
policy. A later hosting/hardening review must cover Stripe's script/frame/connect/image
requirements using the [Stripe security guidance](https://docs.stripe.com/security/guide),
with actual account/method requirements and application nonce policy. For this integration the reviewed request categories are the js.stripe.com/endive
script, Stripe-hosted Elements/authentication frames (js.stripe.com and
hooks.stripe.com), and API connections to api.stripe.com. Stripe's current guidance
also lists Stripe.js subdomain allowances for frame performance. We do not load an
Address Element, Google Maps, Link, hosted Checkout or Connect components. No
application Stripe image is added; any future top-level image origins must be
reviewed separately rather than copying the hosted-Checkout image wildcard.
No claim of CSP protection is made. Checkout uses noindex and no-referrer metadata; relay outputs
also set no-referrer and nosniff.

Production exclusions now permit only the exact checkout page and three relay routes
in the route-manifest allowlist. Stripe browser-loader markers are permitted, while
localhost acceptance tools, harness markers, capability cookie names in browser
bundles, restricted/secret key values, webhook secrets and secret configuration
markers remain rejected. Local browser-mock tooling is outside Next imports/build.

## Dependency disposition

See [dependency risks](DEPENDENCY_RISKS.md#phase-9a-source-map-js-review-and-local-remediation--2026-10-05)
for GHSA-68fv-2mgg-jv7q / CVE-2026-93749, dependency paths, accepted-artifact presence,
bounded request-reachability evidence and normal 1.2.1 -> 1.2.2 local remediation.
The accepted deployed Job 3 artifact still contains source-map-js 1.2.1 where
previously observed. Only the new local Phase 9A graph resolves 1.2.2; the live
artifact has not been remediated. Any future Phase 9A deployment requires a new
artifact identity and independent artifact/security review.
The two exact Stripe packages add no advisory. Only those two nodes and the source-map
patch change versions; five existing prop-types closure nodes become production
reachable in the dependency graph. No unrelated package or override was added.
Full audit remains visibly nonzero at seven affected nodes (six high, one moderate).

## Validation and review gate

Validation results are recorded below after final checks. Mock tests never contact
Stripe or live backend APIs. The browser script explicitly blocks non-loopback
network requests except Stripe script requests fulfilled with a local mock. It is
run using an existing external Playwright runtime; Playwright is not added as a
project dependency. With the loopback dev server configured using the fake
`pk_test_mock` public value, run `node --test tools/checkout/browser.test.cjs` with
`PLAYWRIGHT_MODULE` pointing to the installed Playwright module. Do not point the
script at a live site. Normal web unit tests require no environment/key/provider.

No deployment, Amplify build, AWS/Stripe mutation, real payment, enablement, live
Cart/Drop mutation is authorized or performed. Commit, branch push and PR creation were subsequently human-approved. No backend, Lambda,
DynamoDB, API Gateway, SQS, IAM/CDK, hosting or admission configuration changes.
Local source/defaults retain PAYMENT_START_ENABLED=false. During repository
finalization, existing AWS authentication was valid: read-only Lambda configuration
inspection of `batch-and-batter-dev-api` in `us-east-2` confirmed
`PAYMENT_START_ENABLED=false`. No authentication flow or AWS mutation was initiated.

Any future deployment creates a **NEW Amplify artifact/request surface** and requires
independent PostCSS reachability reevaluation. Artifact-specific acceptance does not
transfer. Production pricing authority, account/wallet/domain/device acceptance,
real Stripe iframe behavior, Phase 25 certification and the existing operational
recovery limitations remain later gates. Refunds, order numbers, guest management,
pickup changes, notifications, waitlist, admin work and production launch are excluded.

### Final local validation

| Check                                  | Result                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Frontend full unit suite               | 208 passed: 81 new checkout tests plus 127 existing tests                                    |
| Mock browser scenario                  | Passed; Chrome at 320, 375, 390 and 1280 pixels; zero external requests and zero page errors |
| Backend functional suite               | 902 passed                                                                                   |
| Backend deployment-artifact suite      | 7 passed                                                                                     |
| Infrastructure suite                   | 34 passed                                                                                    |
| Infrastructure typecheck and synthesis | Passed; lookups disabled, no deployment                                                      |
| Backend typecheck                      | Passed                                                                                       |
| Backend audit                          | Zero findings                                                                                |
| Infrastructure audit                   | Existing one high affected node / documented brace-expansion advisories                      |

The browser scenario exercises actual Next/React rendering with a locally fulfilled
Stripe.js mock: deferred amount/type initialization, native validation focus,
keyboard Tab navigation, explicit true and false consent, validation-before-token,
regular Pay, wallet confirmation, disabled admission, ambiguous refresh safety,
canonical processing/paid/failed rendering, bank-action reread, deadline-closed
processing, amount wrapping and overflow. Screenshot review corrected a 320px
currency wrap and overly long pickup option. Raw card fields and real wallet/provider
frames are deliberately absent from this test. The frontend fetch wrapper was also
corrected after the browser check exposed an illegal receiver binding missed by
injected unit mocks.

### Requested final report index

| Requested items                                   | Outcome / evidence                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2: Starting HEAD / branch                       | `1701f457a0692f16bf2f9d701ba8ab21deab15f3`; `codex/phase-9a-customer-checkout`                                                                                                                                         |
| 3–4: Backend contracts / discrepancies            | Exact endpoints, shapes, capabilities, revisions, errors and state semantics above. Start body matches. Pricing projection gap resolved by explicit human approval; no further material backend discrepancy.           |
| 5–6: Dependencies / audit                         | Exact Stripe.js 10.0.0 and React Stripe.js 7.0.0; source-map-js transitive 1.2.2 patch; two new nodes, five existing production-closure reclassifications, no Stripe advisory delta. Full audit 8 -> 7 affected nodes. |
| 7: Files                                          | Complete list below; backend/infrastructure/hosting unchanged.                                                                                                                                                         |
| 8–12: Entry, data, pickup, summary, public key    | Eligible active Cart link; exact current fields/E.164/explicit optional consent; allowed pickup windows; gated Cart-derived USD totals; absent mode/key fails closed.                                                  |
| 13–17: Relay / Elements / Express / token / start | Fixed same-origin capability relays; hosted Elements; restricted wallet intent; validation then transient token; one exact start POST without financial fields.                                                        |
| 18–20: Submission / ambiguity / reload            | Shared Web Lock, duplicate guards, one transient submission identity, nonsecret unresolved marker; no automatic replacement; authoritative recovery.                                                                   |
| 21–24: Action / deadline / terminal / errors      | Same-Intent handleNextAction and canonical reread; conditional wake-up only; immutable backend deadline; backend-only paid/failed states and safe error copy.                                                          |
| 25–26: Accessibility / responsive                 | Labels, native errors, keyboard/focus/status handling and non-announcing timers; local mock browser checks at required widths.                                                                                         |
| 27–29: Security / CSP / exclusions                | Capability and sensitive fields excluded from durable/browser logging surfaces; CSP deferred explicitly; exact route allowlist plus strengthened secret/mock exclusions.                                               |
| 30–33: Tests and totals                           | 81 new frontend checkout cases; 208 frontend total; one combined browser scenario; 902 backend + 7 artifact; 34 infrastructure.                                                                                        |
| 34–36: Build / formatting / Git                   | Final command results recorded below. Human-approved repository finalization follows fresh validation.                                                                                                                 |
| 37–39: Admission / deployment / mutations         | Local defaults retain false; read-only live Lambda inspection confirmed false during repository finalization. No deployment, Amplify build, AWS mutation, Stripe account/payment operation or live Cart/Drop mutation. |
| 40–41: Limits / human review                      | Local mock implementation passed human review for repository finalization. Real Stripe/wallet/device acceptance, production pricing authority and new-artifact reachability remain independent gates.                  |

Changed/added files:

- `docs/PHASE_9A_CUSTOMER_CHECKOUT.md`
- `docs/DEPENDENCY_RISKS.md`
- `web/package.json`
- `web/package-lock.json`
- `web/src/app/globals.css`
- `web/src/app/checkout/page.tsx`
- `web/src/app/api/checkout/route.ts`
- `web/src/app/api/checkout/start/route.ts`
- `web/src/app/api/checkout/continue/route.ts`
- `web/src/components/cart/cart.tsx`
- `web/src/components/checkout/checkout.tsx`
- `web/src/lib/cart/relay.ts` (exports existing session/origin helpers only)
- `web/src/lib/checkout/contract.ts`
- `web/src/lib/checkout/pricing.ts`
- `web/src/lib/checkout/relay.ts`
- `web/src/lib/checkout/client.ts`
- `web/src/lib/checkout/checkout.test.ts`
- `tools/checkout/browser.test.cjs`
- `tools/stripe-acceptance/artifact.test.mjs`

Final frontend typecheck, zero-warning lint, local production build and both
production-exclusion tests **passed**. The final `/checkout` build reports 13.7 kB
route code / 116 kB first-load JS. Repository-wide formatting and `git diff --check`
**passed**. The approved inventory contains exactly 19 files (seven previously
tracked and twelve new), limited to checkout, dependencies, tests and documentation.
The local mock server was stopped. Repository finalization is human-approved;
this is not live payment, wallet, hosting or production acceptance.

Fresh repository-finalization validation repeated all 208 frontend, 902 backend,
7 backend artifact, 34 infrastructure and 2 production-exclusion tests successfully.
Frontend/backend/infrastructure typechecks, frontend lint and production build,
lookups-disabled infrastructure synth, repository formatting and diff checks passed.
The browser mock scenario above belongs to the earlier local implementation review;
it was not rerun for repository finalization. Fresh audits retain seven frontend
affected nodes (six high, one moderate; production-only one high and one moderate),
zero backend findings and one existing high infrastructure node.

## Job 4 deployment and SSR environment propagation fix

Amplify Job 4 deployed revision `4f68a79296ad8b84dcd42a1969f6582f349189ed`
successfully on 2026-10-06 (04:11:36–04:14:08 UTC), but **Phase 9A deployment
acceptance DID NOT PASS**. Its downloaded BUILD.zip SHA-256 is
`ccc0c81cc044724ed1896dae641342e7405156a3de23d6d2e613c6472458b44b`.

Amplify build environment variables are not automatically available to Next.js SSR.
Job 4 had `CHECKOUT_PRICING_MODE=dev-zero-tax-fee` configured in the Amplify branch,
but `compute/default/.env.production` contained only `STOREFRONT_API_BASE_URL` and
`STOREFRONT_CURRENCY`. The checkout relay reads the pricing mode at runtime, so its
server-side gate could not operate as intended. This is hosting configuration
plumbing, not a payment-domain contract change. The public test key was present in
rendered checkout configuration, and no-Cart checkout remained safe.

The gate performed no Cart, Drop, reservation, ConfirmationToken, payment-start,
PaymentIntent or Stripe mutation and created no new paid Orders. Payment admission
was verified false before and after, automatic builds remained disabled, and no
second deployment was attempted. PostCSS 8.4.31 was packaged, with zero PostCSS
loads in a bounded 402-module read-only runtime exercise; source-map-js 1.2.2 was
physically packaged. These findings do not convert Job 4 into passed acceptance.

The local remediation extends `web/scripts/prepare-amplify-env.mjs`, preserving the
existing build command and exclusive mode-0600 `.env.production` creation. Its
explicit non-secret allowlist is exactly:

- `STOREFRONT_API_BASE_URL`: required, validated public HTTPS URL.
- `STOREFRONT_CURRENCY`: required, exactly `USD`.
- `CHECKOUT_PRICING_MODE`: optional for storefront-only builds; when configured,
  exactly `dev-zero-tax-fee`. It remains server-side, never `NEXT_PUBLIC`.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: optional for storefront-only builds; when
  configured, a `pk_test_`-shaped public key. No concrete account key is committed.

Missing optional settings are omitted, not defaulted. Existing checkout tests
continue to enforce missing/unsupported pricing mode and unsupported currency
fail-closed behavior. Invalid configured values fail preparation before any file
is written. Tests run the actual helper in isolated temporary directories using
only synthetic values. They check exact output, omitted optional settings,
required settings, invalid values/injection, file permissions and non-overwrite.

No arbitrary `NEXT_PUBLIC_` prefix expansion or bulk environment copying is used.
Unrelated public variables, Stripe secret/restricted keys, webhook secrets, Cognito
admin credentials/tokens, AWS credentials, Cart capabilities, action/client secrets,
ConfirmationToken IDs and customer data are not copied from other environment
variables. Invalid key types are also rejected in the publishable-key slot. Helper
success/error output does not disclose configured values.

A separately approved new deployment must independently verify the actual packaged
`.env.production` contains the intended four settings, the pricing mode is available
to SSR, the public test key is available as intended, and no prohibited values are
packaged. It must also verify packaged source-map-js remains 1.2.2 where applicable
and repeat the artifact-specific PostCSS static/dynamic request-reachability review.
Local build success is not hosted artifact acceptance. No deployment, AWS environment
mutation, payment enablement or commerce/Stripe mutation is part of this local fix.

Local fix validation: 238 frontend tests passed (208 existing plus 30 new helper
cases), including unchanged Phase 9A fail-closed pricing tests. Typecheck,
zero-warning lint, production build, both production-exclusion tests, repository
formatting and diff checks passed. The controlled build used only synthetic public
configuration, generated exactly four settings with the real helper, and removed
those settings from the build process environment so Next.js loaded the generated
file. Representative prohibited values were excluded, and neither the pricing-mode
variable nor its value appeared in browser JavaScript. The temporary environment
file was removed afterward. No dependency, backend, infrastructure or build-spec
change was needed. Broader backend/infrastructure suites were not rerun for this
helper-only change; hosted packaging remains a separate acceptance gate.
