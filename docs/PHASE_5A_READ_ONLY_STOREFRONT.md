# Phase 5A — read-only current / upcoming Drop storefront

This is the customer-storefront work unit under Implementation Plan v1.0 **PHASE 5 — Customer Storefront** (PRD v1.1 and Technical Specification v1.1). It is distinct from the historical Phase 5A1/5A2 backend reservation work.

**Status: IMPLEMENTED LOCALLY / READY FOR MERGE.** Human review approved repository finalization only. No deployment, AWS mutation, Stripe interaction or payment enablement. PAYMENT_START_ENABLED remains false; this change does not read or alter payment configuration. Frontend hosting/deployment requires separate human review.

## Public contract and configuration

The Next.js home page now requests `GET /drops/current` server-side through the existing public catalog API. No backend runtime is imported. The source contract is `backend/src/storefront.ts`: `{ drop: null }` or a composed Drop with products, availability and pickup dates. Internal IDs and unused fields are discarded at the presentation boundary; no alternate business state is introduced.

Configure these non-secret server environment values before starting the frontend:

- `STOREFRONT_API_BASE_URL`: the approved public API base URL, optionally including a stage path. HTTPS is required; plain HTTP loopback is allowed only with NODE_ENV=development for local mocks. Credentials, query strings and fragments are rejected. There is no hardcoded DEV endpoint or live fallback.
- `STOREFRONT_CURRENCY=USD`: required explicitly because the catalog response contains cents but no currency. USD matches the existing payment contract. Other currencies fail closed; supporting them requires a reviewed contract change rather than silently relabeling prices.

Missing/invalid configuration shows the safe unavailable state. These values are not secrets, require no NEXT_PUBLIC prefix, and no admin/Stripe credential is used. The request has only an Accept header, uses GET, forbids redirects and disables fetch caching. The page is force-dynamic, so neither builds nor static generation capture inventory. Reload uses a full page navigation to avoid client-router cache reuse. No automatic polling or browser lifecycle timer is added.

## Bounded parsing and failure behavior

A five-second abort covers request and response reading. The client requires a successful JSON response and bounds the streamed body to 256 KiB. It validates only presentation-relevant public fields: known state, valid UTC opening timestamp, valid timezones, bounded strings, at most 100 products and 100 pickup dates, nonnegative safe integer prices/counters, consistent inventory counters, real calendar dates and same-day pickup windows. Oversized or malformed responses fail as a whole; no partial/fabricated data is shown. These frontend resource limits do not impose backend schema changes.

Raw payloads and exception messages are neither rendered nor logged. React escapes text. Unknown response properties are not passed to the view. Network/configuration failure and malformed-response states have fixed safe messages and a reload link. Empty products and pickup dates have deliberate messages. A null Drop shows no current/upcoming Drop, without inventing a closed record.

## Authoritative state and time

- OPEN: display Open and authoritative availability; no purchase controls.
- SCHEDULED: display Upcoming and the backend opening timestamp in the Drop timezone. A past timestamp never changes SCHEDULED into OPEN.
- PAUSED: display Ordering paused.
- SOLD_OUT: display Sold out.
- CLOSED: display Closed when supplied by the public API.
- DRAFT/COMPLETED/unknown states: reject, since the public visible-state contract excludes them.

All non-OPEN states explicitly say ordering is unavailable. No browser clock determines lifecycle or inventory ownership. Product availability uses the supplied `available` value after validating consistency, rather than substituting a client-calculated count. Zero means none currently available; it does not change the Drop state. Text explicitly states that viewing does not reserve inventory and availability may change.

Prices use USD currency formatting of the supplied cents. Pickup dates are calendar dates, formatted without converting them across timezones. Pickup hours remain the supplied local wall times with each pickup timezone labeled; America/Denver therefore retains its business-date semantics. Opening instants are converted using the Drop's supplied timezone. Location and instructions are shown as escaped text.

## Accessibility and visual scope

One page h1, section h2s, product h3s, labeled sections, semantic lists and time elements. Errors use a safe status message. Reload is keyboard-accessible with a visible focus outline. State/availability are expressed in text, not color alone. Product cards wrap at narrow widths; long content can wrap. Layout stays intentionally minimal. This is not final visual design or Phase 25 accessibility certification.

## Validation

- Frontend: 54 tests passed (47 new storefront cases, 7 existing environment tests).
- Cases include OPEN, past-timestamp SCHEDULED, PAUSED, SOLD_OUT, CLOSED, null Drop, multiple/empty products, pickup date/time formatting, zero availability, escaped text, semantic headings/lists/status messages, invalid states/dates/timezones/prices/inventory, bounded body/collections, HTTP/network failures, timeout and safe URL/configuration handling.
- Frontend typecheck, lint and production build passed. Only `/` and the existing not-found route remain; `/` is now dynamically server-rendered.
- Production exclusion: both existing tests passed against the build, excluding the local acceptance harness/Stripe browser SDK from production output and the harness from Lambda inputs.
- Standard backend regression suites: 844 functional and 7 artifact tests passed. Infrastructure: 34 tests passed. No source changes in those workspaces.
- A local mock API/browser preview verified readable product cards, availability and pickup presentation. No live catalog request was needed.
- Formatting and git diff --check passed.
- CDK diff was not run: no infrastructure/backend/build-input changes were made. No claim of a freshly measured live zero diff is made.

## Non-goals and remaining gates

No Cart/reservation API, shopping timer, checkout, Stripe.js, Payment Element, wallet, order management, admin mutation/dashboard, schedule mutation, refund/restock, notification, waitlist, analytics or final visual design. No dependency changes. The JSX test-runner setting enables component rendering tests without adding a test dependency.

Local read-only storefront implementation is human-reviewed and ready for merge, not deployed acceptance. Phase 5 as a whole is not declared complete: administrative schedule-change/cancel capabilities and separately reviewed hosting/deployment remain outstanding. The current payment acceptance/recovery limitations and dependency-risk exceptions are unchanged.
