# Phase 4A: Catalog and read-only Drops

Phase 4A adds the catalog data layer and customer read APIs. Phase 3B's development stack already exists in us-east-2. These changes are local and require review before deployment. Phase 4B will add authenticated administration; this phase has no administrative write routes, Cognito client, authorizer, or admin UI.

## Understanding the records

A DynamoDB **item** is one stored record, roughly like a row, with named attributes. Our table has two key attributes:

- **PK (partition key)** identifies the group the item belongs to.
- **SK (sort key)** identifies the item within that group. The pair uniquely identifies a record.

`DROP#<dropId>` groups a Drop's metadata, product relationships, inventory, and pickup dates. A Query can retrieve one family of records by PK and SK prefix, without scanning the table.

```text
DROP#<dropId>
├── META
├── PRODUCT#<productId>
├── INVENTORY#<productId>
└── PICKUP#<YYYY-MM-DD>
```

| Record                  | PK                    | SK                      |
| ----------------------- | --------------------- | ----------------------- |
| Product                 | `PRODUCT#<productId>` | `META`                  |
| Drop                    | `DROP#<dropId>`       | `META`                  |
| DropProduct             | `DROP#<dropId>`       | `PRODUCT#<productId>`   |
| DropInventory           | `DROP#<dropId>`       | `INVENTORY#<productId>` |
| PickupDate              | `DROP#<dropId>`       | `PICKUP#<YYYY-MM-DD>`   |
| StorefrontConfiguration | `STORE#CONFIG`        | `STOREFRONT`            |

Internal Product and Drop IDs are immutable ULIDs, independent of editable names and human-readable slugs. The seed uses fixed ULIDs so changing its example names or opening time cannot silently create another copy on rerun. Future authenticated creation should generate new ULIDs.

A **Product** is reusable: its name, slug, description, ingredients, allergens, active flag, and creation/update timestamps do not change simply because it appears in another Drop. The Product schema rejects price and inventory attributes.

**DropProduct** connects a Product to a particular Drop. Its price, cookie-unit value, display order, and active flag can differ between Drops. Money uses safe integer cents: `$4.50` is `450`. Fractional, negative, unsafe, and nonnumeric prices are rejected. Cookie-unit values are positive integers.

**Inventory** is separate because it changes independently of product descriptions and pricing. It contains `total`, `reserved`, `sold`, and `updatedAt`, alongside both IDs. Counts are nonnegative safe integers and `reserved + sold <= total`. Initial reserved/sold counts default to zero. `available = total - reserved - sold` is calculated rather than independently stored. No reservation mutations exist in Phase 4A.

**Pickup dates** are records because each Drop can offer a different set of dates and hours. Each includes its Drop ID, valid calendar date, `HH:mm` start/end times, timezone, and active flag. End must be later than start on that date; overnight windows are not supported. Customers choose the date, with no appointment capacity. Default timezone is `America/Denver` and valid timezone overrides are accepted.

A **Drop** contains name, description, status, configurable UTC opening timestamp, optional later closing timestamp, quantity limit (default 12), timezone, pickup location/instructions, and audit timestamps. Opening is never tied to a weekday. The seven valid statuses remain DRAFT, SCHEDULED, OPEN, PAUSED, SOLD_OUT, CLOSED, and COMPLETED. No automatic opening is implemented.

**STORE#CONFIG / STOREFRONT** contains an optional `storefrontDropId` and an `updatedAt` timestamp. It is the authoritative pointer to the Drop the storefront should display. An absent record or unset pointer means no current Drop; skipped weeks are valid. The pointer may refer to an upcoming SCHEDULED Drop.

## Customer APIs

| Route                 | Behavior                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`         | Existing 200 response, unchanged: `{"status":"ok","service":"batch-and-batter-api"}`. No database access or table configuration required.                |
| `GET /drops/current`  | 200 with `{"drop": {...}}`, or `{"drop": null}` when no pointer, missing target, DRAFT, or COMPLETED.                                                    |
| `GET /drops/{dropId}` | 200 with `{"drop": {...}}` for SCHEDULED, OPEN, PAUSED, SOLD_OUT, CLOSED. Missing, DRAFT, and COMPLETED return the same 404. Malformed ULID returns 400. |

COMPLETED is deliberately not public in this phase. Visibility depends on stored status; timestamps do not automatically change status. Availability describes stock, not permission to order: a SCHEDULED/PAUSED/CLOSED Drop can still have available stock.

Drop DTOs expose `id`, `name`, `description`, `status`, `opensAt`, optional `closesAt`, `quantityLimit`, `timezone`, `pickupLocation`, `pickupInstructions`, `products`, and `pickupDates`.

Product DTOs expose `id`, `name`, `slug`, `description`, `ingredients`, `allergens`, `priceCents`, `cookieUnits`, `displayOrder`, and `availability` containing `total`, `reserved`, `sold`, and `available`, as requested for development. Only active DropProduct relationships and active Products appear. Products sort by display order, then ID. Only active pickup dates appear, sorted by date, with date/hours/timezone fields.

Responses explicitly map these fields. They never serialize database items directly, so PK/SK and internal timestamps do not escape into the API. Database keys are implementation details, not customer data.

Drop responses use `Cache-Control: no-store`. Errors use the technical specification's contract:

```json
{
  "code": "DROP_NOT_FOUND",
  "message": "Drop not found.",
  "requestId": "api-gateway-request-id"
}
```

Other codes are `INVALID_DROP_ID`, `NOT_FOUND`, and `INTERNAL_ERROR`. Invalid stored records, missing active Product/inventory records, and SDK failures return a generic 500, never made-up stock or raw SDK errors. Logs contain only a catalog-failure event and request ID. A missing storefront target returns null so customers see no current Drop; operators should inspect the pointer if this is unexpected.

The repository owns DynamoDB access. It validates runtime data and key/attribute identity, uses strongly consistent Get/Query calls, and paginates Query results. It does not use Scan or write commands. Strong consistency on each read does not make the entire multi-record response an atomic snapshot. Future purchase/reservation logic must revalidate transactionally. Per-product Gets are sequential to bound concurrency; the intended weekly menu is small. Revisit batching/latency if menus grow.

## Lambda and permissions

The existing `lambda.Function` construct `ApplicationApi`, physical name, logical ID `ApplicationApi5D63FF39`, Node.js 24.x runtime, health integration, memory, and timeout remain. The handler becomes `handler.handler`, and `CATALOG_TABLE_NAME` is supplied from the existing table reference.

The Lambda role retains scoped CloudWatch stream/event writes and adds only `dynamodb:GetItem` and `dynamodb:Query` on CatalogTable's exact ARN. It has no CommerceTable, OperationsTable, DynamoDB write/Scan, SQS, S3, Cognito, SES, or administrator permissions. Tables, queues, Cognito pool, bucket, and log retention remain unchanged.

Public administrative writes must wait for Phase 4B's Cognito client, admin authentication, and JWT authorizer. Hiding controls in a future UI would not protect an unauthenticated write API.

## Backend package and deployment artifact

```text
backend/
├── src/                 # domain, keys, repository, DTO composition, API, handler, health
├── tools/               # local-only seed CLI and seed plan
├── test/                # offline domain/API/repository/seed tests
├── scripts/             # esbuild, artifact verification and artifact tests
├── package.json
├── package-lock.json
├── tsconfig.json
└── dist/                # generated, ignored
    ├── lambda/handler.js
    ├── bundle-meta.json
    └── ...              # compiled tests/tools, outside deployment artifact
```

Exact runtime pins: `@aws-sdk/client-dynamodb@3.1137.0`, `@aws-sdk/lib-dynamodb@3.1137.0`, `zod@4.6.5`. Development pins: `@aws-sdk/credential-providers@3.1137.0`, `esbuild@0.28.2`, `typescript@5.9.3`, `@types/node@24.10.1`. The explicit credential-providers package is imported only by local seed tooling. The DynamoDB client's own production credential chain remains a production transitive dependency and can use Lambda execution-role credentials.

`node scripts/build.mjs` bundles `src/handler.ts` for `platform: node`, `target: node24`, `format: cjs`, with `packages: bundle`. It is unminified, without source maps, and includes inline license comments. No environment substitution, timestamps, or absolute host paths are injected. Runtime AWS SDK and Zod code are included; only Node built-ins remain external. This follows [AWS's deployment dependency guidance](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-package.html) and [esbuild's bundling options](https://esbuild.github.io/api/).

CDK still uses `Code.fromAsset`, now on `backend/dist/lambda/` alone. Only `handler.js` is shipped. The build clears this generated directory before writing, and stores an inspectable esbuild input/output manifest outside it. Tests verify byte-identical rebuilds, allowlisted artifact contents, production-only dependency inputs, required bundled packages, built-in-only externals, no seed/tests/env/credentials/CDK sources, and an isolated health invocation without local node_modules or AWS credentials. Credential checks detect common access-key/private-key patterns; they are a guardrail, not a universal secret detector.

## Development seed safety and review

The CLI requires `--table batch-and-batter-dev-catalog`, `us-east-2`, and profile `batch-and-batter-dev`. Profile/region/table overrides are refused. Conflicting environment region/profile and custom endpoint settings are rejected. The client explicitly uses the named profile and the regional DynamoDB HTTPS endpoint rather than ambient access keys. No account ID is hard-coded. The operator must separately verify that this profile refers to the intended development account before any approved execution.

Opening time and three distinct pickup dates are mandatory. Opening must be future UTC, and pickup dates must follow its America/Denver calendar date. The example Drop is SCHEDULED; it will not automatically open.

Preview command, from `backend/` (choose future dates when reviewing):

```sh
npm run seed:dev -- \
  --table batch-and-batter-dev-catalog \
  --opens-at 2099-10-05T18:00:00.000Z \
  --pickup-dates 2099-10-08,2099-10-09,2099-10-10
```

Without `--confirm-dev`, the tool prints the full plan and makes no AWS calls. Do not add that flag until human review explicitly approves AWS seed execution.

The plan contains 11 items: two reusable cookies (Brown Butter Chocolate Chip and Snickerdoodle), one Drop, two DropProduct records, two inventories, three pickup records, and the storefront pointer. Prices are 450/400 cents; inventory starts at 100 each, with reserved/sold zero. All descriptions and location data are fake development examples.

Execution uses **one TransactWrite** with `attribute_not_exists(PK)` on every Put. That condition is evaluated against each complete PK/SK item key, allowing several different SKs under the same Drop PK. Any existing item, including a storefront pointer or reusable Product, makes the entire transaction fail. Reruns cannot overwrite/reset existing data, and no deletes occur. A lost response may leave the client unsure whether a transaction committed; inspect records rather than resetting or retrying with new IDs. The Lambda does not receive the seed tool's write permissions.

## Validation and CI

From the repository root, install backend dependencies before infrastructure builds:

```sh
cd backend
npm ci
npm run typecheck
npm test
npm run build
npm audit
cd ../infra
npm ci
npm run typecheck
npm test
npx cdk synth --lookups=false
npm audit
cd ../web
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

Backend tests use Node's test runner and fakes; no live AWS account or DynamoDB is required. Artifact tests include a seed **preview only** test with no credentials. No confirmed AWS seed is run. CDK assertions cover all three exact GET routes, preserved Lambda identity, exact read IAM, and the existing Phase 3 foundation. Repository-wide Prettier covers backend and infra; neither adds a separate linter.

CI preserves web checks, adds backend typecheck/build/tests/artifact checks and audit, and installs backend build dependencies before infra typecheck/tests/synthesis. It has no AWS credentials, live DynamoDB, deployment, or seed execution.

After successful local checks, an optional AWS comparison must be read-only:

```sh
cd infra
AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2 \
  npx cdk diff batch-and-batter-dev --profile batch-and-batter-dev --no-change-set --lookups=false
```

`--no-change-set` avoids CDK creating a CloudFormation change set for comparison. Review for only the API routes/integrations/permissions, Catalog read policy, Lambda code/handler/environment changes. Stop on any table replacement/deletion or unexpected destructive change. Do not deploy, commit, push, or seed AWS in this phase's implementation session.

## Implementation review results

Local validation completed on 2026-09-21 using Node 24.19.0 and installed npm 11.17.0 (within package engines); package manager metadata and CI remain pinned to npm 11.11.0.

- Web: clean `npm ci`, typecheck, lint, 7 tests, and production build passed. No web application code or dependency changes.
- Backend: clean `npm ci`, typecheck, build, 31 functional tests and 5 artifact tests passed. Tests use no live DynamoDB. Only the unconfirmed seed preview was exercised.
- Infra: clean `npm ci`, typecheck/build, all 9 CDK tests, and credential-free `cdk synth --lookups=false` passed. CDK reported its existing unconfigured feature-flags notice; no flags were changed.
- Repository formatting and `git diff --check` passed.
- Backend and infra audits: zero vulnerabilities. Web: the existing one moderate/one high affected-package findings for Next.js/PostCSS; no new advisories beyond the accepted record. No force fix, baseline upgrade, or override was applied.
- Lambda asset: exactly `handler.js`, 2,042,864 bytes (about 1.95 MiB). Gzip measurement: 344,886 bytes; this is not a deployment ZIP measurement. SHA-256: `d55cfdf49532eb1d57c025245ec8e5ac7bb630a3df58528084da5d296ba3749b`. The inspectable metadata records 609 bundled inputs, including seven application source modules. Rebuilds are byte-identical.
- Local comparison against the pre-change synthesis: no removed resources; only six new route/integration/invoke-permission resources and two modified resources (Lambda and its IAM policy). All three tables and the other Phase 3 resources are unchanged.
- Read-only AWS diff against `batch-and-batter-dev` in `us-east-2` succeeded using `--no-change-set`. It proposes the same six additions, Catalog GetItem/Query access, and an update to the existing `ApplicationApi5D63FF39` Lambda's code, handler, and environment. It does not replace the Lambda, modify tables, delete resources, or touch unrelated sites. No CloudFormation change set was created.
- Branch: `feature/phase-4a-catalog-drop-data`. Changes remain uncommitted for human review. Remote CI has not run because nothing was pushed. No deployment or AWS seed execution occurred.

The remaining limitations are intentional: inventory reads are informational rather than a cross-record transaction, sequential Product Gets assume a small menu, and the seed's named AWS profile must be checked by its operator before separately approved execution. Phase 4B authentication/admin writes and Phase 7 reservation transactions remain deferred.

Suggested commit message after review: `feat: add Batch & Batter catalog and drop data layer`.
