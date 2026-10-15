# 1B-2H — Private media processor runtime

Local implementation on `codex/media-processor-runtime-1b2h`, from verified main
`4eb64d940904ce4e72cf544e4ec36a452bd4745a`. PR #63 is merged; post-merge run
38677570794 passed validate, validate-backend and validate-infra. The conditional source-control checkpoint and one private-branch Linux validation
workflow are authorized. No deployment, live image access or business-data mutation
is authorized here.

## Runtime contract

`media-processor/src/handler.ts` exports the Lambda handler. It constructs real
DynamoDB and S3 adapters lazily; it never selects synthetic adapters from an event
or environment switch. Its test factory accepts injected local dependencies, but
is not an HTTP endpoint and is not the configured Lambda handler. Only the existing
identity-only version-1 event is accepted: productId, originating subject and
uploadId. Extra fields, arbitrary destinations, browser HTTP envelopes and supplied
processing results fail validation before repository access.

The handler reuses `processMedia`, `MediaRepository`, `S3MediaStorage` and the
unchanged-behavior Sharp 0.35.5 core. The only core change is a literal-type
annotation. The backend API entrypoint and its five deployment bundles remain
separate; no Sharp dependency is introduced into the API or payment packages.

Nonsecret configuration must be exact:

- AWS_REGION: `us-east-2` (Lambda-managed).
- CATALOG_TABLE_NAME: `batch-and-batter-dev-catalog`.
- MEDIA_BUCKET_NAME: `batch-and-batter-dev-product-media-302154194958-us-east-2`.

No credentials are configured in code. Future deployment uses the execution role.
The existing storage adapter also validates the fixed proposed processor ARN;
this handler does not invoke itself or enable the backend dispatch integration.
Missing/mismatched configuration fails closed. SDK clients use one attempt,
500 ms connection and 3000 ms request timeouts. No custom endpoints are configured.

The repository reads authoritative administrator/Product-scoped upload identity,
claims a unique attempt, and checks readiness/Product/slug ownership transactionally.
A READY receipt replays without processing again. Active competing attempts,
expired deliveries and exhausted attempts retain existing IGNORE semantics.
Malformed events and other unrecovered errors throw a fixed sanitized runtime error;
Lambda invocation acceptance is never evidence of READY. Invalid image content
becomes terminal FAILED. Infrastructure errors leave PROCESSING for lease-expiry
recovery; no blanket success response or blind new identity is produced.

S3 reads only the derived staging key, checking ContentLength and each stream chunk
against the authoritative size and 8 MiB cap. Sharp verifies SHA-256, MIME/signature,
static format, dimensions and pixel limits on those exact bytes. It strips metadata,
auto-orients, and emits sequential JPEG/WebP variants. Output writes use private,
attempt-specific approved keys with checksum, SSE-S3 and If-None-Match `*`.
Collisions/partial writes cannot finalize incomplete output. Originals are not
published; no manifest or gallery attachment is written by processing.

Completion reuses existing revision + PROCESSING + attempt-token conditions.
Submission-time lease eligibility and duplicate completion reconciliation are
unchanged. Stale/superseded workers cannot finalize; an eligible submitted write
may commit later only while the durable attempt remains current. Partial outputs
remain private orphans for separately authorized retention/cleanup. Seven days
is cleanup eligibility, not READY attachment expiry. No cleanup executor exists.

## Packaging and execution evidence

Install the pinned backend and processor dependencies before building, because the
processor bundles the approved backend modules from source. Both lockfiles belong
to the artifact dependency boundary and require production audits. Run from
`media-processor`: `npm test`, `npm run typecheck`, `npm run build:linux`, and
`npm run measure`. The optional local integration runs from backend after `tsc`:
`node scripts/test-media-local.mjs --processor-runtime`.

The build bundles SDK/Zod/runtime JavaScript into `index.cjs`, leaving only Sharp
external. It derives the Sharp runtime dependency lock from the pinned lockfile,
retaining registry integrities, then performs a production-only install with scripts
disabled. It rejects payment/Stripe/worker inputs in the bundle graph. Runtime
folders contain index.cjs, package metadata/lock and Sharp's production node_modules.
`out/host` is host validation only; `out/linux` is the Linux packaging candidate.
ZIP contents start at index.cjs, never an enclosing out directory. Test-support and
build evidence stay outside both runtime folders and ZIPs. Generated files are
ignored and must never be committed.

**Native Linux x64 execution PASSED** in
[workflow run 38682038692](https://github.com/useffj/batch-and-batter/actions/runs/38682038692),
against commit `0cdd8b6212ecee64e53f298d25d22c6bdddd4a2f`.
The Ubuntu 24.04 runner executed the actual deployment ZIP inside the official
Lambda Node.js image pinned to
`public.ecr.aws/lambda/nodejs@sha256:9a096eb2cb6fa96419b5742e1b4a64b6bf7d3aa954beb92461a2a3e072061497`.
The runtime was Node.js 24.21.0, Amazon Linux 2023.12, Linux x64 and glibc 2.34.
Sharp 0.35.5 selected native libvips 8.18.7 (package 1.3.4), with `isWasm=false`.

The native addon and packaged libvips both loaded and had executable mappings.
Canonical-path and inode comparisons against `/proc/self/maps` confirmed the
mapped files belonged to the extracted artifact. Earlier failures were resolved:
extraction moved off the noexec temporary filesystem, and canonical comparison
replaced a literal comparison of equivalent libvips paths containing `../..`.
The negative control proved that functional WASM processing cannot satisfy native
acceptance. No dependency or processor business-logic changes were needed.

The workflow extracted the unchanged ZIP inside the container and verified every
file's SHA-256 before and after tests. It did not import a development installation
or source tree. The packaged handler export and fail-closed behavior passed;
the packaged processor factory executed with synthetic storage/persistence adapters.
JPEG, PNG and WebP inputs, native JPEG/WebP outputs, orientation correction,
metadata removal, invalid-image rejection, checksum checks and source dimension,
pixel and byte limits passed. All 13 native-probe, negative-control and runtime
cases passed. No managed AWS calls or credentials were used.

Isolation remained: network disabled, read-only root, one CPU, 1024 MiB memory,
128 MiB executable artifact tmpfs with nosuid/nodev, and a separate 512 MiB /tmp
with noexec/nosuid/nodev. The mount capacities are not preallocated; their pages
share the container memory limit. Each fixture runs in a fresh process with a
30-second bound. No ZIP is published as a GitHub artifact.

## Native Linux resource measurements

These measurements come from the passing native workflow above, not earlier WASM
or macOS measurements. Peak RSS includes fixture generation and process startup;
duration covers processing with synthetic adapters, not real S3/DynamoDB latency.

| Input                     | Source bytes | Processing ms | Peak RSS MiB | Outputs                 |
| ------------------------- | -----------: | ------------: | -----------: | ----------------------- |
| 640 × 480                 |         5747 |            44 |        149.2 | 4; 396–2068 bytes each  |
| 1600 × 1200               |        28898 |           214 |        173.5 | 6; 396–11518 bytes each |
| 5000 × 4000 (20 MP limit) |       279252 |           495 |        236.6 | 6; 410–12268 bytes each |

Peak whole-container memory was 293,134,336 bytes (**279.6 MiB**), including tmpfs.
Observed usage was below proposed 1024 MiB/30-second limits. The oversized-axis,
oversized-pixel, oversized-byte, invalid-image and checksum rejection cases passed
without output. Existing 8 MiB input and 20 MP limits remain enforced.

**Completed:** native AL2023 Linux container compatibility validation.
**Outstanding:** managed Lambda deployment and acceptance. Solid-color synthetic
fixtures do not guarantee production performance or represent photographic
complexity, managed-service latency or reserved concurrency 2. Representative
cookie photographs and real image-upload processing must be tested during
separately authorized DEV acceptance. Approved Lambda memory, timeout, ephemeral
storage and concurrency settings below are unchanged.

## Validation and limitations

Previously recorded local validation: 26 processor tests; 59 relevant backend media tests; 36 DynamoDB Local
groups including packaged-worker durable completion/replay; 10 backend artifact
checks passed. Processor and backend production audits reported zero findings.
Processor strict type checking, lint (zero warnings), repository formatting,
whitespace checks and both host/Linux packaging passed. The actual ZIP tested by
run 38682038692 was 13,054,883 bytes compressed and 34,464,814 bytes uncompressed,
with 198 entries; SHA-256
`e118db1c144784a2701a421b4b502beccc8ce752d5827783d743a5f12ca4f454`. These sizes are
below the [AWS Lambda ZIP limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
of 50 MiB compressed for direct upload and 250 MiB uncompressed. Inspection found no macOS binaries, development tools,
test helpers or credential markers. Existing pinned lockfile entries retain their
versions/integrities; tslib changes from optional to required due to the SDK. The local
runtime unit cases inject repository/S3 failures; they do not establish managed
AWS behavior. Existing real local transaction tests retain superseding/terminal
fencing and ambiguous completion coverage. DynamoDB Local does not emulate all
managed contention, retries, clocks, throttling or network partitions.

The previous 204 frontend administrator tests and 37 infrastructure tests are
historical; no UI or infrastructure implementation changed in this assignment.
No hosted upload or payment acceptance occurred.

## Exact future deployment needs — not implemented

- One private function `batch-and-batter-dev-media-processor`, runtime nodejs24.x,
  architecture x86_64, handler `index.handler`, 1024 MiB memory, 30-second timeout,
  512 MiB ephemeral storage, reserved concurrency 2. Sharp concurrency stays 1.
  No function URL, API Gateway route, public resource policy or S3 event trigger.
- Precreate a scoped log group with a reviewed retention period. Execution role:
  logs:CreateLogStream and logs:PutLogEvents only on this function's log streams.
  No event/body/object-key/credential logging; fixed errors plus Lambda platform
  request IDs and duration/memory metrics. Monitor Errors, Throttles, Duration,
  ConcurrentExecutions, AsyncEventAge and AsyncEventsDropped. A durable FAILED
  image returns a business failure without a Lambda error: monitor catalog status
  through separately authorized operational reads as well.
- s3:GetObject only on the fixed bucket's `staging/products/*`; s3:PutObject only
  on `approved/products/*`. Preserve conditional creation, TLS, SSE-S3, ownership
  enforcement and BlockPublicAccess. No ListBucket, DeleteObject, ACL, bucket-admin,
  public-read, wildcard bucket, SSM, Stripe or payment-table permissions.
- Catalog table only: dynamodb:GetItem, PutItem and ConditionCheckItem for the
  existing transaction operations. Scope writes to media intent/asset keys and
  guard reads/checks to existing Product/readiness/slug ownership keys through a
  reviewed action-specific LeadingKeys policy. Do not grant Product writes or
  commerce/operations-table access. No new table/index or readiness activation.
- Backend role: lambda:InvokeFunction only on the approved function/alias ARN.
  Only the reviewed backend integration may invoke it; no public/browser principal.
  Backend runtime assembly and staging-only upload permission remain a separate
  change. Do not deploy the whole stack or replace accepted mixed payment artifacts.
- Async maximum event age 900 seconds and maximum retry attempts 2, consistent
  with the existing 15-minute intent and three-attempt contract. Errors can exhaust
  deliveries; active-lease duplicates may be ignored. Explicit existing redispatch
  recovery remains necessary; this is not an eventual-success guarantee. See
  [AWS async error settings](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-configuring.html).
- Browser CORS is not needed by the processor. Any future upload CORS must be
  separately reviewed for exact admin origins and required POST behavior.
- Costs add Lambda requests and billed GB-seconds, a staging GET and up to six
  output PUTs per successful attempt, Catalog reads/transactional writes, output
  storage and logs. Retries/partial outputs add cost; reserved concurrency is not
  provisioned concurrency. No fixed monthly estimate is defensible before volume
  and representative Lambda duration are known. No paid resources were created.

Native container validation is complete. Runtime/IAM/CORS approval, processor
Lambda provisioning, catalog migration/readiness, separately authorized controlled
DEV deployment, managed Lambda acceptance with representative cookie photographs
and real uploads, authenticated image delivery, customer publication controls and
authorized cleanup execution remain outstanding. Live uploads remain
disabled. Hosted duplicate-activation acceptance remains **NOT PASSED**.
