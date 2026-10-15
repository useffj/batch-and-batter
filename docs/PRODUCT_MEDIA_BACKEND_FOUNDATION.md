# 1B-2B — Local media contracts and processor core

This is a deliberately incomplete, tested implementation boundary under the
owner's instruction to stop at a coherent boundary when the complete slice is
too large. It is not a persistent media backend, deployed processor, or release
approval. No new routes are active. No managed AWS calls are needed by this code.

The owner's latest implementation authorization supersedes the older numerical
proposals in PRODUCT_MEDIA_FOUNDATION.md: minimum input is 480 pixels on BOTH
axes, alternative text is required and at most 160 characters, and image
processing belongs in a separate package. The existing eight-file UI foundation
is preserved unchanged by this slice.

## Implemented boundary

`backend/src/media-contract.ts` provides strict request validation, companion key
constructors, administrator/Product-scoped version-1 upload identities, original
intent replay, manifest planning, processing leases, expiry, deletion fencing and
receipt compaction. These are pure functions, not DynamoDB adapters.

Keys are `PRODUCT_MEDIA#<productId> / MANIFEST`, the same partition with
`ASSET#<mediaId>`, and `PRODUCT_MEDIA_UPLOAD#<uploadId> / STATE`. They cannot match
the existing `PRODUCT#... / META` listing filter. IDs are validated; no arbitrary
object destinations are accepted. Upload identity hashes a canonical tuple of
version, administrator subject, Product ID and normalized UUID request key. The
request hash covers MIME, bytes and SHA-256. Retries retain original media IDs and
deadlines. Replacement requires a new media ID.

Manifest planning enforces readiness/existence inputs, optimistic revision, six
unique images, ordered primary-first semantics and Product ownership. Newly
attached assets must be READY; previous entries must be ATTACHED. Removal plans
retirement, never object deletion. Reordering does not change asset state.

Processing claims have a 60-second lease, unique UUID attempt token and maximum
three attempts within the 15-minute intent deadline. Completion rejects leases ineligible at submission; durable fencing rejects
superseded attempts (see the approved completion lease contract below). A recovered attempt uses different immutable output keys. Successful
completion is replayable, including after the original upload deadline.

**These rules are not concurrency guarantees until persistence is implemented.**
The next slice must atomically compare original revision/state/lease and commit
the planned changes. Product existence, applicable Product revision, and the
existing catalog readiness marker must be checked in the same transaction, not
merely read beforehand. Concurrent claim tests here exercise state transitions,
not managed DynamoDB or DynamoDB Local concurrency.

## Isolated processing package

`media-processor` pins Sharp 0.35.5 in its own lockfile. It neither imports nor
changes the accepted backend Lambda build. `processImage` consumes one bounded
Buffer plus exact declared MIME, length and SHA-256, and returns optimized bytes
and derived metadata. It performs no storage, network, logging or publication.

Limits: 8 MiB input, JPEG/PNG/WebP only, static single-page input, both axes at
least 480, each at most 8,000, and at most 20 million pixels. Container checks
reject PNG/WebP animation even if a decoder would expose only a default frame.
Sharp's decoded-pixel limit is enabled. Decoder errors are sanitized.

Decode once, orient, convert to sRGB, then encode sequentially into WebP quality
80 and JPEG quality 82. Fit inside 480/960/1600 square bounds without upscaling,
deduplicate dimensions, cap each variant at 1 MiB and all output at 6 MiB. Raw
intermediate pixels prevent source EXIF/ICC metadata from being copied. WebP
retains alpha; JPEG flattens against existing media-panel cream `#f4efe6`.
Sharp concurrency is one and its cache is disabled. The storage adapter must
bound the incoming stream BEFORE creating this Buffer.

`npm run build` creates a separate production-only `out` library artifact, loads
its actual native Sharp dependency and runs an encode smoke check. BUILD.json
records the actual host platform. This is not a deployable Lambda: the durable
worker adapter and handler are intentionally absent. Run the same clean build and
full tests on Linux x64 before claiming Lambda platform validation. macOS success
does not establish Linux compatibility or 1024 MiB/30-second resource sufficiency.

## Retention contracts

READY and RETIRED assets become deletion-eligible after seven days, only when
unreferenced. ATTACHED assets never qualify. Conditional DELETING fencing must
be persisted before any deletion executor can act. Retired/deleting assets cannot
be reattached. No deletion executor or schedule exists.

Terminal receipts can compact after 30 days into duplicate-prevention tombstones.
The persistence adapter must reserve tombstone keys permanently, return an
expired-result response on replay, and never treat a tombstone as an absent
intent. Original-result storage and replay from persistent records remain to be
implemented. One-day staging lifecycle and seven-day incomplete-output cleanup
remain infrastructure/operator contracts, not active mechanisms.

## Required next slice and release gates

1. Implement strict persisted-record schemas, atomic DynamoDB adapters, full
   original-result receipts and tombstone replay, with transactional failure tests.
2. Implement all six protected routes, existing Cognito group checks, sanitized
   responses, readiness enforcement and same-origin SSR integration.
3. Add five-minute exact-key/checksum/length presigned POST preparation, bounded
   storage reads and immutable conditional writes behind mockable adapters.
4. Add durable worker orchestration: dispatch-gap recovery, lease fencing,
   transactional asset/receipt completion and abandoned-output accounting.
5. Validate Linux x64 native packaging, dependency audit, resource ceilings and
   existing artifact isolation; then connect the preserved frontend locally.

Public delivery remains unimplemented. It must check existing storefront
visibility, allow only attached variants, keep originals private, use no-store
for authenticated previews/metadata/errors, and cap public caching at five
minutes. Approve urgent-image removal procedures before public release.

No IAM, S3 CORS/lifecycle, compute-role, API Gateway, Lambda or CDN changes are
included. All future infrastructure changes, live uploads, cleanup execution and
deployment require their separate authorization. Catalog readiness activation and
existing Product migration gates remain untouched. Product schema, slug ownership,
creation idempotency, inventory, Drops, orders and payments are unchanged.

Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Local validation of this boundary

Backend type checking, production bundle build, 992 tests and 10 artifact checks
passed. Processor checked JavaScript types, all 10 synthetic image regressions,
and its isolated production-library build/native smoke check passed on
darwin/arm64 with Node 24.19.0. Processor production dependency audit reported
zero vulnerabilities. Web lint, repository formatting and git diff whitespace
checks passed. No frontend source changed in this slice; its previous 475 tests
are historical evidence, not a fresh run. Linux execution, durable concurrency,
AWS integration and hosted acceptance were not performed.

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
