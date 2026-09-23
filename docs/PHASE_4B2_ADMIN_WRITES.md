# Phase 4B2A: Administrator role and safe catalog writes

This phase adds administrator authorization and single-record Product and DRAFT Drop writes. Phase 4B1 established authentication; its description of pool-only access and read-only Lambda IAM is historical. This document describes the new behavior pending human review and deployment. Phase 4B2B remains deferred.

## Authentication and authorization

Authentication establishes who signed in. Authorization decides what that identity may do. Signing in to the administrator pool alone no longer grants access to `/admin/me` or catalog writes. All five administrative routes require membership in exactly the named group `batch-and-batter-admins` (other group memberships do not disqualify an administrator).

```text
Admin signs in
    ↓
Cognito access token
    ↓
API Gateway validates JWT
    ↓
Lambda verifies access token + admin group
    ↓
Validated admin command
    ↓
Conditional CatalogTable write
```

The existing API Gateway JWT authorizer still validates token signatures, issuer, audience/client ID and time claims. Lambda performs no custom signature verification and makes no Cognito management calls. The reusable `requireAdmin` helper reads only `requestContext.authorizer.jwt.claims`. It requires `token_use === "access"`, a nonblank string `sub`, a nonblank string `username`, and an exact group-name match. Headers, body and query parameters cannot supply authorization claims.

Missing authentication context or malformed identity returns 401 `UNAUTHORIZED`. Wrong token use returns 403 `FORBIDDEN`. Missing, malformed, wrong or substring-only group membership returns 403 `FORBIDDEN`. Successful `/admin/me` still returns only `authenticated: true`, `subject` and `username`. Admin responses use `Cache-Control: no-store`. API Gateway rejections occur before Lambda and may use Gateway's own response shape.

Cognito defines `cognito:groups` as an array. The helper supports an array of nonempty strings, a JSON-encoded array, an exact single-group string, and a strictly parsed bracketed space-separated list as encountered in Gateway claim representations. It does not split arbitrary comma-delimited strings, trim group names into matches, or search substrings. Malformed representations fail closed. Verify the deployed Gateway representation during later human acceptance testing; do not log tokens or whole claims to diagnose it. See [Cognito access-token claims](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html) and [HTTP API JWT validation](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

## Cognito group and human assignment

CDK adds one group to the existing pool: `batch-and-batter-admins`. `AdminGroupName` exposes its name as a nonsecret CloudFormation output. The group has no IAM role. The existing pool, client, JWT authorizer and MFA configuration remain unchanged. Self-signup remains disabled.

CDK provisions no users, usernames, passwords or membership attachments. A human must review the intended administrator and assign membership manually after a separately approved deployment. This keeps privilege assignment deliberate and account-specific rather than embedding identities or credentials in infrastructure. Existing access tokens do not gain a newly assigned group; obtain a fresh access token after assignment. Until assignment and fresh sign-in, the existing development user should receive 403 from `/admin/me`.

## Routes and payloads

| Route                             | Authorization             | Success                                              |
| --------------------------------- | ------------------------- | ---------------------------------------------------- |
| `GET /health`                     | Public                    | Existing 200 health response                         |
| `GET /drops/current`              | Public                    | Existing 200 with visible Drop or null               |
| `GET /drops/{dropId}`             | Public                    | Existing 200 visible Drop; existing 404/400 behavior |
| `GET /admin/me`                   | JWT + administrator group | 200 minimal identity                                 |
| `POST /admin/products`            | JWT + administrator group | 201 `{ "product": { ... } }`                         |
| `PUT /admin/products/{productId}` | JWT + administrator group | 200 `{ "product": { ... } }`                         |
| `POST /admin/drops`               | JWT + administrator group | 201 `{ "drop": { ... } }`, status DRAFT              |
| `PUT /admin/drops/{dropId}`       | JWT + administrator group | 200 `{ "drop": { ... } }`, status DRAFT              |

Product POST and PUT accept `name`, `slug`, `description`, `ingredients`, `allergens`, and `active`. All six are required. Names must be nonblank; slugs follow the existing lowercase hyphenated format; ingredients/allergens are arrays of nonempty strings; active is a boolean. The existing Product domain schema validates the complete result.

Drop POST and PUT accept `name`, `description`, `opensAt`, optional `closesAt`, `quantityLimit`, `timezone`, `pickupLocation`, and `pickupInstructions`. Existing domain defaults apply if quantityLimit or timezone is omitted: 12 and America/Denver. Other listed fields except closesAt are required. Absolute timestamps use the existing UTC ISO schema. If supplied, closesAt must follow opensAt. Quantity limits must be positive safe integers, and timezone must be recognized. A draft's opening time need not be future; publishing validation belongs to Phase 4B2B.

PUT replaces the editable metadata rather than applying a partial patch. Omitting closesAt removes it; omitting quantityLimit/timezone reapplies domain defaults. Clients should send the complete desired metadata. No PATCH route exists.

Strict runtime schemas reject unknown fields, including `PK`, `SK`, IDs, `createdAt`, `updatedAt`, group/role claims, inventory and pickup dates. Drop status is rejected even when a client supplies `DRAFT`; the server owns it. Missing/malformed JSON, invalid fields or invalid update IDs return 400 `VALIDATION_ERROR`. API Gateway base64-encoded JSON bodies are supported.

Admin DTOs explicitly select domain fields. Product DTOs include productId, the six editable fields, createdAt and updatedAt. Drop DTOs include dropId, the eight editable fields (closesAt only when set), status, createdAt and updatedAt. Neither exposes DynamoDB keys or SDK metadata.

## Server-owned identity and timestamps

New Products and Drops receive a server-generated ULID; clients cannot choose an authoritative ID. The existing `idSchema = z.ulid()` and all seeded IDs are unchanged. The small helper follows the [canonical ULID specification](https://github.com/ulid/spec): a 48-bit current Unix-millisecond timestamp plus 80 bits from Node's `crypto.randomBytes(10)`, encoded as exactly 26 Crockford Base32 characters. It validates the result with the existing schema. No dependency is added. IDs within the same millisecond are random rather than monotonically ordered.

Creation sets createdAt and updatedAt server-side to the same timestamp. Replacement preserves the record's identity and createdAt. updatedAt advances to the greater of current server time and the previous value plus one millisecond, so competing same-millisecond writes cannot share an unchanged concurrency marker.

## Repository and conditional write safety

`DynamoCatalogRepository` exposes exactly four new write operations: `createProduct`, `replaceProduct`, `createDraftDrop` and `replaceDraftDrop`. All use the existing AWS SDK v3 DynamoDBDocumentClient and PutCommand. Route handlers contain no DynamoDB SDK writes.

New records use `PRODUCT#<productId> / META` or `DROP#<dropId> / META`, with `attribute_not_exists(PK)`. The condition applies to the complete PK/SK item key. A collision cannot silently overwrite a record and produces 409 `PRODUCT_CONFLICT` or `DROP_CONFLICT`.

Replacement first reads the existing item consistently. Missing records return 404 `PRODUCT_NOT_FOUND` or `DROP_NOT_FOUND`, without writing. The Put requires `attribute_exists(PK)` plus equality of the previously read createdAt and updatedAt. Draft replacement also requires the stored status to equal DRAFT **at the instant of the write**, not just when it was read. The repository independently validates complete records, immutable identity/createdAt and advancing updatedAt.

On a failed replacement condition, a consistent reread distinguishes a currently missing record (404), a non-DRAFT Drop (409 `DROP_NOT_EDITABLE`), and an otherwise conflicting record (409 `PRODUCT_CONFLICT`/`DROP_CONFLICT`). It never retries as an unconditional overwrite or upsert. This classification describes the reread; concurrent state can change again afterwards.

The concurrency check protects overlapping server read/write operations. There is no client version/ETag precondition, so it does not detect a stale form submitted after another request has already completed. Future administrative UI work should address that workflow explicitly. POST has no idempotency key: a lost response followed by a new POST can create a second logical item with a different ID. A network error or 500 does not prove a write failed to commit; operators should reconcile before retrying.

## Draft and public-data boundaries

Every new Drop starts in DRAFT so incomplete metadata cannot become a public sales event. Only DRAFT metadata is editable. Existing SCHEDULED, OPEN, PAUSED, SOLD_OUT, CLOSED and COMPLETED Drops return 409 `DROP_NOT_EDITABLE`; this includes the seeded SCHEDULED development Drop. A concurrent future publishing operation cannot bypass the write-time DRAFT condition.

No DropProduct, inventory, pickup-date or `STORE#CONFIG` writes exist. DRAFTs remain hidden by the unchanged public read layer, and this phase cannot point the storefront at them or publish them. Inventory, pickups and publishing require coordinated multi-item validation and transactions and wait until Phase 4B2B. There are no DELETE routes because deletion relationships and commercial-history implications are outside this phase. No scheduling, admin UI, Hosted UI, OAuth scopes, cart/payment, waitlist, notification or audit-log infrastructure is added.

Reusable Product metadata is intentionally editable, including active status. Existing public Drop responses compose these Product records, so changing a referenced Product can change its public name, description, ingredients/allergens or visibility. This does not mutate Drop status, prices, inventory, pickup configuration or DropProduct records. Public route authorization and response contracts remain unchanged.

Global slug uniqueness is **not enforced**: the existing key model has no efficient unique slug lookup. Duplicate slugs are accepted. No Scan is introduced. A separately designed slug lookup/reservation record or index strategy must address lookup and uniqueness before any feature depends on it; an index alone does not guarantee uniqueness.

## IAM and safe errors

The Lambda execution role has exactly these actions:

- `logs:CreateLogStream` and `logs:PutLogEvents`, scoped to its existing log group.
- `dynamodb:GetItem`, `dynamodb:Query`, and `dynamodb:PutItem`, scoped to CatalogTable's exact ARN.

No UpdateItem, DeleteItem, Scan, BatchWriteItem, TransactWriteItems or DynamoDB wildcard is granted. No CommerceTable, OperationsTable, SQS, SES, S3 or Cognito management permission is granted. PutItem IAM is table-scoped; the application repository enforces allowed keys, fields and DRAFT status. IAM itself does not express these business rules. API Gateway's route-scoped Lambda invocation permissions are separate from the execution role.

Lambda errors retain `{ "code", "message", "requestId" }`. Expected errors use 400/401/403/404/409 as described above. Unexpected administrative failures return generic 500 `INTERNAL_ERROR`. Only the event label and request ID are logged; no request bodies, Authorization headers, JWT claims, raw SDK errors, credentials or catalog records are logged. API Gateway remains responsible for cryptographic token validation.

## Remaining production security and human acceptance

MFA remains a production follow-up; this phase deliberately does not change it. Review administrator provisioning/removal, least-privilege operations, future browser token storage, rate limiting, auditability and operational recovery before production. Group removal does not instantly invalidate a previously issued access token at API Gateway; existing short access-token lifetimes limit that exposure. Requiring a group is authorization, not an immediate revocation service.

After separate deployment approval, a human should verify public GETs without credentials, anonymous 401, access-token-without-group 403, ID-token rejection, and administrator-group 200 on `/admin/me`. Any later live create/update testing must be separately authorized and use disposable DRAFT/Product data; never test edits against the seeded public Drop. Keep credentials and tokens out of source, shell history, logs and review artifacts. This implementation session performs no live sign-in, membership changes or DynamoDB writes.

## Validation and review

Backend validation: `npm ci`, `npm run typecheck`, and `npm test` (includes build, functional tests and artifact tests). Infrastructure validation: `npm ci`, `npm run typecheck`, `npm test` (includes backend bundle and infra build), and `npx cdk synth --lookups=false`. Run `npm audit` in both packages, repository formatting, and `git diff --check`. CI remains unchanged; web application code is unaffected.

Tests use fakes and synthetic claim objects, not live AWS or signed JWTs. ULID checks cover format, schema acceptance, current-time decoding, known/boundary timestamp encodings, repeated and same-millisecond uniqueness, and both key formats. Repository tests assert exact conditional SDK requests, conflict mappings, no upsert and overlapping updates. Infrastructure tests preserve protected resources against the pre-change local synthesis, verify all routes and exact IAM, and prohibit user membership provisioning.

After successful local validation, the approved AWS comparison is read-only:

```sh
cd infra
AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2 \
  npx cdk diff batch-and-batter-dev --profile batch-and-batter-dev \
  --no-change-set --lookups=false
```

`--no-change-set` avoids creating a CloudFormation change set. No deploy, commit, push, live Cognito mutation or live DynamoDB write is authorized. Stop for review on any existing major resource replacement/deletion.

## Completed local review — 2026-09-23

- Continued the existing uncommitted implementation on `feature/phase-4b2a-admin-writes`; no work was discarded or recreated. Main had been verified clean and equal to remote main before branch creation.
- Backend: clean `npm ci`, typecheck, build, **142 functional tests** and **5 artifact tests** passed. Artifact checks cover production-only bundled dependencies, isolated health execution, deterministic rebuilds and credential guardrails. All database tests use fakes.
- Infrastructure: clean `npm ci`, typecheck/build, **15 tests** and `npx cdk synth --lookups=false` passed. The first run exposed an incorrect new test expectation about CDK's invocation ARN format; correcting that assertion to the actual path-scoped synthesis made the suite pass. The existing 83-unconfigured-feature-flags notice remains; no flags were changed.
- Backend and infrastructure `npm audit`: **zero vulnerabilities**. Network access was required to reach the advisory service. No dependencies, lockfiles, CI settings, domain schemas or seed files changed. Node 24.19.0 and npm 11.17.0 satisfy existing engines; pinned package-manager metadata remains unchanged.
- Repository formatting and `git diff --check` passed. Web application source/configuration is unaffected, so application build/tests were not repeated; its repository-wide formatting check passed. The existing documented web dependency risk remains outside this change.
- Review and targeted scans of changed source/tests/docs and generated Lambda code found no actual passwords, JWTs, access/refresh tokens, client secrets or AWS credentials. Tests use synthetic claim objects only. Secret-pattern checks supplement review rather than guarantee detection of every possible secret format.
- A local comparison using the same account/region as the pre-change synthesis showed **13 additions, two modified existing resources and zero removals**. The two modified resources are the Lambda bundle and its execution-role policy. Protected-resource assertions confirm unchanged tables, pool/MFA, app client and JWT authorizer.
- The read-only development AWS diff in us-east-2 succeeded with `--no-change-set --lookups=false`. It shows the Cognito group, four JWT routes, four integrations, four invoke permissions, Catalog PutItem permission, existing Lambda bundle update and AdminGroupName output. **No replacements or deletions**, table changes, pool/client changes or unrelated website changes are proposed.
- The direct CDK profile lookup encountered an expired SSO token even though the AWS CLI identity check succeeded. For the successful comparison, a temporary credential-process configuration let CDK use the CLI's valid cached credentials. Credentials were neither written nor printed; the temporary profile configuration was removed automatically and the saved AWS profile was not edited. This was a read-only local tooling workaround, not a source or infrastructure change.
- The working tree contains six modified tracked files and eight new files, all unstaged. No commit, push, deployment, live Cognito user/group mutation, live sign-in or live DynamoDB write was performed. Remote CI has not run. Live acceptance remains for separately approved deployment and human verification.

Files added:

- `backend/src/admin-auth.ts`
- `backend/src/admin-writes.ts`
- `backend/src/ulid.ts`
- `backend/test/admin-writes.test.ts`
- `backend/test/repository-writes.test.ts`
- `backend/test/ulid.test.ts`
- `infra/test/fixtures/phase-4b1-protected-resources.json`
- `docs/PHASE_4B2_ADMIN_WRITES.md`

Files changed:

- `backend/src/api.ts`
- `backend/src/repository.ts`
- `backend/test/admin.test.ts`
- `backend/test/fixtures.ts`
- `infra/lib/development-stack.ts`
- `infra/test/development-stack.test.ts`

Suggested commit after human review: `feat: add protected admin catalog writes`.
