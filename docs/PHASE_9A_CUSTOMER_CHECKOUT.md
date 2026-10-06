# Phase 9A — customer checkout contract review

Status: local implementation human review approved for repository finalization. Commit, branch push and PR creation are authorized; deployment and payment acceptance remain separately gated.

Starting main and origin/main: `1701f457a0692f16bf2f9d701ba8ab21deab15f3`.
Branch: `codex/phase-9a-customer-checkout`. Repository finalization targets a PR to main.

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
