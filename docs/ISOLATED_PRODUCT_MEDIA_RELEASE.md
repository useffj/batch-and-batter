# 1N-M — Isolated DEV product photography

Source-only integration from main `0afe9421e1973ad740a8de1e3ca3fedb0482082b`.
No AWS writes, artifact publication, change sets, hosting release, real photograph
upload or managed business-data mutation is authorized by this milestone.

## Implementation and boundaries

Reuses admin-media, media-contract, media-records, MediaRepository,
MediaOrchestration, S3MediaStorage, the existing Sharp core, GalleryUpload,
GalleryModel and READY discovery. Six existing protected media routes are added
only to the opt-in isolated stack. Existing Cognito access-token/admin checks,
encrypted HttpOnly sessions, same-origin writes, private no-store responses,
revision/lease/idempotency semantics, six-image limit and required alt text remain.

The new `isolated-media-handler` delegates ordinary Product/Drop operations to the
existing isolated router. Its table identity is fixed; browser/event input cannot
select a table. Both API and processor reject shared Catalog configuration. The
processor reuses the same identity-only event and actual Sharp core. No Sharp is
bundled into the API and no payment runtime is bundled into either media artifact.

A dedicated private bucket is proposed because the existing private media bucket
belongs to the shared application stack. The existing bucket and application stack
are untouched. Staging and approved prefixes retain existing key contracts inside
this separate bucket. Presigned POST policies bind the exact Product/upload key,
MIME, SHA-256, byte count, AES256 encryption and at most five minutes. The browser
uses one multipart POST with credentials omitted, redirects rejected and no
referrer. No AWS SDK credentials are installed in the browser; the short-lived
POST form fields are kept only in memory. Uncertain outcomes retain the existing
upload identity and require explicit reconciliation, not automatic retry.

Derivative delivery uses the existing asset route with `view=image`, restricted
to an authenticated administrator and a READY/ATTACHED asset in that Product's
partition. The repository validates immutable keys. Only the 480px WebP variant is
read; exact byte count and SHA-256 are verified, with a 1 MiB bound. SSR rechecks
administrator/session validity and relays bytes through the same origin with
no-store/private, no-referrer, nosniff and same-origin resource policy. There are no
S3 image bearer URLs, public endpoints, original-image reads by the API, image
optimizer caching or public storefront changes.

The isolated signer supports Lambda role session credentials without optional SDK
expiration metadata; a session token is mandatory and POST policies remain at most
five minutes. Known expirations further shorten authorization. S3 enforces actual
session validity independently. Shared-media signing retains its previous stricter
metadata requirement. This corrects a confirmed compatibility gap in the old
adapter; see [Lambda runtime credentials](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html).

The saved-DRAFT page reads saved manifests and verifies ATTACHED primary assets;
it never selects an unattached READY image. Gallery viewing may show READY images
for explicit attachment. Alt text is retained. Missing images retain the branded
placeholder. The preview preserves prices, planned quantities and pickup details;
ordering, reservations, checkout, waitlists and publication remain unavailable.

`ADMIN_MEDIA_MODE=isolated` is an explicit nonsecret frontend gate requiring the
exact existing isolated API and restricted origin. The current hosted configuration
has not been changed, so live transfers remain disabled.

## Exact proposed isolated-stack delta

Offline opt-in synthesis:

```sh
cd infra
npx cdk synth --lookups=false -a 'node dist/infra/bin/isolated-catalog.js' -c isolatedMedia=true -o /tmp/bb-media-synth
```

Default synthesis remains the existing 21-resource Catalog stack. Opt-in has 34
resources: 13 additions and changes to three existing resources. No changes to the
shared application stack, accepted financial Lambda references, API identity,
authorizer, existing eleven routes, hosting or business records are intended.

Add:

- `IsolatedMediaBucket37F67ACB`: S3 bucket
  `batch-and-batter-dev-isolated-media-302154194958-us-east-2`, retained,
  SSE-S3, BucketOwnerEnforced, all four Block Public Access flags.
- `IsolatedMediaBucketPolicy7CD3A817`: TLS-only bucket policy.
- `ProcessorLogs811939FE`: retained log group
  `/aws/lambda/batch-and-batter-dev-isolated-media-processor`, one-month retention.
- `ProcessorRoleFC8890DE` and `ProcessorRoleDefaultPolicy1C43AEFA`: Lambda trust;
  scoped log writes; isolated-table GetItem/ConditionCheckItem restricted to
  Product, slug, readiness and media keys; PutItem restricted to media intent/asset
  partitions; staging-only GetObject and approved-only PutObject with
  `s3:if-none-match=*`. No Product writes, Scan, ListBucket, DeleteObject, SSM,
  Commerce/Operations tables or payment permissions.
- `MediaProcessor`: private Node.js 24 / x86_64, `index.handler`, 1024 MiB,
  30 seconds, 512 MiB temporary storage, reserved concurrency 2. Exact isolated
  table and dedicated bucket environment. No function URL or S3 event trigger.
- `ProcessorRetries`: maximum event age 900 seconds, maximum retries 2.
- `Route11` through `Route16`: existing six media contracts, same JWT authorizer
  and Catalog integration. No public media routes.

Modify:

- `CatalogApi`: new exact-version media-enabled API Code and `MEDIA_ENABLED=isolated`,
  `MEDIA_BUCKET_NAME` equal to the dedicated bucket, `MEDIA_PROCESSOR_ARN` equal to
  the private isolated processor. Preserve table identity and payment false.
- `CatalogRoleDefaultPolicy177B9A56`: staging-only PutObject, approved-only
  GetObject, and InvokeFunction on only the new processor ARN.
- `Catalog.ResourcePolicy`: preserve the exclusive-writer deny and existing
  Catalog role exemption; add only the processor execution role exemption. Its
  identity policy cannot write Product/Drop business records.

Bucket CORS permits POST from only
`https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com`, Content-Type header,
300-second preflight cache. No browser GET permission for staging or derivatives.
There is no lifecycle deletion or cleanup executor in this release.

## Artifact contracts and publication gates

- Existing `--isolated-catalog` output and its historical approved publisher
  contract remain intact. Its hash-pinned tests still pass.
- New API candidate: `node backend/scripts/build-api.mjs --isolated-media`,
  `backend/dist/isolated-media-release/api.zip`, single `handler.js`,
  handler `handler.handler`. Repeated build must produce identical SHA-256.
- Processor candidate: `npm --prefix media-processor run build:linux`,
  `media-processor/out/processor-linux-x64.zip`, handler `index.handler`.
  ZIP timestamps, ordering and permissions are normalized. Pinned dependencies,
  native Linux x64 Sharp, actual AL2023 artifact execution and production audit
  remain mandatory. Never publish the host package.
- Record both exact hashes/byte lengths, source commit, lock hashes and native CI
  evidence before requesting publication. Do not reuse a historical approval.
- Existing publisher permissions are unchanged and do NOT authorize either new
  candidate. The new API path is deliberately not accepted by the old publisher.
  A separately reviewed typed publication approval/adapter is required for the new
  API path and processor ZIP; use exact new operation IDs and hash keys only.
- Proposed processor key grammar is `media-releases/<UUID>/<SHA256>.zip`; existing
  protections for `api-releases/*` do not automatically cover it. Establish exact
  create-only/no-overwrite protection and approved version-specific verification
  before any publication. Do not widen the existing publisher role in place.
- Submit exact S3 VersionIds only after publication verification, preserving opaque
  values and the 1024 UTF-8 byte limit. Reject missing/empty/`null` versions. The
  CloudFormation processor parameter mirrors the existing character constraint;
  the later publication adapter must enforce the byte constraint.

## Validation and focused review

Local evidence: frontend 594 tests; processor 26 tests; infrastructure 154 tests;
37 DynamoDB Local groups including actual Sharp, API authorization/processing,
attachment/reload, saved draft and private derivative retrieval. Backend: 1,134 tests plus 10 legacy and 3 API artifact checks. Type checks, lint, production frontend
build, offline default/opt-in synthesis, formatting and whitespace checks are
required before checkpoint. Production backend/processor/frontend audits and full
infrastructure audit have zero findings. No security exception is granted.

The local end-to-end test uses explicit loopback-only DynamoDB credentials,
in-memory S3 POST acceptance and actual Sharp output. Browser-transfer tests
exercise a mocked fetch boundary with valid and rejected contracts, including
uncertain transfer without retry. Browser visual verification uses the actual
DraftPreview/PrivateImage components and a real Sharp-generated synthetic
solid-color derivative: desktop 1710px and mobile 375px have matching document
widths, loaded images, readable price/quantity/pickup and no horizontal overflow.
This is local component/contract evidence, not real photographic quality, hosted
identity/CORS acceptance, or managed-DynamoDB concurrency equivalence.

Focused review covers table isolation, exact destination/policy validation,
private scoped derivative reads, admin/session enforcement, existing durable
processing/recovery, artifact separation, Product/Drop compatibility and payment
preservation. The historical artifact hash incompatibility was corrected by a
separate media entry point/output, not by changing the historical approval.

## Smallest release sequence — separate authorizations required

1. Review/freeze exact source, both candidate hashes, native CI, 34-resource
   template and exact-key publication plan. Authorize only artifact protection
   and publication preparation first; no stack execution or hosting release.
2. Under a separate bounded authorization, protect/publish/verify both new immutable
   versions. Prepare a review-only isolated-stack UPDATE change set with both exact
   versions. Reject replacements, unrelated diffs or any shared-stack change.
3. Separately approve execution of the isolated stack delta. Verify private storage,
   scoped roles, writer policy, six JWT routes and processor configuration. Do not
   upload or change existing synthetic Product/Drop records during provisioning.
4. Separately approve one restricted frontend build/release with
   `ADMIN_MEDIA_MODE=isolated`. Preserve Basic Authentication, SSR role, session
   secret delivery, locked public paths, disabled automatic builds/previews and
   public main Job 9. Review actual Amplify artifact before promotion.
5. Owner-assisted hosted acceptance: open the existing synthetic Product, upload
   ONE approved real sample photo, process, explicitly attach/select primary/alt,
   save, refresh and verify the authenticated saved-DRAFT preview at desktop/375px.

Stop on identity/hash/version drift, unexpected resource or business-data changes,
missing protection, role overreach, public object access, authentication failure,
uncertain processing/save results or changed financial admission/artifacts. Do not
blindly retry uploads. Roll back by disabling frontend media and restoring the
previous verified restricted frontend/API versions under separate authorization;
retain new private objects/records for reconciliation. Never delete data or revert
the Catalog table wholesale. Restore the prior table writer policy only once no
processor execution is active, with a separately reviewed shutdown sequence.

Public hosting Job 9, restricted hosting Job 2, all five accepted financial
artifacts and PAYMENT_START_ENABLED=false remain unchanged. Existing synthetic
Product/Drop acceptance is preserved. No live media acceptance is claimed.
Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Local candidate identities

- Media API ZIP: SHA-256 `4e962eec3b65f0e9e5fb3a93b436d2e69f552566162b24287e2220925fb4e0b3`, 2822491 bytes.
- Linux processor ZIP: SHA-256 `199c572363986d0ee3b8b58aaa6e752417d764af457ed575656aa4e1101a87ee`, 9246998 bytes.

These are local candidate identities, not published objects or deployment approval.
Native CI independently builds and validates its exact ZIP; freeze the chosen
release bytes and corresponding native evidence before publication.
