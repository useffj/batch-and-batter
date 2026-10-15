# 1B-2E — Secure storage and dispatch integration

Local implementation only. Existing media UI, persistence, APIs and Sharp core
remain intact. The deployed entrypoint still supplies no media orchestration
service: configuration environment variables alone cannot enable uploads. No
resources, credentials, permissions, uploads, Lambda invocations or live records
were changed. Tests use dummy credentials or isolated local adapters.

## Upload authorization

`S3MediaStorage` uses AWS SDK v3 3.1137.0 and `createPresignedPost`. The explicit
configuration requires enabled=true, DEV region/account, the existing media bucket
and the specific proposed media processor ARN. Callers cannot choose destinations.
The signer requires temporary role credentials with a session token and expiry.
No permanent secret key is returned. Credentials are resolved before intent
reservation; missing credentials/configuration never creates an intent.

The signed policy fixes bucket, exact staging key, Content-Type, SHA256 algorithm,
base64 SHA-256 digest, AES256 encryption and 204 success response. Its
content-length-range has equal minimum and maximum matching declared bytes, at
most 8 MiB. SDK-generated fields and key are signed exact-match conditions. No
ACL, redirect, filename substitution or arbitrary object prefix is accepted.

AWS documents the [POST checksum fields](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTObjectPOST.html)
and [POST size/policy conditions](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-HTTPPOSTConstructPolicy.html).
Tests decode the actual SDK-produced policy, using unusable LOCALONLY credentials,
and verify constraints without network requests. This is not a managed S3 upload
acceptance test. MIME/signature, actual bytes, digest, dimensions, animation and
pixel limits are independently checked by the trusted processor before READY.

Authorization expires no later than the ORIGINAL five-minute intent deadline or
credential expiry. SDK policy expiration is inspected after signing; an overlong
or already expired result is rejected. Retry may generate a different signature
within the original window, never extend it. After that window return
UPLOAD_AUTHORIZATION_EXPIRED; a new identity is an explicit operator/UI action,
not an automatic retry. Completion retains its fifteen-minute deadline.

After reservation, a signing failure can leave a durable PENDING intent. The API
returns an error, not usable authorization or fabricated success. Retry the same
identity to reconcile; do not allocate a replacement automatically. A lost response
or conflicting concurrent creation uses the existing receipt/idempotency rules.
Readiness is checked transactionally again before signing an existing intent.

The upload response adds `authorization: {url, fields, expiresAt}` to `{upload}`.
SSR validates the fixed destination, Product/upload-scoped key, short expiry,
allowed fields, signed field conditions and exact bounded size range. It returns
this bearer capability only to the authenticated administrator with no-store.
Never log the authorization, signed policy or security-token form field.

## Dispatch and trusted processing

`reserveDispatch` adds optional dispatchAfter/dispatchToken to the version-1 intent.
Existing records without those fields remain valid. A transaction reserves a
30-second redispatch window with a unique UUID and revision condition. Two
concurrent callers cannot reconcile each other's reservation as their own.
Failures before invocation and ambiguous invocation acknowledgements retain the
reservation. A later request can redispatch after the window, within the original
fifteen-minute deadline. Active processing leases suppress redispatch; expired
leases may recover. Processing still allows at most three attempts.

`LambdaMediaDispatch` invokes only the configured function ARN with InvocationType
Event and an identity-only envelope (version, Product ID, upload ID, administrator
subject). Only HTTP 202 acknowledges queue acceptance; it is never READY evidence.
AWS can deliver duplicates or discard aged events: see
[async invocation](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html)
and [retry behavior](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html).
The durable reservation and processor leases remain authoritative.

`processMedia` is a dependency-injected worker contract, NOT a deployed Lambda
handler. Local integration supplies the unchanged isolated Sharp processImage.
The worker obtains the intent/lease, derives its staging reference from persisted
identity, reads one bounded source buffer, verifies/processes it and writes each
variant sequentially to an attempt-specific immutable key using If-None-Match *.
Submission-time lease eligibility and atomic revision/state/attempt fencing
protect finalization of the READY asset and original receipt.
No manifest is created or attached by processing, and no public URL is returned.

Invalid images become terminal FAILED. Storage errors, unknown outcomes and partial
output writes remain PROCESSING for lease-expiry recovery. New attempts use new
keys; losing/partial outputs remain private orphans under the existing seven-day
retention contract. Duplicate delivery of a completed operation replays READY
without rewriting objects. Browser routes cannot call claim/complete directly or
supply verification results.

## Future infrastructure requirements — not applied

- API role: s3:PutObject on the existing bucket's `staging/products/*` only,
  plus lambda:InvokeFunction on the approved processor ARN. Existing Catalog
  permissions support the item transactions; no new table/index is needed.
- Bucket: retain Block Public Access, bucket-owner enforcement, TLS and SSE-S3.
  Add CORS only for the approved administrator origin(s), POST method and
  Content-Type header; checksum/signature values are form fields, not additional
  request headers. No wildcard origins, browser credentials or ACL grants.
- Processor: separately packaged Node 24 Linux x64 Sharp artifact, proposed
  1024 MiB, 30-second timeout, 512 MiB temporary storage, concurrency two. Native
  Linux execution and resource measurements remain required before release.
- Processor role: GetObject on staging only; PutObject on approved output prefix
  only; Catalog GetItem/PutItem/ConditionCheckItem for media records and existing
  Product/readiness/slug checks; scoped log-stream/write access. No SSM, Stripe,
  payment tables, DeleteObject, bucket administration or public ACL permissions.
- SDK clients must have bounded connection/request timeouts and maxAttempts=1 for
  invocation/conditional output operations. Recover ambiguous outcomes through
  durable state, not new identities.
- Async invocation: maximum event age 900 seconds, at most two automatic retries.
  Configure logs with bounded operational IDs/state/error codes only. Pending and
  failed operations require monitoring/recovery; no new queue or automatic cleanup
  resource is introduced by this slice.
- Staging lifecycle/retention, urgent removal policy and any customer-delivery
  compute-role access remain separate approved configuration steps.

There is no environment-driven service factory or deployable processor handler
in this slice. A reviewed runtime assembly must explicitly construct the SDK
clients/adapters and inject the service after these prerequisites are approved.
Missing services retain MEDIA_UPLOAD_UNAVAILABLE/MEDIA_PROCESSOR_UNAVAILABLE.

## Packaging and checkpoint

The API's five-entrypoint JavaScript packaging remains intact. Native Sharp is
never imported into API/payment bundles. SDK additions are pinned; overrides pin
new S3-specific dependencies to compatible versions so every pre-existing lockfile
entry remains byte-for-byte unchanged. No payment dependency upgrade is included.
Local production builds are not approval to replace accepted mixed Lambda assets.

Recommend one reviewed draft PR for the complete foundation, organized into small
coherent commits: UI, contracts/processor, atomic persistence, protected APIs, then
storage/orchestration. Review the aggregate diff before checkpoint authorization.
No commit or push was performed here.

Next assignment: focused security/concurrency review of the complete media
foundation and Linux processor packaging/measurement plan. Keep runtime assembly,
permissions, provisioning, uploads and hosted acceptance separately gated.

Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Recorded validation

Fresh: 1,036 backend tests, 10 artifact checks, 25 DynamoDB Local groups (including
actual Sharp with local storage), 488 frontend tests and 10 processor regressions
passed. Backend/frontend/processor type checking, production builds, web lint,
formatting and whitespace checks passed. Backend production audit: zero findings.
The processor native build was macOS ARM64, not Linux Lambda validation. The prior
37 infrastructure tests remain historical; infrastructure was unchanged this turn.
All pre-existing backend lockfile package entries are unchanged. Synthetic local
tables were deleted and the loopback database was stopped after validation.

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
