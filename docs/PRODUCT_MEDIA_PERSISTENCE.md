# 1B-2C — Atomic media metadata persistence

Local implementation only, based on main
`193e7a7146718eb87de8434ee5ecca244efe5fba`. No routes, AWS resources,
permissions, readiness markers, S3 orchestration or deployments are introduced.
The previous media UI and separately packaged Sharp core are preserved.

## Durable contract

`media-records.ts` validates versioned persisted manifests, assets, upload intents,
and compact tombstones. It rejects unknown fields, corrupt ownership, inconsistent
request hashes, lease histories and receipts. Processor metadata must contain
complete JPEG/WebP pairs, valid dimensions, bounded bytes and exact immutable
Product/media/attempt-scoped keys. Image bytes are never stored.

`MediaRepository` uses only strongly consistent keyed reads, bounded partition queries and transactions in
the existing Catalog table. It introduces no scan, table, index or TTL policy.
Read operations are manifest, asset and administrator-scoped upload lookup.

Mutation operations are `replaceManifest`, `createUpload`, `queue`, `claim`,
`complete`, `failProcessing`, `expire`, `compact` and `fenceDeletion`.
Every mutation transaction condition-checks the existing readiness marker,
Product identity/createdAt/updatedAt/slug and slug ownership. No Product record is
rewritten. Successful receipt replays perform no mutation and remain recoverable
if readiness is later withdrawn.

Manifest replacement atomically compares manifest revision, checks unchanged
attached asset revisions and updates newly attached/retired assets. Missing
manifest requires expected revision zero. Every item has exactly one transaction
action. At most 12 asset records are involved (six removed plus six added).
Primary selection and ordering are the manifest array; alt edits preserve assets.
Stale changes report MEDIA_REVISION_CONFLICT. No removal deletes bytes.

Upload identity is the approved versioned administrator/Product/request-key hash.
Conditional creation reserves it once; concurrent identical creation and lost
acknowledgements recover the original intent. Conflicting hashes fail. Deadlines
are never extended. Expired pending operations return UPLOAD_EXPIRED and may be
explicitly persisted EXPIRED. READY completion stores both the asset and its
original result snapshot in the same transaction, so later asset retirement does
not change the receipt.

Processing claims compare the previous durable revision. Each attempt UUID is
retained in a maximum-three-entry history and cannot be reused. Expired leases
may be superseded; old revisions cannot finalize. Completion rechecks the lease
following guard reads, immediately before transaction submission. It conditionally
creates the asset and replaces the intent atomically. Duplicate successful
notifications replay the original result; terminal invalid-media failures cannot
be retried as successes.

Only the trusted future worker may call `complete`. Metadata shape validation is
not proof of image processing. HTTP clients must never be allowed to supply this
method's verification result. Existing Cognito administrator authorization and
same-origin/session protections remain the responsibility of the next API slice.
No new API route exists now.

## Retention and uncertainty

Receipt compaction after 30 days retains identity, administrator, Product, version,
request hash and revision. Tombstone keys remain reserved indefinitely; equal
requests return UPLOAD_RESULT_EXPIRED, conflicting requests IDEMPOTENCY_CONFLICT.
No tombstone TTL is set.

READY/RETIRED assets require seven days and no manifest reference before a
conditional DELETING fence. Both the asset and the manifest revision (or absence)
are checked in the transaction; attachment cannot race with the fence. ATTACHED
assets do not expire. There is no deletion executor or scheduled cleanup.

Approved 1B-2G policy: seven days is cleanup eligibility, not an attachment
deadline or automatic expiration. An authoritative READY asset remains discoverable
and attachable after seven days until cleanup actually commits DELETING. DELETING,
DELETED and RETIRED assets cannot be newly attached. Each lifecycle transition
advances the asset revision. Attachment and fencing condition that revision and
the manifest revision in their respective transactions: attachment winning blocks
fencing; fencing winning blocks attachment. Preliminary reads alone do not grant
attachment eligibility. Existing ATTACHED assets retain protection regardless of age.

Attempt history and original intent expiry allow future operator inventory of
incomplete output prefixes. A conservative seven-day output grace starts after
intent expiry. Inventory/reconciliation must precede receipt compaction if attempt
history is needed; otherwise a separately authorized S3 inventory is necessary.
This adapter does not discover orphan objects or claim they were removed.

All writes have revision conditions. Transaction cancellation reasons are used
only when complete and explicit; other errors become MEDIA_STORAGE_UNAVAILABLE.
No blind application-level write retry occurs. Intent creation, transitions and
completion reconcile a strongly consistent durable result after an ambiguous
write outcome. Manifest callers must reload after an uncertain result rather than
assuming rollback or repeating an old revision. No raw provider messages are
returned.

## Validation and limitations

`backend/scripts/test-media-local.mjs` fixes the endpoint to
`http://127.0.0.1:18765`, uses explicit dummy credentials, sets one SDK attempt,
and rejects non-loopback HTTP requests in middleware. It creates uniquely named
synthetic LOCAL tables and deletes them in finally. It cannot fall back to managed
DynamoDB or SSO. Reuses the existing in-memory DynamoDB Local 3.3.1 loopback
launcher; no permanent installation is required.

Run after `tsc`: `node scripts/test-media-local.mjs`. Unit tests run in the normal
backend suite and inject timeouts before/after writes, throttling, missing
cancellation reasons, readiness/Product cancellations, damaged records and guard
read delays. Local transaction groups cover real conditional writes, competing
manifest/lease updates, rollback, receipt replay, compaction, ownership, readiness,
retention and existing catalog filtering. Synthetic verification descriptors are
used; no S3 or real image publication occurs.

DynamoDB Local does not reproduce all managed transaction contention, throttling,
network partitions, SDK retries or distributed clock skew. Fencing depends on
monotonic revisions and the repository being the authorized writer. Wall-clock
lease checks use the worker clock at submission; DynamoDB provides no server-time
condition. Network-delayed requests remain fenced against any subsequent winning
revision. Future workers need synchronized clocks and bounded request timeouts.
Future business records referencing media must join the reference/fencing contract
before cleanup is authorized; manifests attach assets but do not alone establish
customer visibility.

## Next assignment

Connect the six protected administrative routes and same-origin SSR relays to this
adapter with authentication, bounded request bodies and sanitized status mapping.
Keep trusted processor completion private. Then implement separately authorized
mocked storage/dispatch orchestration and Linux native validation. No handler,
S3 upload, IAM change, public image delivery, cleanup execution or deployment is
part of this milestone.

Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Recorded local results

Fresh validation: 1,001 backend tests and 10 backend artifact checks passed;
21 DynamoDB Local transaction integration groups passed; all 10 existing Sharp
regressions passed. Backend and processor type checks/builds, web lint,
repository formatting and git diff whitespace checks passed. The processor build
was macOS ARM64 only, not Linux Lambda validation. Frontend's 475 passing tests
remain historical; no frontend source changed or frontend test suite reran here.
No managed AWS calls, live writes, commit, push or deployment occurred.

## Approved completion lease contract

The lease deadline is a takeover boundary, not an AWS commit-time cutoff.
Completion must be eligible immediately before transaction submission: the worker
clock must be strictly before both leaseUntil and intent expiresAt, with the
correct PROCESSING attempt. Equality is expired and is rejected before submission.
An already submitted eligible transaction may commit after the deadline only if
its persisted revision, PROCESSING state and attempt token still match. Takeover,
FAILED or EXPIRED transitions advance the durable revision and fence older writes.
Lease expiry alone does not retroactively cancel an in-flight transaction.
Duplicate completion reconciles the authoritative original receipt; it does not
create a second asset. Intent expiration is a separate durable terminal transition.

READY means verified, private and unattached, not customer publication. Publication
requires a valid manifest attachment and existing Product visibility controls;
public media delivery remains unimplemented. Attachment alone grants no public URL.
Worker clocks must be synchronized and request timeouts bounded. Clock skew and
managed-service delivery timing are not modeled by DynamoDB Local. No strict
server-side wall-clock commit deadline is claimed.

## Lease-contract correction validation

Completion now conditions its existing intent Put on revision, PROCESSING state
and attempt token; there is still only one transaction action for that intent.
Overlapping identical completions reconcile the original winning receipt even
when completion timestamps differ. Browser result claims remain untrusted.

Fresh validation: 1,036 backend tests, 10 artifact checks and 32 DynamoDB Local
integration groups passed. The seven new groups cover A–F, with both FAILED and
EXPIRED terminalization for D. The delayed-write harness pauses submission before
forwarding the actual transaction to loopback DynamoDB Local. It tests conditional
write behavior, not managed AWS timing or clock synchronization. Case F confirms
READY creates no manifest; it is not a hosted customer-delivery acceptance test.
Backend type checking/build, web type checking/lint/build, formatting and whitespace
checks passed. Frontend 488, processor 10 and infrastructure 37 test passes remain
historical; those suites were not rerun. No managed AWS writes, commit, push or
deployment occurred. The source-control review may resume, not bypass its remaining
gates. Hosted duplicate-activation acceptance remains **NOT PASSED**.

## 1B-2G READY discovery

The existing protected GET `/admin/products/{productId}/media` accepts
`view=ready` and an optional `after=<productId>.<mediaId>` cursor. One strongly
consistent Query evaluates at most 12 `ASSET#` records in the Product's existing
`PRODUCT_MEDIA#<productId>` partition. No scan, index, table or discovery write is
introduced. A cursor is validated against the requested Product. Empty filtered
pages can still return a continuation cursor; pagination is not a snapshot.

Only valid READY assets absent from the current manifest are returned. ATTACHED,
RETIRED, DELETING and DELETED assets are excluded. FAILED/EXPIRED upload operations
do not produce eligible assets; discovery reads durable assets, not expiring upload
receipts. Receipt compaction does not establish asset expiry. Responses contain
only the existing sanitized asset DTO and cursor, never keys, leases or credentials.

Existing catalog administrators can read Product media and edit its manifest;
discovery retains that Product-scoped boundary. Upload status and idempotent receipt
lookup remain restricted to their originating administrator. No new ownership
policy, permission or authorization bypass is introduced. The existing session
relay preserves encrypted HttpOnly cookies, no-store responses and same-origin
write protection. A candidate can become stale after discovery; the authoritative
revision-checked Save remains the arbiter, including concurrent cleanup.

Fresh local validation: 35 DynamoDB Local groups passed, including bounded
pagination, discovery before/after seven days, post-grace attachment, excluded
states and both delayed-transaction attachment/cleanup race orders. These use
real local conditional transactions, not only preflight-read mocks. This does not
establish complete managed-DynamoDB concurrency coverage or authorize cleanup.
