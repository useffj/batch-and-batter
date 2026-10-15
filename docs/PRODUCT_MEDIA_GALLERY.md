# 1B-2F — Persistent administrator gallery

Local implementation on `codex/admin-media-gallery-1b2f`, based on verified main
`3a3711cf66eba4c910653dbddb62b057ff15bdc9`. All three PR #61 post-merge CI checks
passed before implementation. The implementation/recovery reviews were local-only;
the subsequent source-control checkpoint does not authorize deployment or live uploads.

## Administrator experience

The existing Product editor renders ProductGallery for saved Products. It loads
GET media manifests through the protected same-origin relay, preserves media IDs,
server order and saved alt text, and edits a separate draft. The first image is
primary. A compact tile selector drives one selected-image panel with alt text,
primary/reorder, replace and remove controls. There are no fabricated S3 URLs:
private binary preview delivery is absent, so tiles say Preview unavailable.

Save submits the original manifest revision and at most six unique IDs with
nonblank alt text (maximum 160 characters). Cancel restores the last confirmed
manifest. Product and gallery saves remain separate. Product navigation/close and
page-exit guards include gallery edits and selected upload workflows. Leaving the editor drops access to the selected File but preserves an unfinished
operation's minimal tab-scoped recovery record. No credentials or signed forms
are persisted.

A conflict retains the draft and blocks further saves until an explicit,
confirmed reload. An uncertain save first reads the authoritative manifest: an
advanced revision with the requested content confirms success; an unchanged
revision/content permits an explicit retry; any different result blocks editing.
If reconciliation is unavailable, retry remains blocked. An in-flight older write
is still subject to the server's revision condition. No automatic overwrite,
merge or blind retry is attempted.

## Upload boundary

The upload model implements selected, authorizing, uploading, processing requested,
processing, ready, failed, expired and unavailable states. File validation checks
8 MiB, JPEG/PNG/WebP signatures, browser decoding, both axes at least 480 and at
most 8000, and 20 million pixels, then hashes bytes with SHA-256. The server remains
the security authority for validation, readiness and bounded processing.

Each explicit file selection allocates one UUID. Duplicate clicks are guarded;
manual retries retain the UUID, known upload ID and original file. Unknown intent
responses retry the same identity. Known uploads are checked before resuming.
Status checks are explicit and bounded; there is no indefinite polling loop.
Terminal failures/expiry require an explicit new file workflow.

Production has NO binary-transfer implementation. Even if authorization becomes
available, it displays an unavailable state and sends no file to S3. Authorization
exists only transiently in memory and is never logged, rendered or stored. The
isolated local preview alone injects a no-network transfer simulation. Completion
requests send empty JSON, never image verification claims. READY offers an explicit
add-to-draft action; replacement preserves the old attachment until manifest Save.
Alt text must be supplied for the new image. Public delivery remains absent.

## Synthetic acceptance

Run `node scripts/preview-admin-products.mjs` from web. The loopback-only preview
uses the actual frontend media client and components with `scripts/media-fixture.ts`.
It rejects non-mocked fetches; no AWS client or valid credentials are present.
Synthetic manifests and synthetic server-side upload receipts persist in this
preview tab under `bb-synthetic-media-manifests` and `bb-synthetic-media-uploads`.
The receipts contain identifiers, declared content hash/type/size, state and
original deadlines, never forms, credentials or binary data. These are isolated
fixture records, not a production browser cache of backend records.
Controls simulate conflicting writers, lost save acknowledgements, unavailable
uploads, synthetic processing and unauthorized responses. The fixture is never
imported by production routes or components. Synthetic image IDs are valid ULIDs;
an initial fixture-length error was corrected before final validation.

Fresh recovery review: 199 relevant frontend administrator tests passed across six
files, including 38 gallery/client/recovery cases. Fresh backend: 58 relevant media
contract/API/persistence/storage tests passed. The previous full frontend run of
507 is historical; unrelated checkout/storefront suites were not rerun.
Frontend type checking, lint, production build, formatting and whitespace checks
passed. Existing relay tests cover administrator authorization, same-origin writes,
no-store, server-only tokens and rejected browser result claims. No backend source
changed. Full backend 1036, DynamoDB Local 32, processor 10 and infrastructure 37
remain historical; those unrelated full suites were not rerun.

Browser checks used only a synthetic 640x480 color raster: saved manifest loading,
primary/order saving, reload persistence, alt editing, conflict with retained draft,
explicit conflict reload, lost-response reconciliation, upload unavailable,
processing/status/READY, explicit attachment and Product detail saving. Removal
persistence/cancel, duplicate submissions, terminal errors and response validation
also have focused automated coverage. At 375px the document width was 375px with
no horizontal overflow; native Tab reached enabled gallery controls with visible
focus. This is a targeted accessibility check, not a comprehensive audit. Screenshot:
`/tmp/bb-gallery-mobile.png` (local evidence, not a deployable asset).

## Reload recovery and focused boundary review

Version 1 recovery records use `bb-gallery-upload:<productId>` in sessionStorage.
The context marker combines the existing server-derived administrator catalog
scope and authenticated session expiry. Neither value is an authentication token.
New or incompatible context invalidates prior records. Product sign-out clears
records immediately; sign-out elsewhere invalidates access through the existing
server session and a subsequent login changes the recovery context. Backend
subject/Product checks remain authoritative, including for browser-tampered IDs.
The local main branch is stale and was left untouched; HEAD and origin/main both
matched the expected baseline above at the start of checkpoint review.

Each record is limited to 1,024 characters, version, original UUID, optional known
upload ID, and original MIME/byte-count/SHA-256 declaration. At most 32 Product
records are admitted. No filename, File, binary, cookie, auth token, presigned form,
object key or AWS credential is stored. The record is written before an intent
request. Unavailable storage or invalid records block uploads rather than silently
losing operation identity. Storage failure after a reply prevents binary transfer.

Known-ID reload makes one protected GET status request, with no automatic write.
Manual checks may request processing for an already QUEUED operation. An unknown-ID
ambiguous intent requires original-file reselection and reuses the exact original
UUID and declaration. The approved API binds this identity to administrator and
Product and rejects differing content. If it cannot reconcile, the operation stays
unresolved; no replacement UUID is generated. Expiry remains server-authoritative;
recovery does not extend authorization or processing deadlines. There is no retry
loop. Explicitly abandoning a local workflow does not delete its server intent.

File reselection validates MIME, size and SHA-256 before permitting a retry. READY,
FAILED, expiry and authentication failures clear the record; authentication failure
also blocks the in-memory workflow. READY does not attach or publish. A READY image
not added and saved before another reload is not rediscovered by this minimal
recovery feature. This is a required correction before live DEV upload activation:
an administrator must be able to recover and explicitly attach the original READY
asset after reload without creating a duplicate upload. The mechanism needs a
targeted follow-up; no implementation expansion is authorized in this checkpoint.
This slice does not provide complete end-to-end upload recovery.
Recovery does not persist unsaved manifest edits or a replacement target.

Focused review confirmed authoritative manifest loading, stable IDs/order/primary,
160-character nonblank alt text, six-image limit, explicit removal/save, revision
conditions, cancel and ambiguous-save reconciliation. No additional backend or
business-contract change was needed. Existing encrypted HttpOnly sessions,
administrator authorization, same-origin writes, no-store relays and private
processing boundaries remain intact. Production has no transfer adapter. Approved
presigned forms, if ever returned by the service, are transient capabilities only;
they are neither persisted nor used for production transfer in this implementation.

Fresh browser checks covered unavailable-intent recovery after full reload,
original-file reselection, processing recovery after another full reload and READY
without attachment. At 375px both viewport and document measured 375px. Native Tab
reached Add ready image to draft with a visible focus outline. Evidence:
`/tmp/bb-gallery-recovery-mobile.png`. The automated cases additionally cover lost
intent acknowledgements, mismatched files, duplicate clicks, expired/failed uploads,
storage/processor outages, corrupt records, sign-out/context invalidation,
authorization failures and secret-free bounded storage.

## Remaining gates

Real storage transfer, deployment configuration, deployable processor handler,
Linux native/resource validation, reviewed runtime assembly/IAM/CORS/retention,
catalog migration/readiness, controlled real-upload acceptance and customer-facing
image delivery remain separately gated. The synthetic preview's 250-character
legacy media panel is retained as historical code; the persistent gallery uses 160. Existing Product/Drop/inventory/order/payment contracts are unchanged.
No live Product writes, readiness activation, IAM/SSM changes, payment operations
or original testing-workspace modifications occurred.

Next: review the draft checkpoint PR and its CI results before any separately
authorized merge. No live release is implied.
Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Source-control checkpoint validation

Fresh checkpoint validation: full frontend suite **526 passed** (16 files),
relevant backend media suite **58 passed**, frontend type checking, lint and
production build passed. Formatting and git diff whitespace checks passed.
The prior 507 full-frontend and 199 targeted administrator results are historical
relative to this checkpoint. No implementation behavior changed during checkpoint
review; the READY recovery release gate above was made explicit.

MERGING DOES NOT AUTHORIZE DEPLOYMENT.

REAL IMAGE UPLOADS REMAIN DISABLED.
