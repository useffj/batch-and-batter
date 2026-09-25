# Phase 4B2B2B3 — Manual pause, resume and close

## Scope and existing public behavior

This phase adds exactly:

- `POST /admin/drops/{dropId}/pause`: OPEN → PAUSED.
- `POST /admin/drops/{dropId}/resume`: PAUSED → OPEN.
- `POST /admin/drops/{dropId}/close`: OPEN → CLOSED or PAUSED → CLOSED.

Every other source status is rejected with 409 `DROP_NOT_EDITABLE`. No force flag, scheduled cancellation, SOLD_OUT transition, COMPLETED transition, automatic close, commerce, reservation or payment behavior is introduced.

Before this phase, the public visibility allowlist already included SCHEDULED, OPEN, PAUSED, SOLD_OUT and CLOSED; DRAFT and COMPLETED were hidden. That allowlist and all public DTOs remain unchanged. Direct `GET /drops/{dropId}` can therefore still show CLOSED. There is no new archive capability.

The storefront pointer previously remained assigned indefinitely after publication/opening. Pause and resume preserve it. Successful close atomically removes it. A subsequent `GET /drops/current` returns `{ "drop": null }` unless another Drop has since been published. Closing preserves Drop META, reusable Products, DropProducts, inventory and pickups. No historical business data is deleted.

Public reads are composed from separate consistent reads, not a multi-record transaction. A read overlapping close can observe an earlier pointer snapshot; requests begun after successful close see the released pointer. This phase does not redesign read consistency.

## Authorization, input and output

All three routes use the existing API Gateway JWT authorizer and application `requireAdmin` boundary with exact `batch-and-batter-admins` membership. Authorization precedes body/path validation and repository access. An absent/empty body or strict JSON `{}` is accepted, including the existing base64 JSON handling. Supplied status, timestamps, IDs, force flags, storefront values and PK/SK are rejected.

Success is HTTP 200 `{ "drop": <explicit admin Drop DTO> }`, using existing `dropDto`. Only status and server-generated updatedAt change. All other metadata and createdAt are preserved. Responses have no PK/SK or composed public products/pickups. Close does not add a separate storefront DTO.

Stable completion operations are `pauseDrop`, `resumeDrop`, `closeDrop`. Existing safe structured fields remain event, API requestId, Lambda lambdaRequestId, routeKey, operation, statusCode and optional allowlisted error code. No raw requests, authorization, credentials, customer data or DynamoDB cancellation details are logged.

## Transactions and revision protocol

Each operation first consistently reads Drop META. Every write uses the exact source status and revision observed, and `updatedAt(previous.updatedAt)` generates `max(serverNow, previous + 1 ms)`. No unconditional retry occurs. All actions target CatalogTable; no transaction targets a complete PK/SK twice.

### Pause

After verifying OPEN, the repository consistently reads the storefront pointer and rejects a missing/different owner. The write is a single-action TransactWrite:

| Index | Action          | PK / SK                |
| ----- | --------------- | ---------------------- |
| 0     | Conditional Put | `DROP#<dropId> / META` |

It writes PAUSED and the advanced revision, preserving all metadata. It does not write, delete or transactionally check the pointer, as required by the single-Put design. The initial pointer check provides a useful ownership error. Among supported writers, the only way to release this OPEN Drop's pointer is close, which changes the same META status/revision atomically and invalidates pause. Arbitrary out-of-band pointer changes are not protected by this single-action transaction; any future independent pointer writer must revisit this assumption.

### Resume

`resumeDrop` and `openScheduled` delegate to the same private `openFrom` operation with PAUSED and SCHEDULED respectively. `isOpenReady` takes the expected source status, defaulting to SCHEDULED so existing callers retain their behavior. This parameter does not come from HTTP or the internal event. There is no synthetic status override or force path.

Read META first, then storefront, composition/inventory/pickups, and active referenced reusable Products. Validate the same existing opening invariants after loading, including server time >= opensAt, valid metadata and record identities, active associations/pickup, positive price/units/total, structurally valid inventory and active Products. Existing opening behavior has no new closesAt/pickup-expiration restriction or requirement for positive remaining availability. This phase preserves that behavior.

| Index | Action                                        | PK / SK                      |
| ----- | --------------------------------------------- | ---------------------------- |
| 0     | Conditional Put OPEN, advance revision        | `DROP#<dropId> / META`       |
| 1     | ConditionCheck storefront ownership           | `STORE#CONFIG / STOREFRONT`  |
| 2+    | ConditionCheck each active referenced Product | `PRODUCT#<productId> / META` |

There are `2 + active Product count` actions; at most 98 Product checks fit the 100-action limit. Excess returns `DROP_NOT_READY` before a transaction. Unique valid associations prevent duplicate Product targets.

Current composition and inventory configuration writes are DRAFT-only and advance META in the same transaction. They cannot mutate a PAUSED composition. Reusable Products are independently editable, so every active referenced Product receives existence/active/revision conditions. No inventory is reset or changed. No Scheduler call occurs.

### Close

After consistently reading META, accept only OPEN or PAUSED and verify storefront ownership. One transaction performs:

| Index | Action                                   | PK / SK                     |
| ----- | ---------------------------------------- | --------------------------- |
| 0     | Conditional Put CLOSED, advance revision | `DROP#<dropId> / META`      |
| 1     | Conditional Delete of owned pointer      | `STORE#CONFIG / STOREFRONT` |

The Put requires the exact source status read, not an OR accepting either status at commit. The pointer Delete requires this exact Drop ID. A missing or reassigned pointer rejects the transaction; neither action commits. No close can remove another Drop's pointer. Successful deletion allows subsequent publication to claim the vacant storefront through the existing conditional publication transaction.

### Exact expressions

Pause and close Drop Put:

```text
attribute_exists(PK) AND #status = :source AND #updated = :expected
```

Names: `{ "#status": "status", "#updated": "updatedAt" }`.
Values: `{ ":source": <exact OPEN or PAUSED source read>, ":expected": <Drop.updatedAt read> }`. Pause source is always OPEN.

Resume Drop Put:

```text
attribute_exists(PK) AND #status = :paused AND #updated = :expected
```

Same names; values `{ ":paused": "PAUSED", ":expected": <Drop.updatedAt read> }`. Existing manual/automatic opening still uses `:scheduled = SCHEDULED` and its previous exact expression.

Resume storefront ConditionCheck and close storefront Delete:

```text
#storefrontDropId = :dropId
```

Names `{ "#storefrontDropId": "storefrontDropId" }`; values `{ ":dropId": <path Drop ID> }`. An absent item fails equality.

Resume Product ConditionCheck:

```text
attribute_exists(PK) AND #active = :active AND #updated = :expected
```

Names `{ "#active": "active", "#updated": "updatedAt" }`; values `{ ":active": true, ":expected": <Product.updatedAt read> }`.

## Errors and cancellation mapping

| Condition                                     | HTTP / code                |
| --------------------------------------------- | -------------------------- |
| Invalid body/path                             | 400 `VALIDATION_ERROR`     |
| Missing authentication                        | 401 `UNAUTHORIZED`         |
| Invalid token purpose/admin group             | 403 `FORBIDDEN`            |
| Missing initial Drop                          | 404 `DROP_NOT_FOUND`       |
| Unsupported source or repeated operation      | 409 `DROP_NOT_EDITABLE`    |
| Missing/wrong storefront                      | 409 `STOREFRONT_CONFLICT`  |
| Invalid resume readiness/action limit         | 409 `DROP_NOT_READY`       |
| Same-source revision conflict or Product race | 409 `COMPOSITION_CONFLICT` |
| Unexpected service/internal failure           | 500 `INTERNAL_ERROR`       |

Lifecycle `DROP_NOT_EDITABLE` message: `Drop status does not allow this operation.` Resume `DROP_NOT_READY` message: `Drop is not ready to open.` Existing unrelated route messages are preserved.

The shared transaction cancellation mapper examines valid cancellation lists in action order. Index 0 conditional failure consistently rereads META: missing → DROP_NOT_FOUND; status differs from the exact source read → DROP_NOT_EDITABLE; same source → COMPOSITION_CONFLICT. This is classification at reread time, including later races. Index 1 (resume/close) → STOREFRONT_CONFLICT. Resume indexes 2+ → COMPOSITION_CONFLICT. If multiple conditions fail, the first index wins. A valid TransactionConflict reason maps to COMPOSITION_CONFLICT; absent/malformed lists, unknown service reasons and generic failures remain generic 500. No cancellation payload is exposed.

## Race analysis

| Race                                       | Protection and outcome                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause vs pause                             | Both expect OPEN and its revision; only one commits. Loser sees PAUSED → DROP_NOT_EDITABLE. An intervening return to OPEN still changes revision → COMPOSITION_CONFLICT.                                                                                               |
| Pause vs close                             | Shared META guards serialize them. Close uses its exact OPEN source; a concurrent pause makes close fail DROP_NOT_EDITABLE, even though a fresh close of PAUSED would be legal. If close wins, pause fails DROP_NOT_EDITABLE.                                          |
| Resume vs close                            | Both expect PAUSED/revision when racing from PAUSED. Winner changes status/revision; loser fails DROP_NOT_EDITABLE. Close cannot silently follow a resume it did not read.                                                                                             |
| Resume vs Product edit                     | Before-read invalid Product → DROP_NOT_READY; after-read revision/active/existence change → Product check fails COMPOSITION_CONFLICT. An edit after a committed resume remains possible, as with existing opening.                                                     |
| Resume vs pointer removal/reassignment     | Initial mismatch → STOREFRONT_CONFLICT; commit-time mismatch → same via index 1. If META also fails, index 0 has priority.                                                                                                                                             |
| Close vs pointer removal/reassignment      | Conditional Delete prevents deleting another assignment or partially closing. Missing/other pointer → STOREFRONT_CONFLICT; simultaneous META failure takes index-0 priority.                                                                                           |
| Close vs future commerce/inventory writers | None exist now. Close preserves inventory. Future ordering must atomically require OPEN and valid ownership/inventory; these lifecycle controls alone cannot make an unchecked future writer safe. Existing paid orders must remain valid through pause/close.         |
| Automatic opening vs controls              | Automatic open remains SCHEDULED-only. Controls reject SCHEDULED; an old event against OPEN/PAUSED/CLOSED remains benignly terminal. Once automatic opening commits, controls may act on the newly read state. No retry semantics or scheduling configuration changes. |

Initial reads are not an atomic snapshot; commit conditions are the write authority. After an ambiguous timeout/500, inspect status before retrying. Future ordering must reject PAUSED/CLOSED and transact its eligibility check; OPEN alone is not a reservation or inventory guarantee.

## Infrastructure, IAM and remaining work

Only three protected API routes, three integrations to the existing Lambda and three route-scoped API Gateway invoke permissions are added. The existing Lambda code asset changes. Execution-role policies, Scheduler group/role/configuration, EventInvokeConfig, Lambda environment, API identity, tables, Cognito, S3/SQS and access logging are unchanged. Existing Catalog GetItem, Query, PutItem, DeleteItem and ConditionCheckItem permissions suffice; no UpdateItem, Scan, BatchWriteItem or wildcard access is added.

Deferred work: SOLD_OUT transitions, automatic close, COMPLETED/cancel/unpublish controls, commerce/reservations/payments, durable audit history and durable exhausted-async-retry capture/alerting. No change to the accepted automatic-opening recovery limitation is made.

## Prior automatic-opening live acceptance

Observed development acceptance:

- Stored opensAt: `2026-09-24T17:06:23.000Z`.
- Automatic invocation START: `2026-09-24T17:07:03.555Z`.
- Observed invocation delay: **40.555 seconds**, approximately **40.6 seconds**.
- One automatic invocation observed; Drop became OPEN during it; no manual open, retry or conflict observed; current storefront returned the same OPEN Drop; deterministic schedule subsequently absent.

This is an observed development result, not a guaranteed Scheduler SLA. Application logs omit Drop IDs; correlation used the persisted update timestamp within the invocation and the surrounding API history.

## Validation

Completed on `feature/phase-4b2b2b3-lifecycle-controls`, based on clean/current main `4c26a15c3c59d5c84599f6d833391fb87cb83a35`:

- Backend clean install, typecheck/build, 375 functional tests and 5 artifact tests passed.
- Infrastructure clean install, typecheck/build and 18 tests passed. The new pre-change baseline compares every existing resource exactly except Lambda Code: execution-role IAM, Scheduler resources, EventInvokeConfig, Lambda environment, tables, Cognito, S3/SQS and logging remain unchanged.
- Backend and infrastructure audits each reported zero vulnerabilities. No dependency or lockfile changes.
- `npx cdk synth --lookups=false` passed from infra. An earlier command ran from the repository root without cdk.json and failed before synthesis; the corrected invocation succeeded.
- Formatting check and `git diff --check` passed.
- Read-only development CDK diff succeeded: exactly three routes, three integrations, three route-scoped Lambda invoke permissions and the existing Lambda code/asset metadata update. No replacements, deletions or unrelated changes. Output: `/private/tmp/lifecycle-cdk-diff.log`.
- Direct CDK `--profile batch-and-batter-dev` credential resolution failed despite successful AWS CLI STS verification. The successful diff used temporary credentials obtained from that same profile, passed only in memory to the subprocess, with verified account 302154194958 and region us-east-2. Credentials were neither printed nor saved. `--no-change-set --lookups=false` remained in effect.
- Final implementation review required no production-code changes. Working tree contains nine modified and four new phase files, uncommitted. No commit, push, deployment, runtime invocation or live AWS mutation occurred.

Suggested commit after human approval: `feat: add pause resume and close controls`.
