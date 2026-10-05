# Phase 5C1 — Scheduled Drop lifecycle readiness

Local implementation and review only, 2026-10-05. Baseline main and origin/main
were clean and equal at `1dcd2e6a96bd769f717f9db5383446a8b0b244c0`.
Branch: `codex/phase-5c1-scheduled-drop-lifecycle`. No commit, push, deployment,
AWS mutation, Stripe mutation, live Drop mutation or payment enablement.

## Governing requirements

- PRD §§5–7, 30: configurable Drop metadata, products, per-Drop prices and
  inventory; change scheduled opening, cancel/unpublish, manual opening; seven
  existing states. No new cancellation state is necessary.
- PRD §§8–12, 15, 31, 40–41: inventory conservation, protected reservations and
  payment ownership, no duplicate financial effects, impossible adjustments
  rejected, sensitive administrator actions audited.
- PRD §21: material changes affecting accepted orders require communication and
  potentially refunds. Those workflows are outside this phase; excluding all
  customer-bearing Drops avoids silently bypassing them.
- Technical Specification §§9–10, 11–15, 38: explicit storefront pointer, atomic
  inventory ownership and durable recovery, change/cancel one-time openings.
  Implementation Plan Phase 5 explicitly includes schedule change/cancellation;
  Phase 21 dashboard completion is not claimed.
- Existing composition, publish, manual/automatic open and lifecycle documents
  establish the META revision protocol, guarded pointer ownership and transaction
  limits. Phase 5A1/5A2 and payment settlement/recovery documents establish that
  elapsed time, stale work, missing responses and DLQ delivery do not release
  customer ownership. The payment recovery runbook prohibits manual resets.

## Baseline implementation review

| Area                     | Before this change                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States                   | DRAFT, SCHEDULED, OPEN, PAUSED, SOLD_OUT, CLOSED, COMPLETED                                                                                                                                     |
| Drop META                | dropId, name, description, status, opensAt, optional closesAt, quantityLimit, timezone, pickupLocation, pickupInstructions, createdAt, updatedAt                                                |
| Composition              | DropProduct: productId/dropId, priceCents, cookieUnits, displayOrder, active. Pickup: date, startTime/endTime, timezone, active. Reusable Product holds descriptive metadata and active status. |
| Inventory                | total, reserved, sold, updatedAt; available derived as total − reserved − sold                                                                                                                  |
| Implemented admin writes | Product create/replace; DRAFT create/replace; DRAFT product attach/replace/remove and pickup put/remove; publish; open; pause/resume/close; reconcile-opening                                   |
| Missing                  | SCHEDULED edit and cancellation; caller revision on admin mutations; stale generation fencing for rescheduling                                                                                  |
| Partially implemented    | Opening durability: persisted META/pointer reconstruct one-time Scheduler work, but recovery is explicitly operator-driven, without an opening outbox/poller                                    |
| Storefront               | STORE#CONFIG/STOREFRONT points to exactly one current/upcoming Drop; no scan/fallback discovery. Public visibility includes CLOSED; DRAFT/COMPLETED hidden.                                     |
| Concurrency              | updatedAt is the revision; supported composition writes advance META atomically; conditional source state/revision and Product checks guard opening                                             |
| Prior idempotency/audit  | Admin lifecycle repeats conflict safely; no admin success replay receipt. Cart/payment receipts are separate conventions. Safe request logs have no raw identity/token payload.                 |

## API and eligibility

Two JWT-authorized routes to the existing application Lambda:

- `PATCH /admin/drops/{dropId}`: partial metadata plus optional complete `products`
  and `pickups` arrays.
- `POST /admin/drops/{dropId}/cancel`: absent/empty body or strict `{}`.

Both require application `requireAdmin` (access token, nonblank subject/username,
exact administrator group) before input validation or repository access. Both
require exactly one case-insensitive `If-Match` header containing the quoted,
exact `updatedAt` from `GET /admin/drops/{dropId}/composition`. This is a new
explicit admin revision contract, not the Cart's hashed ETag format. Missing,
weak, wildcard, duplicate or malformed header returns 400. Stale revision returns
409 COMPOSITION_CONFLICT. Successful response is the existing explicit `{drop}`
admin DTO, including the new updatedAt; the internal openingRevision is excluded.

Eligibility is conjunctive:

1. Existing Drop status is SCHEDULED and its **old** opensAt is strictly future.
2. Client revision equals the consistently read META.updatedAt.
3. The storefront pointer names this exact Drop.
4. Every inventory record, including inactive/orphan records, has reserved=0 and
   sold=0. Invalid stored records fail closed.
5. An edit's resulting composition passes existing publish-readiness validation,
   including positive active prices/allocations, active reusable Products, unique
   identities, matching inventory and at least one active pickup on/after the
   opening calendar date. New opensAt must also be strictly future.
6. The entire transaction fits 100 unique actions and the audit-size bound.

Read META first. Sample server time again immediately before dispatch. DynamoDB
cannot compare against a live wall clock at its physical commit instant; a
transaction may complete after the last sampled instant. Exact SCHEDULED/revision
conditions serialize it against an opening transaction. No unconditional retry.

## Responsibility proof and limits

The safe rule is stricter than merely checking an expired Cart deadline: no
customer-bearing lifecycle state is eligible, and no reserved or sold quantity
may exist anywhere in the Drop's inventory.

Supported state transitions create SCHEDULED **only from DRAFT**. There is no
OPEN/PAUSED/CLOSED/COMPLETED → SCHEDULED transition, and this phase adds none.
Cart acquisition atomically checks exact OPEN META revision and storefront
ownership. ACTIVE Cart creation is nonempty and owns RESERVED inventory. Payment
admission originates from that Cart; PAYMENT_PENDING, PAYMENT_COMMITTING,
unresolved Attempts, authorization/capture/recovery work retain reservation
ownership until definitive atomic release/settlement. PAID Orders own SOLD.
An expired ACTIVE Cart still owns RESERVED and is not safe merely because time
passed. All such responsibilities exclude edit/cancel via lifecycle state and/or
nonzero inventory. No financial terms or pickup promise is changed under them.

Reservation work and payment work are not scanned: their keys are by Cart,
Attempt or time/shard, with no strongly consistent Drop responsibility index.
For supported writers a never-opened SCHEDULED Drop cannot have created any of
these obligations, including zero-owned terminal work remnants. Stale delivery
against already-settled work does not create fresh ownership. This is an invariant
proof, **not** a claim to detect arbitrary manually corrupted Commerce/Operations
records with falsely zero Catalog counters. Manual state resets/data imports or
any future return-to-SCHEDULED writer would invalidate the proof and require a
transactional responsibility fence/index before being allowed. Existing recovery
rules prohibit those resets. No Commerce/Operations scanning or new IAM is added.

## Field contract and inventory

| Fields                                                                                            | Contract                                                                                              |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| name, description, opensAt, closesAt, quantityLimit, timezone, pickupLocation, pickupInstructions | Conditionally mutable under all eligibility rules; omitted fields preserved; closesAt:null removes it |
| Product inclusion/removal, priceCents, cookieUnits, displayOrder, active, inventoryTotal          | Conditionally mutable using complete `products` array; omission preserves existing composition        |
| Pickup date, startTime, endTime, timezone, active                                                 | Conditionally mutable using complete `pickups` array; omission preserves existing pickups             |
| dropId, createdAt, status, updatedAt, openingRevision, reserved/sold, audit identity              | Client-immutable/server-owned; unknown fields rejected                                                |
| Reusable Product metadata/IDs                                                                     | Not patched here; existing separate Product APIs remain as before                                     |
| Reminder, refund, cancellation policy, pickup-change cutoff configuration                         | Not implemented in the existing persisted model; no new powers/settings introduced                    |

PATCH is nonempty and strict. Metadata string limits: name 200, description and
instructions 4,000 each, location 1,000, timezone 100. Products max 20; pickups max 14. Wire body bounded to 32 KiB before decoding. Quantities/cents/units are safe
integers with existing domain bounds. Cross-field invalid final configuration is
409 DROP_NOT_READY; malformed request fields are 400 VALIDATION_ERROR.

All old inventory gets a transaction-time zero-reserved/zero-sold condition,
including metadata-only edits and cancellation. New inventory requires absence.
Quantity reduction below ownership, product removal with ownership, and even
price-only changes with ownership are rejected. No owned counters are reset.
Available + reserved + sold = total remains true. Replacement inventory revision
advances; removed zero-owned inventory/associations may be deleted, with complete
prior allocation retained in the immutable audit. Cancellation deletes **no**
composition or inventory records.

Every composition edit atomically advances META. This preserves the assumption
used by opening and Cart acquisition; neither can commit against pre-edit META.
Referenced reusable Products get exact existence/active/revision checks.

## Cancellation and storefront

Cancellation is SCHEDULED → CLOSED, preserving metadata, inventory, Products,
DropProducts and pickups. The same transaction conditionally deletes only this
Drop's storefront pointer. No force or return-to-DRAFT path exists; cancel is
terminal with respect to supported opening operations. Duplicate cancel returns
409 without another audit/write. Admin composition remains readable.

Current/upcoming returns null after cancellation unless another Drop is published.
Direct public `GET /drops/{dropId}` retains the established CLOSED representation;
it does not offer purchasing. This is cancellation of ordering/public selection,
not archival deletion. A read overlapping a transaction can observe the earlier
snapshot because public composition uses separate consistent reads. Requests
started after completion see the resulting configuration/pointer. No frontend
redesign or customer UI is added.

## Opening generations and recovery

An edit atomically persists optional `openingRevision = new updatedAt` with the
configuration. Each edit, even metadata-only, creates a new opening generation.
Scheduler name is `open-<dropId>-<20 hex SHA256 characters of openingRevision>`;
legacy unedited Drops retain `open-<dropId>` and the original payload. Names remain
under the service length bound and within existing `open-*` IAM. Create/Get,
exact configuration verification, deterministic ClientToken, retry policies and
automatic completion cleanup remain unchanged. No Update/Delete/List permission.

New payload adds openingRevision. Automatic opening passes a delivery object into
the shared repository operation. Exact stored/delivery generation equality is
checked after reading META, before composition/opening; the existing write-time
META state/revision guard protects subsequent races. A legacy unversioned event
is valid only for a Drop without openingRevision. Superseded generation returns
terminal STALE_OPENING even if the newly scheduled opening time has already passed.
Manual opening intentionally omits delivery fencing and still uses all current
state/time/readiness/revision checks.

A future rollout must retain readers that accept openingRevision and the generation
fence. Rolling back to the previous strict Drop schema after an edit would reject
those records; rolling back opening logic could also remove stale-delivery safety.
This is a deployment/rollback review requirement, not permission to migrate or
mutate live data during this phase.

Old schedules are not deleted or updated; they can deliver once at their original
time and become harmless terminal no-ops, then use existing Scheduler automatic
cleanup. CLOSED blocks matching-generation delivery; mismatched-generation
canceled delivery is stale. Duplicate delivery never reopens a closed Drop.
Reconciliation requires SCHEDULED/owned pointer and cannot reopen canceled Drops.
A reconciliation read racing edit/cancel can create obsolete work, but that work
cannot pass the generation/state fence.

After the transaction, PATCH attempts schedule creation. Failure returns 503
OPENING_SCHEDULE_UNCONFIRMED explicitly stating **the edit committed**. Process
crash/timeout can leave an ambiguous response. Read admin composition; do not
blindly mint a fresh edit. Existing `POST .../reconcile-opening` reconstructs the
current generation from persisted META. Before the deadline it retries ensure;
after the deadline it returns OPENING_TIME_PASSED and the existing manual open
operation is the recovery path after inspection. This preserves operator-driven
recovery; it does not promise automatic eventual repair.

## Audit, repeats and security

The same Catalog transaction inserts an immutable conditional-absence
`DROP#<dropId> / ADMIN_CHANGE#<prior updatedAt>` record containing operation,
authenticated Cognito subject, server timestamp, and complete before/after Drop,
relations, inventory and pickups. No raw token, claims, provider/customer data or
secret is stored/logged. Serialized audit is limited to 300,000 bytes, below the
DynamoDB item limit with room for map/list overhead. Existing Catalog PutItem
permission suffices. There is no new general audit service or audit UI/API.

The source revision allows only one successful edit/cancel and one audit; repeated
HTTP requests conflict safely, matching existing admin lifecycle conventions.
There is no Cart-style Idempotency-Key/success replay contract. Read current state
after an ambiguous response, and use reconciliation for scheduling recovery.
Logs contain only the existing allowlisted request fields and stable operation
names editScheduledDrop/cancelScheduledDrop. No public mutation route is added.

## Tests and scope

`backend/test/scheduled.test.ts` covers valid metadata/composition edit, allocation
history, current storefront, cancellation preservation/visibility, old and current
opening generations, legacy delivery, earlier/later opening, duplicate requests,
manual opening, reconciliation after partial scheduling failure, all disallowed
Drop states, reserved/sold blockers and reduction, exact opening boundary, revision,
opening, inventory, pointer, Product and audit races, auth-before-validation,
strict fields/header validation, transaction/audit bounds and closing-time rules.
Existing Cart/payment/expiry tests verify the ownership protocols used by the
eligibility proof. Existing scheduler tests retain exact configuration, ambiguous
creation/retry, legacy delivery and error-sanitization coverage. Infrastructure
tests assert both new routes use the existing JWT authorizer and preserve exact
IAM/resource constraints. Frontend regression suite remains unchanged.

Infrastructure additions are only two API routes, two integrations and two
route-scoped Lambda invocation permissions, plus the shared backend asset update (all five Lambda Code references).
These six CloudFormation resources require human review before any deployment.
No new execution IAM, table, index, queue, Scheduler group/role, timer system or
other service is required. No resource replacement/deletion is intended.

Non-goals: admin dashboard, Cart/checkout/payment UI, Stripe/payment changes,
refunds, notifications, waitlist, payment activation, automatic opening recovery
poller, broader Phase 21 completion. No live acceptance is claimed.

## Validation evidence

- Backend typecheck/build: passed. **902 functional tests (58 new)** and **7 artifact tests**, zero failures. Existing reservation, expiry, payment admission/settlement/recovery and legacy opening regressions remain green.
- Frontend: **69 tests**, all passed. No frontend source/configuration changes; no UI redesign. **2 production-exclusion artifact tests** passed against existing web artifacts and freshly built Lambda inputs. A fresh frontend build was not needed for this backend-only change.
- Infrastructure: typecheck/build, **34 tests**, and `npm run synth` passed. The existing 83-unconfigured-feature-flags notice remains unchanged.
- Audits: backend zero; infrastructure one high affected brace-expansion package with exactly the three documented advisories; frontend seven affected package nodes (six high, one moderate) with exactly the documented braces/PostCSS advisories. Existing `DEPENDENCY_RISKS.md` exceptions remain unchanged. No dependency/lockfile edits, fixes or suppressions.
- Read-only AWS identity matched account `302154194958`. Live application `PAYMENT_START_ENABLED` was read as **false** in us-east-2. No secret values were requested, printed or saved.
- Read-only `cdk diff batch-and-batter-dev --profile batch-and-batter-dev --no-change-set --lookups=false` succeeded. Exactly two routes, two integrations and two route-scoped API Gateway invocation permissions added. All five Lambda Code/asset references change because they share one backend asset. No execution-role policy, environment, table/index, queue, Cognito, hosting or Scheduler-resource changes; **zero resource replacements/deletions**.
- Repository formatting and `git diff --check`: passed. No generated artifacts tracked. At the implementation review checkpoint, the state was 9 modified tracked files and 4 new untracked files, all unstaged on the phase branch; HEAD remained the approved main baseline.
- Validation logs are local `/tmp/phase5c1-*` files, not repository artifacts. Initial validation caught a Zod refined-schema construction error and duplicate CDK route wiring; both were corrected before the passing runs. No failed checks remain.

Ready for human code/design review, including the invariant-based responsibility
proof, operator-driven opening recovery limitation and six API wiring resources.
This is not deployment approval or live acceptance.

## Files changed

- `backend/src/admin-scheduled.ts` — new protected request adapter.
- `backend/src/scheduled-input.ts` — new bounded strict PATCH schema.
- `backend/src/repository.ts` — transactional edit/cancel, audit and delivery fencing.
- `backend/src/domain.ts` — optional server-owned openingRevision.
- `backend/src/opening-schedules.ts` — deterministic generation schedule identities.
- `backend/src/auto-open.ts` — generation-aware internal delivery.
- `backend/src/api.ts` — authenticated dispatch and safe errors.
- `backend/src/request-logging.ts` — two allowlisted operation names.
- `backend/test/fixtures.ts` — repository fixture interface update.
- `backend/test/scheduled.test.ts` — 58 new lifecycle regressions.
- `infra/lib/development-stack.ts` — two JWT routes and their wiring.
- `infra/test/development-stack.test.ts` — exact route/auth/resource expectations.
- `docs/PHASE_5C1_SCHEDULED_DROP_LIFECYCLE.md` — this review and contract.

The initial implementation checkpoint performed no commit, push, deployment,
financial mutation or live Drop mutation. Human review subsequently approved
repository finalization: commit only these 13 files, push the feature branch and
open a PR to main. Broader admin/dashboard phases remain incomplete.

## Approved repository finalization and Phase 5C2 gate

**DO NOT DEPLOY AUTOMATICALLY AFTER MERGE.**

Phase 5C1 human review is approved. Repository finalization does not authorize
AWS/Stripe mutations, live Drop edits/cancellation, or payment enablement.
PAYMENT_START_ENABLED must remain false. The accepted invariant/corruption boundary
and operator-driven recovery limitation above remain in force.

A separately reviewed Phase 5C2 DEV deployment/acceptance gate must:

1. Sync merged main.
2. Read-only verify PAYMENT_START_ENABLED=false.
3. Review the final CDK diff.
4. Deploy the new admin routes with admission still false.
5. Verify admin authentication.
6. Create/use a DEV scheduled test Drop.
7. Live-test one safe scheduled edit.
8. Prove stale old-generation opening work cannot win.
9. Live-test scheduled cancellation.
10. Prove the canceled Drop cannot reopen.
11. Prove storefront current/upcoming behavior updates correctly.
12. Verify queues, recovery and alarms.
13. Leave payment admission false.
14. Clean up the acceptance Drop safely.

No production payment activation. Stop after PR creation for human review.

## Phase 5C2 — live DEV acceptance, human approved

**PHASE 5C2 — DEV SCHEDULED-DROP LIFECYCLE ACCEPTANCE: PASSED.**

Human review approved the following live acceptance on 2026-10-05. This is a
separate record of the subsequently authorized DEV deployment and acceptance;
the local implementation history and earlier deployment gate above remain
historical evidence. Recording this approval authorizes no further deployment,
AWS/Stripe mutation, live Drop mutation or payment enablement.

### Deployment and pre-deploy safety

- Deployed main HEAD: `cbb195ae51acf94ea24266fb16a3c11c763256fa`.
- DEV deployment through the normal helper succeeded; stack reached `UPDATE_COMPLETE`.
- `PAYMENT_START_ENABLED=false` before deployment, immediately after deployment,
  and at the end of acceptance. It must remain false.
- Final reviewed CDK scope: six approved API wiring additions and five shared
  Lambda asset updates; no execution-role expansion, replacements or deletions.
- Pre-deploy checks found no active customer Cart/payment responsibility or
  unresolved payment/workflow/Stripe-event responsibility. Queues/DLQs, alarms
  and recovery heartbeats were healthy.

### Dedicated acceptance Drop and timeline

Exactly one DEV acceptance Drop used **Development Test Cookie**:
`01M472Q8CNZSGQJVV8GR4A8BMK`.

Initial state was SCHEDULED, with the current/upcoming storefront pointer owned by
this Drop. Initial inventory was **20 total / 0 reserved / 0 sold / 20 available**.
No customer Cart or payment was created for this acceptance.

| Checkpoint            | Opening time                           | Revision                   | Opening generation                     |
| --------------------- | -------------------------------------- | -------------------------- | -------------------------------------- |
| Initial SCHEDULED     | `2026-10-05T22:30:02.504Z`             | `2026-10-05T22:25:04.087Z` | Legacy/unversioned                     |
| Rescheduled SCHEDULED | `2026-10-05T22:33:02.504Z`             | `2026-10-05T22:25:10.386Z` | `2026-10-05T22:25:10.386Z`             |
| Canceled CLOSED       | `2026-10-05T22:33:02.504Z` (preserved) | `2026-10-05T22:25:36.209Z` | `2026-10-05T22:25:10.386Z` (preserved) |

The protected reschedule succeeded: revision and generation advanced,
deterministic replacement opening responsibility was established, and inventory
remained unchanged. The public API and live `batchandbatter.com` storefront both
reflected the new opening time; backend state remained authoritative.

### Stale opening and reconciliation proof

Direct replay of the old opening payload returned terminal `STALE_OPENING` while
the Drop remained SCHEDULED with the new opening time. Current-generation
reconciliation succeeded while the Drop remained SCHEDULED.

After cancellation, both direct replay paths were harmless: the old payload
returned terminal `STALE_OPENING`, and the current-generation payload returned
terminal `DROP_NOT_EDITABLE`. Reconciliation returned **409 DROP_NOT_EDITABLE**;
no reconciler path reopened the Drop.

Natural Scheduler deliveries independently confirmed the guards:

| Delivery                                | Observed time              | Terminal result     |
| --------------------------------------- | -------------------------- | ------------------- |
| Old opening responsibility              | `2026-10-05T22:30:44.242Z` | `STALE_OPENING`     |
| Later/current-generation responsibility | `2026-10-05T22:33:32.206Z` | `DROP_NOT_EDITABLE` |

No stale generation opened the Drop. It remained CLOSED after the later delivery.
Both schedules cleaned up automatically; no schedule remained after settlement.
No transport evidence was manually deleted to obtain a passing result.

### Cancellation, storefront and history

Cancellation atomically transitioned SCHEDULED → CLOSED at revision
`2026-10-05T22:25:36.209Z`, preserved scheduled opening metadata/history and
inventory, released current/upcoming storefront ownership, and prevented later
automatic opening.

After cancellation, the current public API returned null and the live storefront
no longer displayed the test Drop. Historical/direct and administrator reads
continued to return the CLOSED Drop.

A stale-revision mutation attempt returned **HTTP 409 COMPOSITION_CONFLICT**.
Drop state, inventory and audit count were unchanged by the rejected request.

Exactly two immutable audit records were verified:

1. Scheduled Drop edit.
2. Scheduled Drop cancellation.

Each included administrator identity, timestamp and verified before/after state,
including the unchanged allocation/ownership quantities. No sensitive token values
are included in this record.

Final cleanup state: the dedicated test Drop remains **CLOSED**, with inventory
**20 total / 0 reserved / 0 sold / 20 available**. Historical composition and audit
evidence are preserved; counters were not reset and history was not rewritten.

### Final health and security

- All seven queues/DLQs had **0 visible / 0 invisible / 0 delayed** messages.
  No messages were manually deleted.
- All alarms were **32 / 32 OK**. Both recovery heartbeats were fresh, with no
  unresolved workflow responsibility.
- Both new administrator routes require JWT authentication. Anonymous requests
  returned **401**; missing/invalid/unquoted If-Match and prohibited fields were
  rejected safely with **400**.
- Reviewed API Gateway and Lambda logs showed no token/sensitive-data matches
  within the acceptance window. This is scoped log-review evidence, not a claim
  of exhaustive detection outside that window.
- No payment-worker or Stripe-webhook activity occurred during acceptance.
- No customer Cart/payment creation, Stripe mutation, production Drop mutation,
  payment enablement, refund, notification or waitlist work occurred.

### Accepted boundaries and governing status

No acceptance defects were found. The existing boundaries remain accepted:
customer responsibility safety relies on established lifecycle/ownership
invariants; arbitrary corrupted Commerce data is not independently scanned by
lifecycle mutation; scheduling recovery remains operator-driven through the
existing reconciliation mechanism; broader admin/dashboard UI remains separate.
These are retained design boundaries, not newly identified defects. Existing
rollback compatibility requirements remain in force.

| Phase / scope                                  | Human-approved disposition                   |
| ---------------------------------------------- | -------------------------------------------- |
| Phase 5A — read-only storefront                | COMPLETE                                     |
| Hosting A/B — Amplify/domain                   | COMPLETE                                     |
| Phase 5C1 — scheduled lifecycle implementation | COMPLETE                                     |
| Phase 5C2 — live lifecycle acceptance          | PASSED                                       |
| Governing Phase 5 lifecycle-management gap     | COMPLETE within approved backend/admin scope |
| Broader admin/dashboard phases                 | NOT COMPLETE                                 |

This documentation-only acceptance record does not authorize application or
infrastructure changes, deployment, live mutations, or production payment
activation. `PAYMENT_START_ENABLED` must remain false.
