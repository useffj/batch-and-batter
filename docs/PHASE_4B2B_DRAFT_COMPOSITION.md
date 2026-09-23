# Phase 4B2B1: DRAFT Drop composition

This phase lets an authorized administrator assemble the products, prices, initial inventory and pickup dates for a DRAFT Drop. It extends Phase 4B2A's Product/Drop metadata writes. Earlier documents describing composition and DELETE routes as unavailable are historical. Publishing remains Phase 4B2B2, and no admin UI is added here.

A reusable **Product** describes a cookie: name, ingredients, allergens and other catalog details. A **DropProduct** associates that cookie with a particular Drop and supplies its price in integer cents, cookie-unit value, display order and active flag. The same cookie can therefore cost different amounts in different Drops without duplicating its description.

**Inventory** is a separate record because stock changes independently from descriptions and pricing. Its total allocation, reserved count and sold count describe one Product in one Drop. Available inventory is calculated as `total - reserved - sold`. Attaching a Product creates its DropProduct and Inventory together so an association cannot be created with missing inventory by this operation.

```text
DROP#<dropId>
├── META                         DRAFT
├── PRODUCT#<productA>
├── INVENTORY#<productA>
├── PRODUCT#<productB>
├── INVENTORY#<productB>
├── PICKUP#2026-10-08
├── PICKUP#2026-10-09
└── PICKUP#2026-10-10
```

## Authorization and public privacy

All six routes use the existing API Gateway JWT authorizer and the same `requireAdmin` helper as the existing admin routes. Gateway validates signatures and JWT claims. Lambda requires an access token, nonblank subject and username, and exact membership in `batch-and-batter-admins`. It does not perform custom signature verification or call Cognito. Authorization occurs before input parsing or repository creation. Responses use `Cache-Control: no-store`.

`GET /health`, `GET /drops/current` and `GET /drops/{dropId}` remain public. The unchanged storefront read layer hides DRAFT Drops even if a storefront pointer references one. This phase cannot publish a Drop, change its status, write `STORE#CONFIG`, schedule opening, or start commerce activity. Publishing requires a separately reviewed lifecycle and complete-composition validation, so it is intentionally deferred.

## Routes and explicit response models

All paths below begin with `/admin/drops/{dropId}`. IDs must be valid existing-domain ULIDs; pickup dates must be valid `YYYY-MM-DD` calendar dates.

| Method and suffix              | Success | Behavior                                                              |
| ------------------------------ | ------- | --------------------------------------------------------------------- |
| GET `/composition`             | 200     | Administrative composition, including DRAFT and inactive records      |
| POST `/products`               | 201     | Attach an existing reusable Product and allocate inventory            |
| PUT `/products/{productId}`    | 200     | Replace all editable DropProduct configuration and initial allocation |
| DELETE `/products/{productId}` | 200     | Remove the association and its inventory together                     |
| PUT `/pickups/{date}`          | 200     | Create or replace this pickup-date resource                           |
| DELETE `/pickups/{date}`       | 200     | Remove this existing pickup-date resource                             |

Composition GET returns `{ drop, products, inventory, pickupDates }`:

- `drop`: the existing explicit admin Drop DTO, including status and audit timestamps.
- `products`: entries containing `{ product, dropProduct }`. Product uses the existing admin Product DTO. DropProduct includes only dropId, productId, priceCents, cookieUnits, displayOrder and active. Entries sort by displayOrder then productId. Inactive Products and associations are included. A missing reusable Product is represented by `product: null` so a broken reference remains visible.
- `inventory`: all inventory records, including orphans, sorted by productId. Each explicitly includes dropId, productId, total, reserved, sold, updatedAt and derived available. An association with missing inventory has no matching entry; no stock is invented.
- `pickupDates`: all pickup records, including inactive dates, sorted by date, with dropId, date, startTime, endTime, timezone and active.

All DTOs explicitly select fields; PK/SK and AWS metadata never appear. Reads use the existing consistent, paginated Get/Query methods. The response is informational, not an atomic multi-record snapshot. Sequential Product Gets retain the existing small-menu latency assumption. GET also permits existing non-DRAFT Drops for administrative inspection.

POST `/products` requires:

```json
{
  "productId": "01K5J100000000000000000002",
  "priceCents": 450,
  "cookieUnits": 1,
  "displayOrder": 0,
  "active": true,
  "inventoryTotal": 100
}
```

PUT `/products/{productId}` requires the same five configuration fields without productId. PUT is a full replacement, not a partial patch. Price, display order and total are nonnegative safe integers; cookieUnits is a positive safe integer; active is boolean. Unknown fields are rejected. Clients cannot set dropId, keys, reserved, sold or updatedAt. POST's validated productId selects the existing reusable Product; PUT's productId comes only from the path.

Success returns `{ dropProduct, inventory }`. The server generates inventory.updatedAt. New inventory starts with reserved=0 and sold=0. Replacements preserve those counts by requiring both stored values to be zero in the write condition; only then can a zero-valued replacement commit. This condition applies to every configuration PUT, including price-only intent, because PUT replaces the full allocation. Negative totals and invalid invariants cannot reach the database.

Product removal returns `{ deleted: true }`. It deletes only `DROP#<dropId>/PRODUCT#<productId>` and `DROP#<dropId>/INVENTORY#<productId>`. The reusable `PRODUCT#<productId>/META` is never a delete target. Reserved/sold counts must be zero before removal or replacement: changing allocation or deleting inventory that has commercial activity could discard obligations. Total allocation does **not** need to be zero.

PUT `/pickups/{date}` accepts:

```json
{
  "startTime": "16:00",
  "endTime": "19:00",
  "timezone": "America/Denver",
  "active": true
}
```

Strict validation rejects body date/dropId and unknown fields. Existing domain rules require valid `HH:MM` times and endTime later than startTime on the same date. Overnight windows are unsupported. The timezone must be recognized by the existing Intl rule; omission retains the existing America/Denver default. Success returns `{ pickup }` with the explicit pickup DTO. Repeating the same PUT intentionally produces the same resource state. Neither pickup operation changes Drop metadata or its timestamps. Pickup DELETE returns `{ deleted: true }`; repeating a successful DELETE returns 404.

## Transactions and exact conditions

A DynamoDB transaction is a group of changes committed together: all succeed or none do. Here every mutation sends exactly one SDK v3 `TransactWriteCommand` through the existing DynamoDBDocumentClient. It targets only CatalogTable and only two to four distinct items. No item is targeted twice. There is no BatchWrite, Scan, PartiQL, Update or table-wide operation.

An initial consistent Drop read returns a useful 404 for an already absent Drop, or 409 for a non-DRAFT Drop. It is **not** the write authorization. Every transaction checks `DROP#<dropId>/META` again atomically. A future publication or deletion between the read and the write causes the entire transaction to fail, including any inventory changes.

| Label          | Exact ConditionExpression                                      | Names and values                              |
| -------------- | -------------------------------------------------------------- | --------------------------------------------- |
| DRAFT          | `attribute_exists(PK) AND #status = :draft`                    | `#status=status`, `:draft=DRAFT`              |
| Exists         | `attribute_exists(PK)`                                         | None                                          |
| Absent         | `attribute_not_exists(PK)`                                     | None                                          |
| Inventory zero | `attribute_exists(PK) AND #reserved = :zero AND #sold = :zero` | `#reserved=reserved`, `#sold=sold`, `:zero=0` |

Conditions apply to each full PK/SK item key, not to every item sharing the PK.

| Mutation              | Ordered transaction actions                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Attach Product        | 1. ConditionCheck Drop META (DRAFT). 2. ConditionCheck reusable Product META (Exists). 3. Put DropProduct (Absent). 4. Put Inventory (Absent).         |
| Replace configuration | 1. ConditionCheck Drop META (DRAFT). 2. ConditionCheck reusable Product META (Exists). 3. Put DropProduct (Exists). 4. Put Inventory (Inventory zero). |
| Remove Product        | 1. ConditionCheck Drop META (DRAFT). 2. Delete DropProduct (Exists). 3. Delete Inventory (Inventory zero).                                             |
| Put pickup            | 1. ConditionCheck Drop META (DRAFT). 2. Put pickup at path date (unconditional create/replace within the transaction).                                 |
| Remove pickup         | 1. ConditionCheck Drop META (DRAFT). 2. Delete pickup at path date (Exists).                                                                           |

These use [DynamoDB's all-or-nothing transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html). Product removal does not require the reusable Product to exist, allowing an otherwise valid orphaned association to be removed.

## Errors and cancellation mapping

The API retains `{ code, message, requestId }`. No raw AWS cancellation reason, item, token, body or credentials is returned or logged. Unexpected failures log only the admin-failure event label and request ID, then return generic 500 `INTERNAL_ERROR`.

| Status/code                  | Meaning                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| 400 `VALIDATION_ERROR`       | Invalid path, JSON, fields, date/time/timezone, numeric value or unknown field           |
| 401 `UNAUTHORIZED`           | Missing authentication or malformed subject/username                                     |
| 403 `FORBIDDEN`              | Wrong token purpose or missing exact admin membership                                    |
| 404 `DROP_NOT_FOUND`         | Drop absent on initial read, including composition GET                                   |
| 404 `PRODUCT_NOT_FOUND`      | Attach/replace reusable Product existence condition fails                                |
| 404 `DROP_PRODUCT_NOT_FOUND` | Replace/remove association existence condition fails                                     |
| 404 `PICKUP_NOT_FOUND`       | Pickup delete existence condition fails                                                  |
| 409 `DROP_NOT_EDITABLE`      | Initial non-DRAFT status, or atomic Drop condition fails (including concurrent deletion) |
| 409 `DROP_PRODUCT_CONFLICT`  | Either association or inventory already exists during attach                             |
| 409 `INVENTORY_NOT_EDITABLE` | Inventory condition fails and consistent reread confirms reserved or sold activity       |
| 409 `COMPOSITION_CONFLICT`   | Transaction conflict, or failed inventory condition with missing/changed inventory       |

Cancellation reasons are evaluated in transaction order: Drop first, then reusable Product where applicable, association, inventory. Multiple conditional failures therefore have deterministic precedence. Inventory failures use a consistent reread to distinguish activity from missing/changed data; classification describes that reread and can change under another concurrent edit. Invalid stored records or failures of that reread remain generic 500s. No fallback writes or unconditional retry are performed.

Unknown service cancellation codes, absent/malformed reason lists and non-cancellation failures propagate to the generic 500 handler. Throttling/validation/service failures are not misreported as business conflicts. API Gateway rejections occur before Lambda and may use Gateway's own response shape.

## IAM

CatalogTable's exact action set is:

```text
dynamodb:GetItem
dynamodb:Query
dynamodb:PutItem
dynamodb:DeleteItem
dynamodb:ConditionCheckItem
```

ConditionCheckItem authorizes the transaction's condition-only checks without modifying those records. Transaction Put/Delete actions use their underlying PutItem/DeleteItem permissions, as described in [AWS transaction IAM guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html). No separate `dynamodb:TransactWriteItems` IAM action is added. No UpdateItem, wildcard, Scan, BatchWriteItem, CommerceTable, OperationsTable, SQS, SES, Cognito management or S3 write access is added. Existing `logs:CreateLogStream` and `logs:PutLogEvents` remain scoped to the existing log group. The application enforces the key and DRAFT rules; the role is scoped to CatalogTable's ARN. API Gateway invoke permissions remain route-scoped.

## Concurrency, idempotency and follow-ups

DropProduct and pickup records have no version fields. Complete replacements therefore retain last-writer-wins behavior among authorized edits while the Drop remains DRAFT. A stale admin form may replace a newer configuration; a delete may remove a concurrently edited resource. Inventory existence and zero-activity conditions always remain enforced. No model redesign or client ETag protocol is introduced in this phase. Inventory.updatedAt is a server timestamp, not an optimistic-lock version and need not increase across concurrent requests.

Duplicate POST attachment cannot partially create or overwrite a pair; it returns conflict. A new request after an ambiguous network failure has no application idempotency key. Pickup PUT is idempotent in resulting resource state; Product PUT refreshes its server timestamp. DELETE is not response-idempotent (a repeat returns 404). A timeout or generic 500 does not prove a transaction failed to commit: inspect composition before retrying. Do not blindly replay stale requests after another administrator has changed the draft.

Production follow-ups remain MFA, deliberate admin provisioning/removal, browser token handling, rate limiting, operational audit history and reviewed publication/commerce workflows. No new dependency is introduced; pinned dependencies and lockfiles remain unchanged. Tests establish offline correctness of generated SDK requests and a fake atomic store, not live service acceptance. Deployment and separately authorized live verification remain human review steps.

## Local validation and review

Completed on 2026-09-23:

- Main was clean and its HEAD matched remote main at `5779fcd` before creating `feature/phase-4b2b1-draft-composition`.
- Backend: `npm ci`, typecheck, build, **179 functional tests** and **5 artifact tests** passed. Tests cover all mutations, actual generated transaction inputs, atomic fake-store behavior, publication/deletion races, inventory activity, strict request validation, DTOs, authorization and public privacy. A mock HTTP transport also verifies that the pinned SDK serializes the transaction and preserves cancellation reasons without making network calls.
- Infrastructure: `npm ci`, typecheck/build, **16 tests**, and `npx cdk synth --lookups=false` passed. The existing notice about 83 unconfigured feature flags remains. The full resource baseline fixture was generated from main's stack source before this change; it excludes metadata and allows only Lambda code and the separately asserted IAM policy to change.
- Backend and infrastructure `npm audit --json` each report **zero vulnerabilities**. Advisory lookup required network permission. No dependency, package manifest or lockfile changed, and no audit fix was run.
- Repository-wide Prettier validation and `git diff --check` passed. Web source/configuration is unaffected, so web application tests/build were not repeated. Its previously documented dependency risk is unchanged.
- The approved read-only development comparison succeeded in us-east-2 using `npx cdk diff batch-and-batter-dev --profile batch-and-batter-dev --no-change-set --lookups=false`. Sandbox account resolution initially failed; rerunning with approved network/profile access succeeded. No temporary credential workaround or profile modification was needed.
- AWS diff: **18 resource additions**, comprising six JWT routes, six integrations and six invocation permissions; **two existing resources updated**, comprising the application IAM policy and Lambda bundle. No resource replacement/deletion, table changes, Cognito changes, API replacement, storefront mutation or unrelated infrastructure changes. No CloudFormation change set was created.
- Source/artifact review found no live secrets or credentials. SDK transport tests use explicit synthetic values and replace the entire HTTP transport. Tests and seed tooling remain excluded from the deployment artifact.
- Final working tree: **six modified tracked files and seven new files**, all unstaged. No commit, push, deployment, live DynamoDB mutation, Cognito mutation or live sign-in occurred. Remote CI and live acceptance have not run.

Added files: `backend/src/admin-composition.ts`; `backend/test/admin-composition.test.ts`; `backend/test/composition-transactions.test.ts`; `backend/test/composition-store.ts`; `backend/test/composition-sdk.test.ts`; `infra/test/fixtures/phase-4b2a-resources.json`; this document.

Changed files: `backend/src/admin-writes.ts` (reuse validation/body/DTO helpers); `backend/src/api.ts`; `backend/src/repository.ts`; `backend/test/fixtures.ts`; `infra/lib/development-stack.ts`; `infra/test/development-stack.test.ts`.

Implementation is ready for human review. Live verification requires separately approved deployment and disposable DRAFT data.

Suggested commit after review: `feat: add draft drop composition management`.
