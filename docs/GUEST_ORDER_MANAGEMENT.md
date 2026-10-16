# Secure guest order management — Milestone 1H

Local implementation only. No deployment, live messages, payment admission,
refund execution, or live customer-data acceptance is authorized by this change.

## Access and delivery contract

The notification worker calls `GuestOrders.issue` after claiming an email
confirmation or explicitly authorized ACCESS operation. It generates 32 random
bytes, commits the domain-separated SHA-256 hash and authorization atomically,
then submits the plaintext link only through the provider's in-memory message.
The link uses `/order/manage#<token>`; the browser removes the fragment immediately
and retains the token only in component memory. Reopening the email is required
after a full reload. Neither queues, receipts, audit records nor browser storage
contain the token. Public POST bodies and provider message bodies must never be
logged by future adapters, gateways, tracing or error reporting.

A create-only issuance receipt prevents regenerating a token for the same
operation. A crash or ambiguous persistence/provider acknowledgement requires
reconciliation; there is no automatic replacement, resend, or revocation.
Authoritative rejection is FAILED even when normally retryable once a link was
issued. Provider acceptance is not proof of customer receipt. The original token
cannot be recovered. Authenticated administrators may authorize a replacement
with an idempotent request ID and reason, or separately revoke an individual
link. Existing links remain valid. Issuance atomically limits active tokens to two.

Expiration is fixed at 30 days after the original pickup window ends, stored with
issue timestamps, and never extended by pickup changes or reissuance. Ambiguous
or nonexistent Denver DST wall times fail closed. Revocation and expiration are
server-enforced. Administrative status exposes opaque grant IDs, never hashes.

## Customer workflow and atomic updates

The private page shows historical cookies, prices and totals, payment and
fulfillment status, pickup hours, location and instructions. It has no public
order-number lookup, account requirement, refund control or third-party scripts.
Responses are no-store, noindex and no-referrer. Same-origin JSON POST relays use
fixed upstream paths and bounded bodies/responses; administrator relays retain
Cognito group checks and encrypted HttpOnly sessions.

Pickup changes require PAID/CAPTURED settlement, matching refund disposition NONE,
no recorded fulfillment, and submission before 3 PM Denver the day before the
current pickup (configurable). Targets must be active future dates in the same
Drop. A transaction checks the Order, pickup revision, access revision, refund,
fulfillment absence and target pickup; it updates pickup indexes, records an
immutable change receipt, and prepares confirmation and reminder work. Historical
amounts, inventory and payment records are preserved. A lost acknowledgement is
recovered from the receipt. The UI retains the same mutation ID for retries.
Obsolete notifications are suppressed against current pickup state; past reminder
times are not retroactively fabricated.

## Configuration and release gates

- `GUEST_ORDER_ORIGIN`: exact HTTPS customer origin (CloudFormation
  `GuestOrderOrigin`, default blank, fails closed).
- `GUEST_PICKUP_CUTOFF`: Denver HH:mm, default `15:00` (`GuestPickupCutoff`).
- Existing storefront API configuration supplies the server-side guest relay.
- A future separately approved notification runtime must wire
  `issueManagementLink` to `GuestOrders.issue` for confirmation emails. Existing
  notification adapters are local mocks; live provider/worker activation is not
  implemented or authorized here. ACCESS delivery fails closed without an issuer.
- The API rate limiter allows 60 requests per minute per hashed trusted gateway
  source IP. SSR egress may aggregate customers; capacity and perimeter abuse
  controls must be validated before launch. Rate records retain one bucket per
  identity; operational retention requires a separate decision.
- New API routes, parameters and one API-only, leading-key-constrained Operations
  UpdateItem permission require a separately reviewed release. Accepted Lambda
  artifacts remain pinned; ordinary full-stack deployment remains blocked.
- No secret provisioning, provider activation, message delivery, artifact
  publication, catalog migration, media activation or payment changes occur.
- DynamoDB Local evidence is not complete managed-DynamoDB concurrency coverage.
- Hosted duplicate-activation acceptance remains NOT PASSED.

## Local evidence

Frontend: 550 tests. Backend: 1,092 tests plus 10 legacy artifact checks and one
isolated API ZIP check. Infrastructure: 133 tests. DynamoDB Local guest acceptance:
14 groups, including crash windows, uncertain delivery, explicit replacement,
revocation, expiration, duplicate/concurrent changes, rate limiting and durable
hash-only storage. Mobile at 375 px and keyboard pickup change exercised with
synthetic Orders; no horizontal overflow and unchanged historical totals.

Reproduce with the existing loopback DynamoDB fixture service on port 18765:
`node backend/scripts/test-guest-orders-local.mjs`. The optional
`node web/scripts/preview-guest-orders.mjs` is loopback-only, rejects production
mode, uses disposable synthetic records and mock delivery, and deletes its table
on shutdown. It prints no bearer link. No live email/SMS provider is used.
