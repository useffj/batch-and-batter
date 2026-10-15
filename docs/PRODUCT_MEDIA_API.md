# 1B-2D — Protected media API integration

Local implementation only on `codex/admin-product-media-1b2a`, baseline
`193e7a7146718eb87de8434ee5ecca244efe5fba`. Prior UI, processing and persistence
work is preserved. No live writes, AWS configuration, deployment or commit.

## HTTP contract

All paths begin `/admin/products/{productId}/media`. They require the existing
Gateway Cognito JWT authorizer and backend access-token administrator-group checks.
The corresponding Next paths begin `/api/admin/products/{productId}/media`.

| Method and suffix                   | Request                                                       | Successful response                                     |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| GET (base)                          | No body/query                                                 | `{manifest: {version: 1, productId, revision, images}}` |
| PUT (base)                          | `{expectedRevision, images: [{mediaId, alt}]}`                | `{manifest}`                                            |
| POST `/uploads`                     | `{contentType, bytes, sha256}`; UUID `Idempotency-Key` header | Existing READY receipt replay only: `{upload}`          |
| GET `/uploads/{uploadId}`           | No body/query                                                 | `{upload}`                                              |
| POST `/uploads/{uploadId}/complete` | Empty JSON object                                             | Existing READY receipt replay only: `{upload}`          |
| GET `/assets/{mediaId}`             | No body/query                                                 | `{asset}`                                               |

Absent manifest returns revision zero and an empty array without writing. Missing
Product, asset or upload returns 404. Product IDs/media IDs are validated ULIDs;
upload IDs are lowercase SHA-256 hex. Unknown fields and queries are rejected.
Writes accept JSON metadata only, maximum 16 KiB; relays bound responses too.

The asset DTO contains Product/media IDs, revision, state, dimensions and variants
(size, format, dimensions, byte count). It omits object keys, processing attempts,
checksums and internal table keys. Upload DTOs contain Product/upload/media IDs,
state, millisecond expiry and the original asset result when READY. They omit
administrator subjects, request hashes and leases.

## Fail-closed service boundary

No storage signer, upload capability, S3 client, dispatch service or processor
invocation is installed. New uploads and pending-intent replay return 503
MEDIA_UPLOAD_UNAVAILABLE. Completion requests for unfinished uploads return 503
MEDIA_PROCESSOR_UNAVAILABLE. Neither operation creates intents, queues work,
acquires leases, registers assets or claims success. Completed receipts can be
recovered without new mutations. Conflicting upload request hashes return 409;
expired requests/tombstones return 410; terminal failed completion returns 422.

The HTTP dependency interface exposes only manifest, asset, upload reads and
manifest replacement. Private processor claim/finalize methods are absent from
that interface. No HTTP endpoint accepts verified processing results. No
production fallback to synthetic services exists.

Manifest PUT delegates to the atomic persistence adapter, preserving readiness,
Product/slug ownership checks, revisions, six-image limits, primary ordering,
alt text and retirement. Read-only routes never activate readiness or write data.
Media reads/updates surface sanitized service errors, never successful empty
responses for database failures.

## SSR and infrastructure

Next relays reuse the runtime SSM-backed session-key loader, encrypted HttpOnly
session and server-side administrator validation. Writes require the configured
Origin and same-origin Fetch Metadata when supplied. Access tokens are forwarded
only in server-side Authorization headers. Responses use the existing no-store
security headers; backend messages are replaced with safe text. Strict response
projection rejects unexpected private fields or cross-Product responses.

CDK adds exactly six JWT routes with existing Lambda integrations and scoped
invocation permissions. No execution-role permissions, bucket/CORS settings,
tables, runtime settings or payment resources are added or changed. Existing
infrastructure tests now assert the expanded exact route set and authorization.
The existing five-entrypoint packaging is retained. A synthesized full-stack
artifact is validation output, not authorization for a deployment that could
replace accepted mixed Lambda artifacts.

## Remaining work

Next: implement a mock-tested storage authorization and dispatch adapter, with
bounded reads, exact upload policies, immutable output writes and durable worker
recovery. Only then enable new intent reservation/processing requests. Preserve
these paths and DTOs; add upload authorization only when backed by the real secure
service. This API slice does not expose the media panel in the deployed frontend.

Linux native validation, resource measurements, separately authorized IAM and
infrastructure changes, public delivery/removal policy and live acceptance remain
outstanding. No catalog readiness activation or cleanup execution is authorized.

Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Local validation

Fresh results: 1,025 backend tests, 10 backend artifact checks, 487 frontend tests
and 37 infrastructure tests passed. Backend/frontend/infrastructure type checks,
backend and Next production builds, web lint, formatting, whitespace checks and
offline CDK synthesis with lookups disabled passed. The 21 DynamoDB Local groups
and 10 processor regressions remain historical evidence from the unchanged
persistence/processor slice; they were not rerun in this API assignment.
