# Phase 4B2B2B1 — Safe manual Drop opening

## Purpose and inspected model

This phase adds the authoritative manual opening operation that a later automatic scheduler can reuse. It starts from clean main `7e36f04`, after observability was merged and live-accepted. The implementation is local and has not been deployed.

The existing domain supports exactly DRAFT, SCHEDULED, OPEN, PAUSED, SOLD_OUT, CLOSED, and COMPLETED. Public APIs already expose SCHEDULED, OPEN, PAUSED, SOLD_OUT, and CLOSED; DRAFT and COMPLETED remain hidden. Time alone does not change stored status. This phase neither changes that enum nor redesigns public reads.

Current Drop metadata and composition mutations require DRAFT at write time. Each composition transaction advances Drop.updatedAt; metadata replacements also advance and condition on it. Reusable Product metadata, including its active state, remains independently editable after publication. Product edits preserve identity/createdAt and advance Product.updatedAt. No reservation worker or independent inventory writer currently exists. The development seed is conditional creation only, not an existing-record update path.

## Route, authorization and DTO

`POST /admin/drops/{dropId}/open` uses the existing JWT authorizer and the existing Lambda check for access-token purpose, valid identity, and exact `batch-and-batter-admins` membership. Authorization precedes parsing and repository initialization.

The route accepts an absent/empty HTTP body or strict JSON `{}`, including the existing base64 decoding behavior. Malformed IDs, non-object JSON, and every supplied property are rejected with 400 VALIDATION_ERROR. Status, client time, timestamps, identifiers, force flags, storefront assignment, PK and SK cannot be supplied.

Success returns HTTP 200 with `{ "drop": <explicit admin Drop DTO> }`. It uses `dropId`, not public `id`; preserves name, description, opensAt, optional closesAt, quantityLimit, timezone, pickupLocation, pickupInstructions and createdAt; sets status OPEN; and returns the server-generated updatedAt. No raw keys, metadata, composed products/pickups, or storefront object is returned. Responses keep the existing no-store header. There is no post-commit read.

## Transition and readiness

Only **SCHEDULED → OPEN** is supported. Every other existing status, including already OPEN, returns 409 DROP_NOT_EDITABLE. Repeating a successful open performs no second write. There is no force override or application idempotency-key system.

The repository consistently reads Drop META first, requires SCHEDULED, then consistently reads the storefront pointer. The pointer must already identify this Drop. It loads all DropProduct, Inventory and Pickup records through strongly consistent paginated queries, then consistently reads the reusable Product for each active association.

After those reads, readiness requires:

- Valid Drop metadata and status SCHEDULED; finite server time **at or after opensAt**. The comparison uses Date.now, not client time or the revision timestamp. An opening time that passes during the reads is accepted at the final validation point.
- At least one active association and active pickup.
- Valid schemas and correct Drop relationships for every loaded association, inventory and pickup, without duplicate identities. Inventory and association identities match one-to-one, preserving composition consistency.
- Each active association has a present, valid, active reusable Product and positive price, cookie-unit value and inventory total.
- Inventory values are nonnegative safe integers and `reserved + sold <= total`. Opening does not require counts to be zero, reset them, or manufacture availability. It does not require positive available stock beyond the requested positive total.
- Pickup dates, hours and timezone satisfy the existing structural schema, including same-day end-after-start. This phase does not introduce a new pickup cutoff or late-opening policy.

Inactive associations still require structurally valid composition/inventory records, but their reusable Products are not read or checked because they are not exposed by opening. Product checks therefore protect exactly the independently mutable records used in active readiness.

Invalid stored domain data yields DROP_NOT_READY. Unexpected SDK failures and internal key/identity mismatch errors remain generic INTERNAL_ERROR. A missing/unset/different valid storefront pointer yields STOREFRONT_CONFLICT. Malformed storefront schema data is invalid stored data and yields DROP_NOT_READY.

## Race analysis

| Race                                    | Commit protection                                                                                          | Failure mapping                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Another open/lifecycle attempt          | META requires SCHEDULED and the original updatedAt; only one opening can commit                            | Consistent reread: missing → DROP_NOT_FOUND; no longer SCHEDULED → DROP_NOT_EDITABLE; otherwise COMPOSITION_CONFLICT                                    |
| Stale SCHEDULED metadata/revision       | META expected updatedAt                                                                                    | COMPOSITION_CONFLICT while still SCHEDULED                                                                                                              |
| Product edit, deactivation or deletion  | Each active association's Product requires existence, active=true and the exact validated updatedAt        | COMPOSITION_CONFLICT                                                                                                                                    |
| Storefront reassignment/removal         | Pointer equality inside the same transaction                                                               | STOREFRONT_CONFLICT                                                                                                                                     |
| Supported composition/metadata mutation | Existing writers require DRAFT and advance the Drop revision atomically; they cannot mutate SCHEDULED/OPEN | The competing writer gets DROP_NOT_EDITABLE; any changed revision seen by opening is rejected                                                           |
| Future reservation/inventory writer     | None exists now; do not assume current protection covers a new writer                                      | Future work must guard ordering writes with OPEN and protect any SCHEDULED inventory mutation through the revision protocol or new transactional checks |

Product checks hold at the opening commit boundary. A Product edit committed afterward remains permitted, as before, and can change public catalog content/visibility. Opening does not freeze the reusable catalog. Storefront reassignment away and back before commit is acceptable if this Drop again owns the pointer when the transaction commits; no pointer-history contract is introduced.

The revision protocol protects supported writers, not arbitrary out-of-band DynamoDB changes. There are no redundant composition ConditionChecks because supported composition writes already coordinate through META. No currently supported opening-relevant writer was found outside either that protocol or the Product checks.

## Exact transaction

One `TransactWriteCommand` targets CatalogTable only. It performs exactly one Put, with no deletes and no storefront/inventory/pickup/Product writes.

| Index    | Action                                              | PK / SK                        |
| -------- | --------------------------------------------------- | ------------------------------ |
| 0        | Conditional Put                                     | `DROP#<dropId>` / `META`       |
| 1        | ConditionCheck                                      | `STORE#CONFIG` / `STOREFRONT`  |
| 2 onward | One ConditionCheck per active association's Product | `PRODUCT#<productId>` / `META` |

Action 0 preserves the validated Drop and changes only status and updatedAt. The revision helper computes `max(serverNow, previous updatedAt + 1ms)`, preserving strict advancement even with equal/regressing clocks. Time eligibility independently uses actual server time rather than this possibly future revision marker.

```text
ConditionExpression:
attribute_exists(PK) AND #status = :scheduled AND #updated = :expected

ExpressionAttributeNames:
{ "#status": "status", "#updated": "updatedAt" }

ExpressionAttributeValues:
{ ":scheduled": "SCHEDULED", ":expected": <Drop.updatedAt read first> }
```

Action 1 authorizes current storefront ownership atomically. Equality fails for a missing item or absent pointer; an additional existence check is unnecessary.

```text
ConditionExpression:
#storefrontDropId = :dropId

ExpressionAttributeNames:
{ "#storefrontDropId": "storefrontDropId" }

ExpressionAttributeValues:
{ ":dropId": <path dropId> }
```

Every Product check uses:

```text
ConditionExpression:
attribute_exists(PK) AND #active = :active AND #updated = :expected

ExpressionAttributeNames:
{ "#active": "active", "#updated": "updatedAt" }

ExpressionAttributeValues:
{ ":active": true, ":expected": <validated Product.updatedAt> }
```

Readiness rejects duplicate Product identities. The key families are disjoint, so no two actions target the same complete PK/SK. Action count is computed before sending: **2 + active Product count**, at most 100. Thus 98 active Products are allowed; 99 produces DROP_NOT_READY with no transaction. There is no chunking, unconditional retry, partial commit or fallback write.

## Error and cancellation mapping

All existing errors retain `{ code, message, requestId }`. Route-specific messages keep publication/composition contracts unchanged.

| Status/code                      | Safe message or behavior                                        |
| -------------------------------- | --------------------------------------------------------------- |
| 400 VALIDATION_ERROR             | Existing input validation messages                              |
| 401 UNAUTHORIZED / 403 FORBIDDEN | Existing authentication/authorization contract                  |
| 404 DROP_NOT_FOUND               | Drop not found.                                                 |
| 409 DROP_NOT_EDITABLE            | Only SCHEDULED Drops can be opened.                             |
| 409 DROP_NOT_READY               | Drop is not ready to open.                                      |
| 409 STOREFRONT_CONFLICT          | Drop is not assigned to the storefront.                         |
| 409 COMPOSITION_CONFLICT         | Composition changed or is inconsistent. Reload before retrying. |
| 500 INTERNAL_ERROR               | Unable to complete the request.                                 |

STOREFRONT_CONFLICT is a new additive ownership error. Publication's STOREFRONT_OCCUPIED remains unchanged because publication assigns the pointer while opening only checks it.

The existing transaction-cancellation mapper processes conditions in action order: META first, storefront second, Products afterward. META failure performs one consistent reread and returns missing/non-SCHEDULED/still-SCHEDULED classifications above. Still SCHEDULED conservatively maps to COMPOSITION_CONFLICT even if the reread no longer explains the failure. This classification describes the reread, not an immutable history.

A TransactionConflict reason maps to COMPOSITION_CONFLICT when no conditional reason has already selected a mapping. Unknown service reasons, absent/mismatched cancellation lists and unrelated SDK errors propagate to the generic 500 path. Raw cancellation details are not returned or logged.

## Observability and infrastructure

The existing completion logger recognizes operation **openDrop** and safely allowlists STOREFRONT_CONFLICT. Successful requests log statusCode 200; recognized failures log only the safe application code. Gateway requestId and optional Lambda awsRequestId retain the existing correlation behavior. No headers, tokens, bodies, Product/customer data, or raw exceptions are added to logs. The access-log configuration remains unchanged.

Infrastructure adds only the protected POST route, one proxy integration to the existing Lambda, and one route-scoped Lambda invoke permission. The existing Lambda code asset changes. API/Lambda identities, tables, Cognito, queues, buckets and logging resources remain unchanged.

Lambda IAM remains exactly these CatalogTable-scoped actions:

```text
dynamodb:GetItem
dynamodb:Query
dynamodb:PutItem
dynamodb:DeleteItem
dynamodb:ConditionCheckItem
```

Existing scoped `logs:CreateLogStream` and `logs:PutLogEvents` remain unchanged. No UpdateItem, Scan, BatchWriteItem, wildcard business action, EventBridge or SQS permission is introduced.

The pre-edit `phase-4b2b2a1-resources.json` fixture was captured from main before implementation. Tests compare every existing resource exactly except Lambda Code, and permit precisely one route/integration/invoke-permission addition. The existing protected-resource and logging tests remain in place.

## Limitations and deferred work

This is the authoritative repository operation for a future scheduler, not an automation implementation. No EventBridge resource, execution role, recurring/one-time schedule, automatic invocation, pause/resume/close/sold-out transition, unpublish, storefront replacement, cart, reservation, or payment behavior is added.

There is no upper opening deadline based on closesAt or today's pickup date in this phase; existing metadata constraints remain. OPEN is a lifecycle state, not a guarantee that every future purchase can proceed. Future commerce APIs must independently validate ordering eligibility and inventory transactionally.

Strong reads alone are not a multi-record snapshot; the transaction conditions provide the commit protection. The action-count guard does not guarantee a large menu completes within the current Lambda timeout. Sequential Product reads retain the small-menu approach. After an ambiguous timeout or generic error, inspect state before retrying; a committed open will make a retry return DROP_NOT_EDITABLE.

## Validation and review

Completed local validation:

- Backend: npm ci, typecheck/build, **287 functional tests** and **5 artifact tests** passed. Coverage includes all non-SCHEDULED statuses, exact time boundaries, a deadline passing during reads, monotonic revision timestamps, pointer and Product races, competing opens, action ordering/unique targets, 100/101-action limits, preserved inventory, authorization/input validation, explicit DTOs, public behavior and safe completion logs.
- Infrastructure: npm ci, typecheck/build, **17 tests**, and `npx cdk synth --lookups=false` passed. Exact pre-change resource comparisons permit only the open route/integration/invocation permission and existing Lambda Code update.
- Backend and infrastructure `npm audit --json`: **zero vulnerabilities**. No audit fix, dependency or lockfile changes.
- Repository-wide formatting and `git diff --check` passed.
- Existing tooling notices remain: esbuild install-script approval notice and 83 unconfigured CDK feature flags. No configuration change was needed; builds and artifact tests passed.
- The read-only development AWS diff succeeded after the user refreshed SSO, using `--profile batch-and-batter-dev --no-change-set --lookups=false`. It proposes exactly one protected open route, one integration, one route-scoped Lambda invocation permission, and the existing Lambda code asset/asset metadata update. The IAM summary contains only the expected API Gateway permission to invoke Lambda; the Lambda execution role and business-data permissions are unchanged. No replacements, deletions, DynamoDB/Cognito changes, EventBridge, SQS/S3 changes, or unrelated infrastructure changes. No change set or deployment was performed. The saved local output is `/private/tmp/batch-manual-open-aws-diff.log`.

Final transaction review found no correctness issue requiring a code change. The branch is `feature/phase-4b2b2b1-manual-open`, with eight modified tracked files and five new files, uncommitted. No commit, push, deployment, live DynamoDB write or Cognito mutation occurred.

Suggested commit after review: `feat: add safe manual drop opening`.
