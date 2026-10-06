# Phase 6A — customer Cart and existing reservations

Local implementation only, on `codex/phase-6a-customer-cart-reservations`.
Starting main and origin/main: `a882316233a7210d47543becfd60b8d92102ffc7`.
Human review approved repository finalization: commit, branch push and PR to main.
Deployment, Amplify builds, AWS/Stripe mutation, payment enablement, and live
Cart/Drop mutation remain prohibited and were not performed.

## Governing scope and reconciled contract

PRD shopping/expiry rules, Technical Specification ownership rules, and the
Implementation Plan Phase 6 Cart foundation govern this work. The old plan's
"No reservation timing yet" describes its original sequencing. The explicitly
approved Phase 6A scope presents the reservation engine already implemented by
Phase 5A1 and Phase 5A2; it does not build another reservation engine.

Read the actual `backend/src/cart-api.ts`, `cart-domain.ts`, `cart-repository.ts`,
`storefront.ts`, Cart/expiry tests, Phase 5A1/5A2 documents, storefront document,
payment recovery runbook and dependency-risk record together. Later payment
states in the actual Cart schema supersede the early three-state documentation.
The user explicitly reconciled caller-generated capabilities, pending expiry
release, and presentation-only name/currency/total/limit joins before coding.
No further material contract discrepancy was found.

## Exact existing API

All routes use application capability authorization, with no Cognito session.
Every route requires `X-Cart-Token`, including creation.

| Route                       | Request                                                         | Success               |
| --------------------------- | --------------------------------------------------------------- | --------------------- |
| POST `/carts`               | `{dropId, items:[{productId, quantity}]}`; Idempotency-Key      | 201 `{cart}`          |
| GET `/carts/{cartId}`       | no body                                                         | 200 `{cart, expired}` |
| PUT `/carts/{cartId}/items` | `{items:[{productId, quantity}]}`; Idempotency-Key and If-Match | 200 `{cart}`          |
| DELETE `/carts/{cartId}`    | absent/empty/`{}`; Idempotency-Key, no revision requirement     | 200 `{cart}`          |

IDs are ULIDs; the relay accepts canonical uppercase representations. Desired
sets contain 1–12 unique product IDs and positive safe-integer quantities.
Unknown request fields, prices, units and deadlines are rejected. Backend JSON
body limit is 16 KiB before decoding. The relay bounds streamed JSON to 16 KiB.
The distinct-line cap of 12 is separate from the configurable cookie-unit limit.

The caller generates 32 cryptographically random bytes as 43 canonical,
unpadded base64url characters. Backend storage contains only SHA-256 of
`batch-and-batter:cart-capability:v1:<capability>`. Cart IDs confer no ownership.
Absent Cart and wrong capability both return 401 UNAUTHORIZED. There is no
rotation or backend-issued capability response.

Cart DTO: `cartId`, `dropId`, `status`, `createdAt`, `updatedAt`,
`shoppingExpiresAt`, `items:[{productId,quantity,priceCents,cookieUnits}]`.
Existing payment states can additionally expose paymentGraceUsed,
paymentStartedAt, paymentDeadline, paymentAttemptId, orderId,
committingStartedAt and committingDeadline; this shopping relay deliberately
projects only the shopping fields. It never exposes hashes, settlement or
recovery internals. States are ACTIVE, CANCELLED, EXPIRED, PAYMENT_PENDING,
PAYMENT_COMMITTING, CONVERTED. The latter three are read-only here and are never
called released. Terminal line snapshots are history, not reserved ownership.

No product names, currency, precomputed totals or quantityLimit occur in Cart
responses. Current Drop supplies names, IDs, cookieUnits and quantityLimit.
Names join by productId only within the same Drop; missing names use numbered
reserved-cookie labels. USD uses the existing explicit USD-only storefront
configuration. Display totals sum Cart `quantity * priceCents`; order units sum
Cart `quantity * cookieUnits`. New additions use current Drop units for a
proactive check; existing lines use accepted Cart snapshots. Backend validation
is final authority. No prices or totals are submitted by the UI.

Responses carry `Cache-Control: no-store` and a strong quoted SHA-256 ETag of
`cart-revision:v1:<updatedAt>`. Backend Cart revisions advance monotonically.
PUT must use the exact strong ETag: missing/weak/wildcard/malformed values fail
validation; stale revisions return 409 CART_CONFLICT. DELETE does not take
If-Match. The relay preserves successful ETags and forwards the journal's exact
If-Match for PUT.

Idempotency key syntax is `v1.<13-digit epoch milliseconds>.<43 base64url chars>`.
New keys must be younger than 24 hours and at most five minutes in the future.
Receipts live at least seven days, are committed atomically with inventory and
Cart writes, and replay before revision checks. Scope includes operation and
Cart ID (or `new`). Fingerprints include desired quantities, Drop/Cart identity
and revision; capability mismatch cannot read another caller's receipt.
Replays return the historical snapshot, so the UI follows successful create/
replace execution with GET before enabling edits. CART_BUSY/transport ambiguity
must preserve the same key, body, revision and capability.

The shopping deadline is canonical UTC ISO time, persisted on the successful
create attempt as server time plus 480 seconds. No add, edit, reduction, refresh,
release or replay extends it. GET reports expiration without releasing stock.
PUT is a full nonempty desired set. Acquisitions require OPEN, current storefront
assignment, active products and sufficient stock. PAUSED/CLOSED permit pure
reductions/no-ops; DELETE releases without requiring a current Drop or Product.
SOLD_OUT is availability presentation, not a separate Cart error code.

DELETE persists CANCELLED before deadline or EXPIRED at/after deadline. Terminal
release is idempotent and never subtracts history again. Cart tests explicitly
cover deadline equality, GET expired, and DELETE settling once. This UI uses
DELETE for explicit final-line removal while shopping; it does **not** initiate
DELETE automatically after expiry. Existing workers/recovery own that path.

## Same-origin relay and durable operation journal

Only three frontend operations exist:

- GET `/api/cart`: recover pending flag or retrieve owned Cart.
- POST `/api/cart/session`: validate and save one immutable pending operation;
  no backend call or inventory mutation occurs here.
- POST `/api/cart` with `{}`: execute that saved operation against its one exact
  backend Cart endpoint. The browser cannot supply an arbitrary backend path.

The Node route handlers use existing STOREFRONT_API_BASE_URL and currency
validation. No middleware, database, session store, backend runtime import,
CORS, API Gateway, Lambda, DynamoDB, SQS, IAM or CDK change exists.

Production cookie `__Host-bb-cart` is HttpOnly, Secure, SameSite=Strict, Path=/,
with no Domain. Development uses `bb-cart-local` without Secure for local HTTP.
The cookie stores capability, optional Cart ID and optional pending operation
with server-generated idempotency key. Seven-day Max-Age preserves recovery far
beyond the eight-minute reservation; it is not the shopping deadline. Successful
reads refresh cookie lifetime, never backend reservation lifetime. Terminal
released Carts and authorization failures clear it. Pending operations are never
overwritten by another prepare request.

Cookie data is untrusted and strictly parsed into the fixed operation schema.
No signing key is required: authorization still requires the backend-validated
random capability. Editing a cookie cannot create access to someone else's Cart
or introduce arbitrary paths/headers. The cookie is not encryption against its
owner or browser developer tools; HttpOnly prevents ordinary browser JavaScript
from reading or replacing this credential. No capability appears in client JSON,
React props, DOM, HTML, URLs, logs, localStorage or sessionStorage.

### First-create ambiguity proof

1. Prepare generates capability and key before any backend creation and writes
   them with the exact desired body in HttpOnly storage.
2. Browser waits for prepare before sending execute. Execute needs that cookie;
   missing/blocked cookie cannot create a Cart.
3. Relay-to-backend response lost: pending cookie is unchanged. The backend may
   have committed, but retry sends the same capability/key/body. Receipt replay
   resolves the original Cart rather than making another.
4. Browser-to-relay execute response lost **before Set-Cookie**: original pending
   cookie remains. Retry replays the exact original operation.
5. Browser-to-relay execute body lost **after Set-Cookie**: cookie already has the
   committed Cart ID, or has been cleared after release. GET restores the result;
   retry first reads state and does not create another operation.
6. Prepare response lost with cookie received: refresh sees pending and offers
   Retry saved change. Prepare response lost without cookie received: backend was
   never contacted. A subsequent explicit add may safely bootstrap again.

All mutation kinds use this two-step journal, so reload also preserves ambiguous
PUT and DELETE revisions/identity. No automatic retry mints a new key. HTTP 5xx,
CART_BUSY, malformed payload and transport timeout preserve pending. A recognized,
status-consistent definitive 4xx clears pending while retaining existing ownership
where appropriate. The customer explicitly retries unresolved operations.

This proof assumes the browser retains its cookie and uses the supported UI.
Deleting browser data, copying cookies between people, or leaving the journal
past its seven-day lifetime cannot be recovered by a storeless frontend. The
backend's independent durable expiry/reconciliation still owns inventory release.
This is not a guarantee against a broken backend recovery system or lost cookies.

## Concurrency, restoration and stale revisions

Web Locks serializes read/prepare/execute/recovery for all same-origin tabs in a
browser profile. Initial hydration disables add until restoration completes.
Browsers without Web Locks may read their Cart but cannot mutate through this UI;
there is no unsafe tab-coordination fallback. The client also rejects create,
replace, release and retry before any HTTP request when no lock implementation is
available, even if a caller bypasses the disabled UI. GET restoration remains
available. The customer sees: “This browser can display your Cart, but cannot
safely update it. Please use a current browser to make changes.” Two focused
regression tests in `cart.test.ts` verify zero mutation requests without Web Locks,
read-only restoration, and a disabled pending-operation retry button. No new
synchronization dependency or fallback architecture was added.

BroadcastChannel sends only a fixed
change notification, never credentials or Cart data. Focus/resume and pre-mutation
reads still work if BroadcastChannel is unavailable.

Every new mutation reads state inside the lock and compares the selected Cart and
PUT revision with the current snapshot. Concurrent first adds produce one Cart;
the losing tab receives a conflict and must review before another action.
Concurrent edits cannot silently rebase desired quantities. Backend CART_CONFLICT
also causes an authoritative GET and explanatory message. Unresolved pending work
blocks fresh mutations across tabs. No optimistic inventory/pricing state exists.

A saved session restores via GET on mount. Deadline stays unchanged. Released
terminal state clears the cookie; another tab may consequently see an empty Cart
rather than the first tab's terminal notice. This never asserts unproven release.
Explicit final-line removal issues DELETE, clears session, and removes line/total
UI and navigates to fresh storefront availability. A latest-availability link also performs a full navigation, avoiding router caches.
No automatic replacement Cart or re-reservation occurs.

## Timing, background recovery and expiry

API response HTTP Date is the preferred time source. Relay receipt time is the
fallback when Date is absent/invalid. Client adds the full measured request
round-trip and one second for Date precision, then advances from performance.now.
This deliberately conservative presentation can reach zero early; browser wall
clock changes cannot extend the deadline. GET, never the visual clock, decides
whether shopping has expired. Server clock synchronization and hosted Date/header
behavior require validation during a future deployment review.

The timer ticks visually once a second with no per-second live announcements.
It reanchors through GET each visible minute. visibilitychange, focus and pageshow
revalidate after more than one second since the previous check; a timer gap over
15 seconds also triggers GET. Periodic anchoring covers monotonic clocks that
pause during sleep. Wall-clock/monotonic divergence over 15 seconds also triggers a read; wall time never determines the countdown or ownership. Cleanup removes timers/listeners when the component unmounts.

At zero, the UI disables edits and shows checking. The first expiry check occurs
on the next one-second tick. At most six automatic expiry checks are attempted,
subsequent checks at least ten seconds apart. A failed check may make one additional recovery GET (at most twelve HTTP reads for these six scheduled checks). After that, Check Cart status and
resume events remain available; there is no infinite rapid polling loop.

`expired:true` + ACTIVE means time has expired but inventory ownership may remain.
Copy: “Your reservation time has expired. We’re confirming that your cookies have
been released.” Only CANCELLED/EXPIRED prove released ownership and permit “Your
reserved cookies have been released.” Payment states and unavailable/network
results do not prove release. The client neither releases at zero nor invents an
EXPIRED record.

## Error projection and security review

| Backend code                                   | HTTP                        | Customer treatment                              |
| ---------------------------------------------- | --------------------------- | ----------------------------------------------- |
| VALIDATION_ERROR                               | 400                         | refresh/review invalid change                   |
| UNAUTHORIZED                                   | 401                         | clear unusable session; return to availability  |
| RESERVATION_EXPIRED                            | 410                         | recheck authoritative release state             |
| CART_CONFLICT                                  | 409                         | refresh; review newer state before trying again |
| IDEMPOTENCY_CONFLICT / IDEMPOTENCY_KEY_EXPIRED | 409                         | fixed recovery explanation                      |
| DROP_NOT_OPEN / STOREFRONT_CONFLICT            | 409                         | refresh current Drop availability               |
| PRODUCT_NOT_AVAILABLE / INSUFFICIENT_INVENTORY | 409                         | safe unavailable/shortage explanation           |
| QUANTITY_LIMIT_EXCEEDED                        | 409                         | explain configured cookie-unit limit            |
| CART_BUSY                                      | 503, backend Retry-After: 1 | keep journal; explicit same-operation retry     |
| INTERNAL_ERROR                                 | 500                         | relay projects 503, keeps journal               |

The relay uses actual codes, not invented PAUSED/CLOSED/SOLD_OUT errors. Unknown
codes/status mismatches are ambiguous safe failures. Fixed user messages replace
raw JSON, backend messages, exceptions, paths and headers. No application logs
are added. Relay fetch timeout is five seconds, client timeout ten seconds.

Security checks: all mutation requests require an exact Origin matching request
scheme/Host and reject non-same-origin Fetch Metadata when supplied. Forwarded
host is not used as authorization. Browser-controlled URLs/paths/credentials are
never forwarded. IDs, tokens, keys and ETags are canonical and bounded before
header/path use; redirects are forbidden. Only fixed headers are transmitted.
Every relay result, including errors/empty state, is private/no-store, Vary Cookie
and nosniff. Routes and page are force-dynamic. There is no process-global Cart,
shared response cache, raw-body logger or browser capability API.

Residual review boundaries: HttpOnly does not stop same-origin XSS from issuing
requests; React escaping and no unsafe HTML were retained. Web Locks coordinates
supported customer tabs, not deliberately forged direct HTTP clients. Cookie and
Origin behavior must be retested behind Amplify's actual HTTPS forwarding before
public release. Repository finalization used already-active AWS authentication for a read-only
Lambda configuration query: PAYMENT_START_ENABLED was verified false for
`batch-and-batter-dev-api` in us-east-2. No login or environment update occurred.

## Accessibility, responsive behavior and payment boundary

Semantic buttons have explicit quantity/product labels, native keyboard support,
44px minimum targets and visible focus. Cart heading receives focus after explicit
mutations/retries so removed controls do not strand focus; periodic updates do not
move focus. Error messages use a status region. Total, quantities and state use
text rather than color. Countdown status changes only at 3 minutes, 1 minute,
30 seconds and checking. Responsive controls wrap, and existing product/no-Drop
branding remains intact. Checkout is deliberately disabled with explanatory text.
No Stripe.js, SDK dependency, Payment Element, wallet, payment/start call, paid
Order UI, payment admission or fake success exists.

## Validation record

Fresh repository-finalization validation on 2026-10-05 (after the Web Locks guard):

| Check                              | Result                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| Full frontend suite                | 127 passed across 5 test files                                                        |
| Typecheck                          | passed                                                                                |
| ESLint                             | passed, zero warnings                                                                 |
| Production Next.js build           | passed                                                                                |
| Production-exclusion suite         | 2 passed; includes browser capability-marker exclusion                                |
| Dynamic rendering                  | `/`, `/api/cart`, `/api/cart/session` dynamic; only not-found prerendered             |
| Cart cache isolation               | no-store/private/Vary Cookie verified in relay tests and local HTTP response          |
| Repository formatting              | passed                                                                                |
| git diff --check                   | passed                                                                                |
| Backend CI regression suites       | 902 functional + 7 artifact tests passed                                              |
| Infrastructure CI regression suite | 34 tests passed                                                                       |
| Local runtime traces               | 9 NFT traces; no listed PostCSS/braces/micromatch/fast-glob/Next ESLint package paths |

No live CDK diff, deployment, Amplify build, audit remediation, AWS/Stripe mutation
or payment action was performed. Backend/infrastructure tests were the repository's
existing local CI suites. Their source remains unchanged. Local mock servers and
temporary browser tabs were stopped/closed after verification. No dependencies,
lockfiles, hosting configuration or payment settings changed.

The approved base remains unchanged. Phase 6A local implementation passed human
review and is approved for repository finalization and PR review; it is not
approved for deployment. Public cookie/Origin behavior, actual hosted artifact
security and final accessibility certification remain future gates.
Frontend tests include the A–AE original matrix and reconciliation cases: first
create, stable ambiguous retries, headers/cookies, safe projection, same-Cart edits,
removal, concurrency, deadline preservation, presentation math/limits, expiry
ownership, bounded polling, focus/resume/sleep, accessibility markup, lifecycle
states, malformed/network input, original branding and production exclusion.
Browser verification uses an isolated in-memory local fixture only, never the
live storefront backend. At 320, 375, 390 and 1280px, measured document scrollWidth
equaled clientWidth. Cart quantity buttons measured at least 44×44px. Keyboard add
and heading focus, refresh persistence, two-tab synchronization, first/subsequent
adds, quantity change, removal and release-pending wording were verified. The
fixture intentionally displayed $9.00 storefront pricing with $5.25 Cart pricing;
the Cart correctly rendered the latter. Browser QA exposed a native fetch receiver
issue missed by Node mocks; the fix and a regression test are included.

## Explicit non-goals and deployment gate

No backend or infrastructure implementation changes. No new dependencies or
lockfile changes. No full Phase 24 redesign or Phase 25 certification. No payments,
orders, guest management, pickup changes, notifications, refunds, waitlist,
admin dashboard, analytics or production launch.

PAYMENT_START_ENABLED was verified false through a read-only Lambda configuration
query during repository finalization and was not changed. Automatic Amplify builds
remain untouched.

Future deployment changes the public request surface and produces a new SSR
artifact. Accepted Job 2 artifact SHA-256
`016802c0a7d0f860705557e3c277196c02c212dfa4d3a3dd10310e9e09be72b0`
does **not** authorize a Phase 6A artifact. Independently reevaluate the narrowly
scoped PostCSS 8.4.31 PACKAGED BUT NOT REQUEST-REACHABLE exception against the new
routes and actual Amplify artifact; preserve DEPENDENCY_RISKS.md advisory records.
Local trace absence does not establish hosted artifact absence or safety.

**PUBLIC DEPLOYMENT IS SEPARATELY GATED.** It would expose real DEV reservation
capability publicly, create a new Amplify runtime artifact/request surface, and
require live HttpOnly/Secure/origin acceptance, independent PostCSS reachability
review, and controlled live Cart acceptance. Local tests and repository approval
do not constitute live acceptance.

## Implementation files

- `web/src/app/api/cart/route.ts`, `web/src/app/api/cart/session/route.ts`: dynamic Node relay entrypoints.
- `web/src/lib/cart/relay.ts`: server capability, journal, validation and safe backend transport.
- `web/src/lib/cart/contract.ts`: public projection, strict input, arithmetic and safe messages.
- `web/src/lib/cart/client.ts`: serialized two-step mutations and authoritative recovery.
- `web/src/lib/cart/lifecycle.ts`: presentation timer and bounded resume/expiry revalidation.
- `web/src/components/cart/cart.tsx`: Cart context, controls, focus, status and checkout boundary.
- `web/src/components/storefront/storefront.tsx`, `web/src/lib/storefront/client.ts`, `web/src/app/globals.css`: storefront integration, validated public identifiers/units/limit and responsive styling.
- `web/src/lib/cart/cart.test.ts`, `web/src/lib/cart/lifecycle.test.ts`, `web/src/lib/storefront/storefront.test.ts`: contract, ambiguity, concurrency, security, timer and storefront regressions.
- `tools/stripe-acceptance/artifact.test.mjs`: allow only the new Cart routes and strengthen payment/credential exclusion; no harness execution or payment code change.
- This document: contracts, design, review, validation and deployment boundary.
