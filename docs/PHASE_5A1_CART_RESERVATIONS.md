# Phase 5A1 — Atomic guest cart reservations

**DEVELOPMENT-ONLY until Phase 5A2.** Expired carts become unusable synchronously, but abandoned holds are not automatically released. This phase has no durable expiry outbox, SQS worker, or recovery workflow. Never TTL-delete an ACTIVE cart that owns inventory. Deployment is not part of this implementation approval.

## Storage and invariant

Catalog inventory remains `DROP#<dropId> / INVENTORY#<productId>` with `dropId`, `productId`, `total`, `reserved`, `sold`, `updatedAt`. All counters are nonnegative safe integers and `reserved <= total - sold`. Available is derived as `total - reserved - sold`; it is never persisted. No version field, migration, UpdateItem, table/index/TTL change, or SOLD_OUT write is introduced.

Commerce stores one `CART#<cartId> / META`:

```text
cartId, dropId, status: ACTIVE | CANCELLED | EXPIRED,
createdAt, updatedAt, shoppingExpiresAt, managementTokenHash,
items: [{ productId, quantity, priceCents, cookieUnits }]
```

Items are embedded, unique by product ID, nonempty, and limited to 12. There are no ITEM records. Terminal carts retain their final line snapshots as history; only ACTIVE lines own inventory. A terminal cart cannot be refilled. Cart and Inventory revisions advance to `max(serverNow, previousUpdatedAt + 1 millisecond)`.

Operations stores `IDEMPOTENCY#<SHA256(scoped key)> / META` with `operation`, `scope`, `version: 1`, canonical `fingerprint`, `managementTokenHash`, `cartId`, committed `response: {status, cart}`, `createdAt`, and `retainUntil` (epoch seconds, rounded up to at least seven days after commit-attempt time). The response has no capability/hash or PK/SK. Retention is metadata only: no cleanup or TTL is enabled in this phase.

## Request and authorization contract

All four routes have API Gateway AuthorizationType NONE. Application capability authorization is mandatory, including create. No Cognito login is used.

| Route                     | Body                                      | Required headers                        | Success               |
| ------------------------- | ----------------------------------------- | --------------------------------------- | --------------------- |
| POST /carts               | `{dropId, items:[{productId, quantity}]}` | X-Cart-Token, Idempotency-Key           | 201 `{cart}`          |
| GET /carts/{cartId}       | None                                      | X-Cart-Token                            | 200 `{cart, expired}` |
| PUT /carts/{cartId}/items | `{items:[{productId, quantity}]}`         | X-Cart-Token, Idempotency-Key, If-Match | 200 `{cart}`          |
| DELETE /carts/{cartId}    | Absent, empty, or `{}`                    | X-Cart-Token, Idempotency-Key           | 200 `{cart}`          |

Bodies are strict: prices, cookie units, deadlines and unknown fields are rejected. Quantities must be positive safe integers. Bodies are limited to 16 KiB before decoding. Header names are case insensitive; conflicting duplicate names are rejected.

Before create, the client generates and retains 32 cryptographically random bytes and encodes them as exactly 43 canonical unpadded base64url characters. Send them only in `X-Cart-Token`. Server hashing is SHA-256 over `batch-and-batter:cart-capability:v1:<encoded capability>`. Only the hash is persisted. Fixed 32-byte decoded hashes use `timingSafeEqual`; nonexistent carts use a dummy hash before returning the same 401 as a wrong capability. Cart IDs alone confer no access. No token rotation exists in this phase. Client entropy cannot be inferred from an input string; secure generation is a client obligation.

Cart responses use `Cache-Control: no-store` and a strong quoted ETag: SHA-256 of `cart-revision:v1:<updatedAt>`. PUT requires the exact prior ETag; wildcard/weak/missing/malformed revisions are rejected. A valid but stale revision returns 409 CART_CONFLICT. Idempotency is checked before revision, so a legitimate replay returns its original response even if the cart has since changed. Use GET for current state.

## Idempotency and replay protection

Key syntax is `v1.<13-digit Unix milliseconds>.<43-character canonical base64url random component>`; generate the final component from 32 random bytes. A new request accepts keys younger than 24 hours and no more than five minutes in the future. Exactly 24 hours old is rejected. The server checks the window again immediately before each transaction attempt.

Scope is `cart:v1:<create|replace|release>:<cartId|new>`. The database key hashes `<scope>:<raw key>`. Fingerprints hash a fixed-field JSON object containing operation, cartId/null, dropId/null, product-ID-sorted desired quantities, and If-Match/null. Different item ordering alone is equivalent; changed desired quantities or revision are different requests. The raw key is neither stored nor logged.

Receipt creation is conditional on absence and is in the **same transaction** as cart/inventory writes. Matching key/request/capability returns the stored success snapshot without writes. Different request returns IDEMPOTENCY_CONFLICT; wrong capability returns UNAUTHORIZED before exposing the snapshot. Concurrent duplicates and ambiguous/lost transaction responses consistently reread the receipt. If a winner is not yet observable or the deadline is exhausted, CART_BUSY instructs the client to retry the **same key, body, capability and If-Match**. Do not mint another key merely because a response was lost.

Retained receipts are replayable even after the new-key window. If a receipt is eventually cleaned up, an ancient timestamp cannot pass the new-request window and cannot reacquire stock. Cleanup must respect retainUntil. DynamoDB ClientRequestToken is not used; the transactionally stored receipt is the application replay authority.

## Timer, edits and snapshots

The first successful nonempty create uses server time sampled immediately before its successful transaction attempt, plus 480 seconds. The timer is persisted atomically with the first ownership. Failed attempts do not establish a cart or deadline. PUT, reductions, DELETE and replay never extend the deadline. DynamoDB does not provide a wall-clock commit timestamp or evaluate a live clock in conditions: server time is sampled before dispatch, not at an unknowable physical commit instant.

At `serverNow >= shoppingExpiresAt`, new edits fail RESERVATION_EXPIRED. Deadline is checked before validation and again before dispatch; Cart Put additionally checks the stored deadline against that sampled time. An in-flight transaction may finish after the sampled instant; the deadline never moves, and subsequent use is expired. Historical idempotent responses are not permission to use an expired cart.

PUT is a full desired nonempty set. Deltas are calculated over the sorted union of old and desired IDs. Any positive delta is acquisition, including substitution. OPEN permits acquisition subject to all guards below. PAUSED/CLOSED permit only reductions/no-op desired quantities: no new ID or increase. Pure reductions need neither active Products nor a storefront pointer; they read the Drop for its quantity limit. DELETE requires no Drop/Product/storefront read and can settle even if the Drop is missing. It writes CANCELLED before expiry or EXPIRED at/after expiry. Repeated release never subtracts terminal history a second time.

The order limit is `sum(quantity * cookieUnits) <= Drop.quantityLimit`, independent of the 12 distinct-product cap. Arithmetic checks both products and accumulated sums for safe integers. Existing accepted lines retain their price/cookie-unit snapshots; newly added lines take validated server-side DropProduct values. Removing and later adding a line is a new acceptance. Client-supplied prices/units are rejected.

## Exact transaction protocol

All reads used for validation are consistent. Transactions span the existing Catalog, Commerce and Operations tables in the same account/Region. No target repeats in one transaction. Product IDs and changed inventory IDs are independently sorted.

Let D be desired distinct products, M be changed inventory records, and H be currently held distinct products. `d` is the Drop ID, `p` a Product ID, and `c` the Cart ID.

| Action kind      | Table and PK / SK                    | Exact ConditionExpression                                                                                       |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Drop check       | Catalog `DROP#d / META`              | `attribute_exists(PK) AND #status = :open AND #updated = :expected`                                             |
| Storefront check | Catalog `STORE#CONFIG / STOREFRONT`  | `#storefrontDropId = :dropId`                                                                                   |
| Product check    | Catalog `PRODUCT#p / META`           | `attribute_exists(PK) AND #active = :active AND #updated = :expected`                                           |
| Inventory Put    | Catalog `DROP#d / INVENTORY#p`       | `attribute_exists(PK) AND #total = :total AND #reserved = :reserved AND #sold = :sold AND #updated = :expected` |
| New Cart Put     | Commerce `CART#c / META`             | `attribute_not_exists(PK)`                                                                                      |
| Edit Cart Put    | Commerce `CART#c / META`             | `attribute_exists(PK) AND #status = :status AND #updated = :expected AND #token = :token AND #expires > :now`   |
| Release Cart Put | Commerce `CART#c / META`             | `attribute_exists(PK) AND #status = :status AND #updated = :expected AND #token = :token`                       |
| Receipt Put      | Operations `IDEMPOTENCY#hash / META` | `attribute_not_exists(PK)`                                                                                      |

Expression names map `#status → status`, `#updated → updatedAt`, `#storefrontDropId → storefrontDropId`, `#active → active`, `#total → total`, `#reserved → reserved`, `#sold → sold`, `#token → managementTokenHash`, `#expires → shoppingExpiresAt`. Each action supplies only its used names. Values are `:open=OPEN`, `:dropId=d`, `:active=true`; `:expected` is that item's exact read updatedAt. Inventory supplies exact old total/reserved/sold; Cart supplies exact old status and caller capability hash; edit supplies `:now` as sampled UTC ISO time. Absence conditions need no names/values.

- **POST:** index 0 Drop, 1 storefront, 2 through D+1 Products, D+2 through 2D+1 Inventory, 2D+2 Cart, 2D+3 receipt. `4 + 2D`, at most 28 actions.
- **PUT with acquisition:** 0 Drop, 1 storefront, 2 through D+1 Products, D+2 through D+M+1 Inventory, D+M+2 Cart, D+M+3 receipt. `4 + D + M`, at most 40 (12 desired, up to 24 changed inventory records).
- **PUT reduction-only:** 0 through M−1 Inventory, M Cart, M+1 receipt. `M + 2`, at most 14; a no-op uses two actions. Same edit Cart condition, no acquisition checks.
- **DELETE:** 0 through H−1 Inventory, H Cart, H+1 receipt for ACTIVE carts. `H + 2`, at most 14. Already-terminal release uses just Cart and receipt with no stock writes.

Drop checks require exact OPEN revision; pointer must name that Drop; **every desired reusable Product** must exist, be active, and have its exact validated revision. Desired DropProducts are consistently validated for relationship, activity, positive price and valid cookie units. Separate DropProduct ConditionChecks rely on the existing protocol: composition is DRAFT-only and advances Drop.updatedAt. Do not weaken that protocol without revisiting these transactions. Reservations never advance Drop.updatedAt or change lifecycle status.

### Why oversell cannot commit

For each delta, compute and validate the complete next inventory snapshot before sending. A Put commits only if **all four old values** still match. Concurrent readers cannot both replace the same old snapshot: one wins; the other condition fails. Monotonically advancing updatedAt prevents returning to an indistinguishable earlier snapshot. DynamoDB commits all inventory records, Cart ownership and receipt together or none. Therefore a valid initial inventory invariant is preserved by each serialized commit, with no partial multi-product ownership. Cart revision/status conditions prevent concurrent edits/releases from applying the same old ownership twice. Future expiry/payment writers must honor this same atomic ownership protocol.

### Cancellation mapping and retries

Receipt replay is attempted before interpreting cancellation. Mapping follows the action-kind array, so variable Product/inventory counts do not shift meanings:

| Failed conditional action            | Result                                             |
| ------------------------------------ | -------------------------------------------------- |
| Drop (index 0 for acquisition)       | 409 DROP_NOT_OPEN                                  |
| Storefront (index 1 for acquisition) | 409 STOREFRONT_CONFLICT                            |
| Product (indexes 2..D+1)             | 409 PRODUCT_NOT_AVAILABLE                          |
| Inventory                            | Contention retry with fresh reads                  |
| Cart (penultimate)                   | 409 CART_CONFLICT                                  |
| Receipt (last)                       | Resolve committed receipt; otherwise 503 CART_BUSY |

TransactionConflict is retryable only after fresh validation. Maximum six transaction sends; full-jitter delay `random() * min(250, 25 * 2^attempt)` milliseconds. Overall mutation budget is about two seconds. Every SDK call has an abort deadline bounded by that budget and Lambda remaining time minus a 200 ms response margin; attempts start only with at least 650 ms Lambda time. The cart-specific SDK client has maxAttempts=1, connection timeout 300 ms and request timeout 700 ms. SDK abort/timeout does **not** prove no commit; retry the same idempotency key.

Fresh reads revalidate lifecycle and Products. Observed Cart and acquisition Drop revisions cannot silently change across retries. Conditional lifecycle/Product/Cart failures are terminal for that request. A fresh actual shortage returns INSUFFICIENT_INVENTORY; exhausting contention budget returns CART_BUSY, never a fabricated shortage. Unrecognized/missing cancellation reasons or ambiguous transaction failures return CART_BUSY. Raw AWS errors/reasons are never exposed.

## Safe errors and logging

Canonical specification codes RESERVATION_EXPIRED and QUANTITY_LIMIT_EXCEEDED are retained. New state/revision terminology is CART_*.

| Code                                                                       | HTTP                |
| -------------------------------------------------------------------------- | ------------------- |
| VALIDATION_ERROR                                                           | 400                 |
| UNAUTHORIZED (missing/invalid capability, absent Cart or wrong capability) | 401                 |
| RESERVATION_EXPIRED                                                        | 410                 |
| CART_CONFLICT                                                              | 409                 |
| IDEMPOTENCY_CONFLICT                                                       | 409                 |
| IDEMPOTENCY_KEY_EXPIRED                                                    | 409                 |
| DROP_NOT_OPEN                                                              | 409                 |
| STOREFRONT_CONFLICT                                                        | 409                 |
| PRODUCT_NOT_AVAILABLE                                                      | 409                 |
| INSUFFICIENT_INVENTORY                                                     | 409                 |
| QUANTITY_LIMIT_EXCEEDED                                                    | 409                 |
| CART_BUSY                                                                  | 503, Retry-After: 1 |
| INTERNAL_ERROR (invalid stored data/unexpected failure)                    | 500                 |

Fixed operations: createCart, getCart, updateCart, releaseCart. Logs contain request.completed, validated API requestId and Lambda request ID, fixed routeKey/operation, statusCode, allowlisted code, transaction attempts and durationMs. No headers, capability/hash, idempotency key, body, Cart contents, PII, payment data or AWS exception/cancellation payload is logged. Successful DTOs expose only explicit Cart fields/lines, never storage keys or capability hashes.

## Infrastructure and IAM

Four NONE-authorized routes, four Lambda integrations and four route-scoped invocation permissions are added. Existing Lambda code changes and adds COMMERCE_TABLE_NAME / OPERATIONS_TABLE_NAME environment references. Two new application-role Allow statements:

- `dynamodb:GetItem`, `dynamodb:PutItem` on the exact existing CommerceTable ARN.
- `dynamodb:GetItem`, `dynamodb:PutItem` on the exact existing OperationsTable ARN.

Catalog permissions remain exactly GetItem, Query, PutItem, DeleteItem, ConditionCheckItem on its existing table ARN. No new Query/ConditionCheckItem privilege is needed for Commerce/Operations: conditions are part of Put. Existing Scheduler, PassRole and logging permissions are unchanged. No tables, TTL, indexes, Cognito, S3, SQS, Scheduler or EventInvokeConfig change.

## Validation and future boundaries

Offline transaction tests evaluate every condition before applying any Put, force concurrent interleavings, and check nonnegative counters plus exact aggregate ACTIVE-cart ownership after every commit. The 20-client × 10-unit test against 100 units requires ten winners and exactly 100 held, with safe shortage results for the rest and client contention retry bounded by five seconds. Tests include 12-product limits, 40-action substitution, lifecycle/Product/revision races, duplicate/lost-response receipts, expiry, releases, strict HTTP validation, public route dispatch and safe logging. Existing catalog/admin/lifecycle/automatic-opening and bundle suites remain regression coverage.

Phase 5A2 must provide durable expiry scheduling/outbox delivery, idempotent atomic release, retries and recovery, without deleting live ownership. Phase 5B adds the separately reviewed payment states, grace and payment/inventory conversion rules. Neither worker nor payment states are implemented here. SOLD_OUT remains derived availability while a Drop is OPEN. No production launch is appropriate before durable expiry recovery.

### Local validation record

- Backend typecheck/build: passed; 412 functional tests (including 37 cart tests) and 5 artifact tests passed.
- Infra typecheck/build: passed; all 18 tests passed, including an exact pre-Phase-5A1 resource baseline comparison.
- Backend and infra npm audits: zero vulnerabilities at every severity.
- CDK synth with lookups disabled: passed. Local baseline confirms no existing resource deletions or changes beyond approved Lambda code/environment and scoped policy additions.
- Formatting and `git diff --check`: passed.
- Live read-only CDK diff: passed after SSO refresh using the requested profile and command (`--no-change-set --lookups=false`). Exactly four routes, four integrations and four Lambda invocation permissions are added. Only the existing Lambda code/environment and application-role policy are updated. No replacements, deletions, table/schema/TTL/index changes or unrelated resource changes appear. No deployment or AWS mutation was attempted.

Dependencies and lockfiles were unchanged and installed modules supported all checks, so npm ci was not necessary under the continuation instructions. Work remains uncommitted on `feature/phase-5a1-cart-reservations` for human review.
