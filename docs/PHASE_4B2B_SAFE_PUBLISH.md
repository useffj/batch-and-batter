# Phase 4B2B2A: Safe DRAFT publication

Publishing makes a complete Drop visible to customers and assigns it to the storefront. This phase supports exactly **DRAFT → SCHEDULED**. DRAFT is private preparation; SCHEDULED is a customer-visible upcoming Drop. SCHEDULED does not mean OPEN, and this phase does not accept orders or automatically open anything.

## Route and authorization

`POST /admin/drops/{dropId}/publish` uses the existing API Gateway JWT authorizer and shared `requireAdmin` boundary: access token, nonblank subject/username, exact `batch-and-batter-admins` membership. Authorization precedes parsing and database access. No custom signature validation or Cognito call is introduced.

The request accepts an absent/empty HTTP body or a strict empty JSON object `{}` (including base64-encoded JSON). Other values and unknown fields are rejected. IDs, status, storefront assignment, opening overrides, keys and timestamps cannot be supplied in the body. The path must contain a valid ULID. Publication always uses existing stored configuration.

Success is HTTP 200 with `{ drop, storefront }`. Drop uses the explicit admin Drop DTO, with status SCHEDULED and preserved createdAt. Storefront explicitly contains only storefrontDropId and updatedAt. No PK/SK, raw records or AWS metadata is returned. Responses retain `Cache-Control: no-store`.

## Readiness

The repository reads Drop META **first**, then loads every DropProduct, inventory and pickup record with existing paginated consistent Queries, then consistently reads every referenced reusable Product. Runtime domain schemas validate stored records. Readiness is checked against server time after loading.

Publication requires:

- Drop exists, remains DRAFT, and opensAt is strictly in the future at validation time. Existing schema rules also require valid metadata, timezone, quantity limit and closesAt later than opensAt when supplied.
- At least one active DropProduct; every association has a reusable Product and Inventory; no orphan inventory or duplicate identities; all records have the correct Drop relationship.
- Each active association references an active Product and has positive priceCents, cookieUnits and inventory total, with reserved=0 and sold=0.
- At least one active pickup. Existing calendar date, HH:MM, same-day end-after-start and timezone rules apply. Every active pickup date is on or after the opening calendar date calculated in the **Drop timezone**. This compares dates, not pickup time against opening time. UTC date and pickup timezone are not substituted for the Drop timezone.

Inactive associations/pickups are not made customer-visible and need not meet the active sales/date requirements. Their stored records must still satisfy domain validation, and inactive associations still need both references. An inactive reusable Product can be referenced by an inactive association. Broken references and orphan inventory block publication. Invalid schema data discovered while loading is DROP_NOT_READY; SDK failures and internal key/identity corruption remain safe generic failures rather than exposing storage details.

Readiness failures return 409 DROP_NOT_READY with `Drop is not ready to publish.` No transaction is sent when readiness fails.

## Composition revision hardening

Every successful Product attach/configuration update/removal and pickup put/removal now advances Drop.updatedAt **inside the same transaction**. The transaction's old Drop ConditionCheck is replaced with one Drop META Put. Editable metadata, createdAt and DRAFT status are preserved. META is not separately checked or targeted twice.

The new timestamp is `max(serverNow, previous updatedAt + 1 millisecond)`. The shared helper is also used by existing Product/Drop metadata writes. This guarantees progress within the same millisecond and across clock regression. It uses the existing domain model without adding a field, record or dependency.

The Put requires the Drop to exist, still be DRAFT and still carry the exact updatedAt that was read. A failed condition triggers a consistent reread: missing → DROP_NOT_FOUND; non-DRAFT → DROP_NOT_EDITABLE; still DRAFT → COMPOSITION_CONFLICT. No unconditional retry or fallback write occurs. The still-DRAFT result is a conflict even if the reread can no longer explain the exact failure.

This intentionally supersedes the earlier statement that composition/pickup edits leave Drop metadata timestamps untouched. Existing metadata replacement already checks and advances updatedAt, so it participates in the revision protocol. Its existing PRODUCT_CONFLICT/DROP_CONFLICT API contract remains unchanged.

## Why the snapshot is protected

The composition read is not an atomic snapshot by itself. Its safety comes from reading META first and requiring that revision when committing publication. Every supported mutation of an existing DropProduct, Inventory or Pickup changes META atomically. Therefore a composition mutation that occurs during or after the reads invalidates publication's expected revision. If publication commits first, a competing composition write cannot pass its DRAFT condition.

Source inspection found no other runtime composition writer. The local seed transaction creates META and all seed items only when absent; it cannot change the composition of an existing Drop. No reservation worker or independent inventory mutation exists in this phase. Consequently extra per-association, inventory or pickup ConditionChecks would duplicate the revision protection and would not solve insertion/deletion races as well as the revision protocol.

Reusable Products can change independently of Drop.updatedAt, so **every referenced Product**, including those used by inactive associations, gets a separate existence/active/updatedAt ConditionCheck. Existing Product edits advance their own timestamp. Product deletion, active-state change or metadata revision change between validation and transaction fails publication with COMPOSITION_CONFLICT. This mapping is deterministic; it does not reread Products to choose another code.

Future independent inventory writers, administrative repair tools or lifecycle operations must preserve this protocol for DRAFT composition or add corresponding transactional protection before they are introduced. Out-of-band writes that bypass application conditions are not covered. A later approved rollout must retire/drain the old condition-only composition code before accepting publish requests; mixed old/new writers do not share the revision guarantee.

## Exact publication transaction

One TransactWriteCommand targets CatalogTable only:

| Index    | Action                     | PK / SK                      | Purpose                                                                                            |
| -------- | -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| 0        | Put                        | `DROP#<dropId> / META`       | Preserve metadata/createdAt, set SCHEDULED, advance updatedAt; require DRAFT and expected revision |
| 1        | Put                        | `STORE#CONFIG / STOREFRONT`  | Assign this Drop and server timestamp; reject another assignment                                   |
| 2 onward | ConditionCheck per Product | `PRODUCT#<productId> / META` | Require existence, validated active flag and exact Product revision                                |

The Drop revision condition is exactly:

```text
attribute_exists(PK) AND #status = :draft AND #updated = :expected
```

Names: `{ "#status": "status", "#updated": "updatedAt" }`.
Values: `{ ":draft": "DRAFT", ":expected": <Drop.updatedAt read before composition> }`.

The storefront condition is exactly:

```text
attribute_not_exists(PK) OR #storefrontDropId = :dropId
```

Names: `{ "#storefrontDropId": "storefrontDropId" }`.
Values: `{ ":dropId": <path dropId> }`.

Each reusable Product condition is exactly:

```text
attribute_exists(PK) AND #active = :active AND #updated = :expected
```

Names: `{ "#active": "active", "#updated": "updatedAt" }`.
Values: `{ ":active": <validated Product.active>, ":expected": <validated Product.updatedAt> }`.

The Drop and storefront use the same server-generated publication timestamp. The Drop's new timestamp strictly advances; the storefront timestamp is not a separate concurrency version. No action uses a client-supplied timestamp.

Each action has a unique complete PK/SK. The revision Put is the only action targeting Drop META. Unique Product relationships are validated before constructing checks. There are no composition writes in the publication transaction itself.

## Storefront occupancy and transaction size

The storefront Put allows only an absent configuration item or one already pointing to this exact Drop. An existing configuration item with no pointer is also rejected, because it satisfies neither approved condition. An assignment to any other Drop is rejected regardless of that Drop's lifecycle state. No read-then-overwrite window exists: the condition is on the Put itself.

The pointer and SCHEDULED transition commit together or neither does. This prevents a scheduled Drop without its intended assignment or a pointer assigned by a failed publication. Displacing/removing a current assignment belongs to reviewed lifecycle work. In particular, the existing development storefront assignment will intentionally block publishing another Drop until a separately authorized workflow handles that assignment.

Action count is computed as `2 + referenced Product count` before sending. More than 100 returns DROP_NOT_READY with no transaction sent. At most 98 referenced Products are publishable in one request; inactive references also count. A normal small menu needs only a few actions. No chunked publication or partial fallback exists. Tests exercise both 100 and 101 actions offline.

## Error and cancellation contract

All Lambda errors retain `{ code, message, requestId }`.

| Status/code              | Behavior                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| 400 VALIDATION_ERROR     | Invalid path, malformed body, nonempty object or other JSON value                                  |
| 401 UNAUTHORIZED         | Missing authentication or malformed subject/username                                               |
| 403 FORBIDDEN            | Wrong token purpose or missing exact admin membership                                              |
| 404 DROP_NOT_FOUND       | Drop missing initially or on revision-failure reread                                               |
| 409 DROP_NOT_EDITABLE    | Initially non-DRAFT or revision-failure reread is non-DRAFT; includes repeated publication         |
| 409 DROP_NOT_READY       | Readiness/domain failure or action count exceeds 100; `Drop is not ready to publish.`              |
| 409 COMPOSITION_CONFLICT | Drop revision failed while still DRAFT, reusable Product condition failed, or transaction conflict |
| 409 STOREFRONT_OCCUPIED  | Storefront Put condition failed; `Another Drop is currently assigned to the storefront.`           |
| 500 INTERNAL_ERROR       | Unexpected service/internal failure with a generic safe message                                    |

Recognized conditional cancellations use transaction order: Drop revision first, storefront second, Products thereafter. If more than one condition fails, the first wins. Nonconditional TransactionConflict maps to COMPOSITION_CONFLICT. Unknown service reasons, absent/invalid cancellation lists and other AWS errors propagate to generic 500. No cancellation details, tokens, bodies, credentials or raw SDK errors are logged or returned; logs retain only the failure-event label and request ID. API Gateway rejection bodies remain Gateway-controlled.

## Public behavior, IAM and deferred work

Public routes and visibility rules are unchanged. DRAFT remains hidden; SCHEDULED was already visible in Phase 4A, so a successful publication is readable through `/drops/current` and `/drops/{dropId}`. Passing opensAt does not change status. No OPEN transition, automatic schedule, EventBridge permission/resource, queue, reservation, payment or notification capability is added.

Lambda CatalogTable actions remain exactly GetItem, Query, PutItem, DeleteItem and ConditionCheckItem with the `dynamodb:` prefix, scoped to the existing Catalog ARN. Existing scoped logs:CreateLogStream/logs:PutLogEvents remain. No IAM change, domain schema change, new dependency or table/index change is required.

Phase 4B2B2B must separately review manual lifecycle transitions, one-time opening schedules, retry/reconciliation, cleanup, unpublish and storefront replacement/removal. Production follow-ups include admin MFA/provisioning, token handling, rate limits and audit history. No live deployment or acceptance test is performed here.

## Concurrency and idempotency limits

The revision protects overlapping server operations, not stale forms submitted after earlier requests finish. There is no client ETag or application idempotency key. Pickup PUT preserves pickup resource state but now advances Drop.updatedAt on every successful request. Revision contention between edits to different composition items is intentional.

A repeated successful publish is rejected as non-DRAFT with DROP_NOT_EDITABLE and performs no second publication write. After an ambiguous timeout/500, read the Drop/storefront state before retrying. Cancellation classification involving a reread describes that later read. Products remain reusable and editable after publication; this phase protects Product state at publication time, not an immutable post-publication snapshot.

opensAt must be future at validation time, as requested; it may pass while the transaction is in flight. The Drop still becomes SCHEDULED and never automatically OPEN. Readiness and transaction-size checks do not guarantee a large menu finishes within the existing Lambda timeout; Product reads retain the small-menu sequential approach.

## Validation and review

Completed locally on 2026-09-23:

- Verified clean main at `097a2da`, equal to remote main, then created `feature/phase-4b2b2a-safe-publish`.
- Backend: `npm ci`, typecheck, build, **226 functional tests** and **5 artifact tests** passed. The suite includes every composition revision advance, fixed/regressing clock behavior, same-DRAFT conflicts, readiness failures, exact transaction inputs, Product/Drop/storefront races, both orderings of real composition-versus-publication operations, 100/101-action boundaries, authorization, DTOs and public visibility. No test uses live AWS.
- Infrastructure: `npm ci`, typecheck/build, **16 tests** and `npx cdk synth --lookups=false` passed. The pre-change resource fixture was captured from main's stack before the route edit. Exact comparison permits only three added resources and the existing Lambda code change; IAM and other resources are unchanged. The existing 83-unconfigured-feature-flags notice remains.
- Backend and infrastructure `npm audit --json`: **zero vulnerabilities**. No new dependencies, package-manifest edits or lockfile changes. No audit fix was run. npm ci warned about esbuild's install-script approval state; the installed build and artifact checks nevertheless passed without dependency/configuration changes.
- Repository-wide formatting and `git diff --check` passed. Web application source is unchanged; its application tests/build were not rerun, and the accepted web dependency risk remains unchanged.
- The read-only development AWS diff in us-east-2 succeeded with `--profile batch-and-batter-dev --no-change-set --lookups=false`. Output is saved locally at `/private/tmp/batch-publish-aws-diff.log`. It proposes one publication route, one integration, one Lambda invocation permission, and the existing application Lambda code/asset update. **No execution-role IAM changes, replacements, deletions, table changes, Cognito changes, EventBridge resources, queues or unrelated changes.** No change set was created.
- Domain schemas, key strategy, public storefront code and dependencies remain unchanged. Existing tests for artifact contents, credential guardrails and safe logging passed. Live acceptance and remote CI have not run.
- Git status: **12 modified tracked files and six new files**, all unstaged on the requested feature branch. No commit, push, deployment, live DynamoDB write or live Cognito mutation occurred.

Added files:

- `backend/src/admin-publish.ts`
- `backend/src/publish-readiness.ts`
- `backend/src/timestamps.ts`
- `backend/test/publish.test.ts`
- `infra/test/fixtures/phase-4b2b1-resources.json`
- `docs/PHASE_4B2B_SAFE_PUBLISH.md`

Changed files:

- `backend/src/admin-writes.ts`
- `backend/src/api.ts`
- `backend/src/repository.ts`
- `backend/test/admin-composition.test.ts`
- `backend/test/admin-writes.test.ts`
- `backend/test/composition-sdk.test.ts`
- `backend/test/composition-store.ts`
- `backend/test/composition-transactions.test.ts`
- `backend/test/fixtures.ts`
- `infra/lib/development-stack.ts`
- `infra/test/development-stack.test.ts`
- `docs/PHASE_4B2B_DRAFT_COMPOSITION.md`

Implementation is ready for human review. No live-write/deployment authorization is implied by these results.

Suggested commit after review: `feat: add safe draft publication workflow`.
