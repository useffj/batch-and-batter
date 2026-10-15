# 1B-2A — Cookie media foundation

October 14, 2026. Local development only. Baseline main
`193e7a7146718eb87de8434ee5ecca244efe5fba`; PR #60 merged and all three post-merge
CI jobs passed. Branch `codex/admin-product-media-1b2a`.

## Architecture findings

Approved [PRD section 7](PRD.md) requires images and optional video. The
[technical specification section 53](TECHNICAL_SPEC.md) places media bytes in S3,
not DynamoDB, and requires optimized delivery rather than huge originals.
`backend/src/domain.ts` defines a strict Product with no media field. Price and
inventory remain attached to Drops. No approved persistent Product-to-image
association, upload/finalization API, media processing pipeline or delivery
contract exists in current code. Do not treat the UI model below as an approved
DynamoDB schema.

`infra/lib/development-stack.ts` already defines ProductMediaBucket with public
access blocked, S3-managed encryption, SSL enforced and bucket-owner-enforced
ownership. It does not grant application media access or configure browser upload
CORS. Its current removal policy is DESTROY without auto-delete; revisit retention
before putting real images there. No bucket inspection or modification occurred.
Next's existing dependencies include Sharp 0.35.5; this is not a backend processing
contract or permission to introduce a new Lambda binary. Cognito administrator
authorization, encrypted HttpOnly sessions and same-origin write enforcement are
unchanged and must protect any future media API.

## Local UI and boundaries

Run from `web`: `node scripts/preview-admin-products.mjs`, then open
`http://127.0.0.1:4175/`. Stop an existing copy on that port first. Open View / Edit
for a synthetic cookie; the image panel follows its details. Newly created
synthetic cookies can also use the panel once they have an ID.

Use synthetic raster files only. Choose multiple images, edit alternative text,
make one primary, move earlier/later, replace and remove. The first ordered item is
always primary; removing it promotes the next. Replacement retains position and
alternative text, which the operator must recheck for the new image. Empty alt
text is visibly flagged for future publication; there is no publish action.

Prototype bounds: six images per cookie, JPEG/PNG/WebP, 8 MiB each, maximum 8,000
pixels per side and 20 megapixels. These are proposed product limits, not approved
server security guarantees. MIME, signature, decode and dimensions are checked;
SVG/GIF/other formats, empty files, invalid contents and oversized files fail with
clear messages. Browser decode checks dimensions after decoding and are not a
hardened image-bomb defense. Server-side bounded processing is mandatory before
real uploads. Animated sources have no approved persistence contract; this preview
is not approval for animation or video.

All media is synthetic, in memory, scoped by stable Product ID. No binaries or
media metadata are written to localStorage/sessionStorage. URL.createObjectURL
references are revoked on replacement, removal, rejected batch/racing operation
and page exit; decoded bitmaps are closed. View navigation retains the store;
reload clears it, including when the Product-only recovery mode is enabled.
Back/forward-cache restoration reloads the preview after URL disposal. The generic
optional render slot in Products does not import media code; only the local Vite
entry supplies it. No Next route, credential bypass, upload fetch or AWS client
was added. The deployed Product page does not expose this panel.

## Minimum persistence proposal — decision required, NOT implemented

1. **Companion records in the existing Catalog table**, leaving Product META and
   Product DTO unchanged. Proposed `PRODUCT_MEDIA#<productId> / MANIFEST`:
   schemaVersion 1, productId, optimistic revision, ordered images (maximum six),
   each with mediaId, alt (required nonblank, max 250), verified dimensions, format
   and immutable approved variant keys. First image is primary; no redundant
   primary flag. No bytes or client-supplied URLs. Existing Product list filters
   exclude this prefix. Missing manifest means no images, with conditional initial
   creation. Manifest writes condition-check Product existence and catalog readiness,
   and compare manifest revision; they never rewrite Product META/price/stock.

2. **Upload intents in the same table**, proposed
   `PRODUCT_MEDIA_UPLOAD#<uploadId> / STATE`: authenticated owner subject,
   productId, request identity, exact server-generated staging key, declared format,
   size, checksum, expiry and state (PENDING/PROCESSING/READY/FAILED). Bounded
   processing lease and revision protect concurrent completion. Completed results
   replay for identical requests; mismatched identity/payload conflicts. Proposed
   retained result window seven days, with explicit conditional expiry/retry policy
   rather than assuming DynamoDB TTL is prompt. No table/index or TTL change is
   required initially. This is a new internal record contract requiring approval.

3. **Protected endpoints and same-origin SSR relays**, reusing current Cognito
   administrator checks and CSRF/session protections:
   - `GET /admin/products/{productId}/media` returns manifest/revision.
   - `POST /admin/products/{productId}/media/uploads` validates limits and readiness,
     reserves an intent, and returns a five-minute exact-key presigned POST policy.
   - `POST /admin/products/{productId}/media/uploads/{uploadId}/complete` claims the
     intent, validates/decodes/re-encodes the staged bytes, and returns the immutable
     ready media descriptor. Completion is idempotent; success does not publish.
   - `PUT /admin/products/{productId}/media` atomically updates alt/order/removals
     against the prior revision, referencing only READY media for that Product.
     This manifest operation also performs replacement without an early destructive
     delete. Conflicts leave the prior manifest intact.
     No request accepts arbitrary bucket names/keys or unvalidated remote URLs.
     Upload/finalization is disabled until catalog readiness and media configuration
     are explicitly approved. No protected endpoint is implemented in this slice.

4. **Private staging and processing.** Reuse the existing bucket with separate
   `staging/products/<productId>/<uploadId>/...` and
   `approved/products/<productId>/<mediaId>/<processingVersion>/...` prefixes.
   A presigned policy restricts the exact random key, MIME type, short expiry and
   `content-length-range` 1..8 MiB. It is a bearer capability, not a single-use
   guarantee; never log its URL/form fields. No reusable AWS credentials or secrets
   go to the browser. Policies can be replayed until expiry, so approved keys must
   never be upload targets. Completion reads one bounded byte buffer, verifies its
   expected checksum, and processes those exact bytes; do not validate one GET and
   later copy a mutable staging key. Processing uses a separate immutable output
   attempt key and conditional intent completion. Losing attempts are orphans,
   never published references.

5. **Image processing.** Proposed backend Sharp dependency/build change must be
   reviewed explicitly (the web dependency cannot be assumed to exist in API
   Lambda). Restrict supported signatures and decoders, input byte/pixel limits,
   one frame, dimension bounds, CPU/memory/time budget and concurrency. Reject
   SVG/active content and animation. Strip EXIF/GPS/metadata, auto-orient, convert
   to standard color space and re-encode only bounded JPEG/WebP variants (proposed
   widths 480/960/1600 without upscaling). Check output byte limits. Never publish
   originals. Validate native Linux packaging and audits before deployment. Prefer
   bounded processing in the existing API Lambda only if measured resource/time
   limits pass; otherwise stop for a separately approved worker proposal.

6. **Exact permission/configuration delta for approval.** Existing API role:
   `s3:PutObject` on staging and approved prefixes; `s3:GetObject` on those prefixes
   for validation/reads. No ACL, bucket-admin, wildcard-bucket or browser IAM grant.
   Existing Catalog access is reused for conditional records (verify generated
   policy covers these actions before implementation). Separate cleanup operator:
   prefix-constrained ListBucket plus GetObject/DeleteObject for eligible orphan
   keys, and read Catalog references. No application DeleteObject permission is
   needed for manifest removals. Existing Amplify compute role would need only
   `s3:GetObject` on approved variants if using the delivery proposal below.
   New nonsecret bucket/region and allowed-origin configuration, exact approved
   origin S3 POST CORS, staging lifecycle expiry (proposed one day), and safer bucket
   retention require explicit infrastructure approval. Keep BlockPublicAccess,
   encryption and SSL. No new bucket, index, queue or service proposed initially.

7. **Customer delivery.** Smallest initial proposal: an existing Next application
   route resolves only approved manifest image IDs to known variants and reads
   private approved objects with the narrowly scoped compute role. No arbitrary
   URL/key proxy. Return fixed image MIME, nosniff and bounded output; use existing
   hosting/CDN caching with versioned variant URLs and a documented short cache
   lifetime (proposed five minutes) for withdrawal. Return no staging/original keys
   or upload capabilities in public Product data. Public read projection and route
   are new contracts requiring approval. A dedicated CloudFront/OAC distribution
   is a later scaling decision, not part of this minimum proposal. Confirm actual
   Amplify cache behavior and invalidation/withdrawal requirements before release.

8. **Removal, replacement and orphans.** Remove manifest references first, retain
   replaced objects through the cache/rollback window, then delete only after
   conditional/reference rechecks. Do not allow retired media IDs to be reattached.
   Failed/abandoned staging objects expire via lifecycle after upload permissions
   have expired. Approved orphan cleanup initially uses an explicitly authorized,
   dry-run-first operator tool: inventory intents/manifests, allow a proposed
   seven-day grace period, fence retired intents against later publication, recheck
   references, then delete bounded keys. No automatic live cleanup or migration is
   authorized. Catalog scans here are an operator inventory, not UI pagination or
   a new index. Retention intervals and withdrawal semantics need owner approval.

AWS references: [presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
(can overwrite the same key) and [POST policy conditions](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html)
(expiry and content-length-range). Neither client MIME nor a signed upload proves
safe image content; processing and publication remain separate gates.

## Validation and next step

Fresh frontend: 475 tests passed (462 existing plus 13 media tests). Type checking,
lint and production build passed after correcting a test-only mock typing error.
Tests cover selection/metadata, primary/order, replacement, removal, invalid types,
size/signature/decode/dimension failures, batch rollback, capacity, URL cleanup,
async disposal/races, navigation subscriptions and preview-only wiring. Browser
checks used generated synthetic color swatches (not fake cookie photography):
selection, alt text, keyboard primary selection, reorder, replacement, invalid
content rejection, navigation persistence, reload clearing, removal/promotion and 375px layout.
Native keyboard Tab reached enabled actions; no horizontal overflow at 375px.
These checks are not a comprehensive accessibility audit or hosted acceptance.
Backend/infrastructure code is unchanged; their prior validation was not rerun.

Disposition: **MEDIA PERSISTENCE CONTRACT DECISION REQUIRED**, with the local
synthetic UI foundation validated. Next assignment: approve/refine the companion
record and upload/finalization/delivery contracts, limits, retention and permission
proposal, then separately authorize local persistence implementation. Do not
implement these contracts until approved. Historical Product migration/readiness
remains a separate prerequisite. No commit, push, deployment, S3 upload, AWS
configuration/data change, payment operation or security exception occurred.
Hosted duplicate-activation acceptance remains **NOT PASSED**.

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
