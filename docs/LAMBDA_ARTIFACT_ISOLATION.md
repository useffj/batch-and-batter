# Lambda artifact isolation — local implementation

Status: LOCAL CODE ISOLATION VALIDATED; SAFE DEPLOYMENT NOT ESTABLISHED.
No release authorization is represented by this document or any local override.
Baseline: `73765d5c75acee308ee378a70f6652ee1f7f9dd2`, branch
`codex/media-runtime-infra-1b2i`. No managed AWS operations were performed during 1B-2I-B.

## Accepted manifest and selection

`infra/config/dev-lambda-artifacts.json` records the five existing logical IDs,
handlers, exact bucket/key, verified ZIP hash, observed version, provenance and
accepted-reference status from the preceding read-only investigation. Records
are indexed by logical ID after strict validation; duplicate, missing, unknown
identities and unexpected fields fail closed. The manifest is nonsecret.

Default selection uses API artifact A, payment worker B, and webhook/expiry/
reconciler C. It emits only `S3Bucket` and `S3Key`. Observed versions are provenance,
not `S3ObjectVersion`. Imported bucket constructs create no bucket resources or
IAM grants. Function construct paths, logical IDs, handlers and configuration
remain unchanged. Existing five-entrypoint build/verifier remain unchanged.

The application entrypoint explicitly targets account `302154194958`, region
`us-east-2`, rejects conflicting CDK account values, and uses no lookups.
The fixed stack region takes precedence over CDK's ambient us-east-1 fallback
in credential-free CI; the fallback cannot change the target.

## Independent API artifact

Run `npm --prefix backend run build:api`. Output is ignored
`backend/dist/api-release/api.zip`, containing only `handler.js` with export
`handler`. Evidence and bundle metadata remain outside the ZIP. The build verifies
locked production inputs, built-in-only external imports, excludes worker
entrypoints, test/local configuration and native media inputs, and scans for
credential patterns. This is a bounded scan, not a guarantee against all secrets.

Two consecutive local builds on Node 24.19.0 produced byte-identical ZIPs:
`40f50536bac9236a1235e27a8db038342cd75be1cce57d4bbff77d36a55586e5`
(3,517,114 bytes). ZIP metadata is fixed and compression is stored, avoiding zlib
variation. Reproducibility across machines, toolchains or Lambda execution is
not established. Python 3 is required for deterministic ZIP packaging. Synthetic
local health invocation passed. The API still contains its required financial
routes; packaging isolation does not establish behavior acceptance for a release.

## Explicit local override

CDK context `apiArtifact` accepts an object or JSON string with exactly:

```json
{
  "logicalId": "ApplicationApi5D63FF39",
  "account": "302154194958",
  "region": "us-east-2",
  "sha256": "40f50536bac9236a1235e27a8db038342cd75be1cce57d4bbff77d36a55586e5",
  "reviewedForLocalSynthesis": true
}
```

The boolean records explicit local selection, not external approval. Only the
fixed API ZIP path is accepted; symlink resolution, SHA-256 and build evidence
are checked. Arbitrary paths and worker overrides are rejected. Nothing is
uploaded or activated. Without context, accepted references remain selected.
The independently packaged media processor is not selected or changed here.

## Complete comparison and tests

`infra/scripts/compare-templates.cjs baseline.json candidate.json
[approved-api-code.json]` compares the entire parsed template, including IAM,
environment, routes, resources, metadata, parameters, outputs and array order.
The optional file authorizes exactly the API Code object for this comparison.
It is not a general resource allowlist or release authorization. Missing API
resources, worker changes and all other drift fail closed. Review the baseline,
candidate and approved Code independently; never derive approval automatically
from an unreviewed candidate. CLI failures deliberately do not dump template data.

Infrastructure tests synthesize the same target under identical settings:

- A: all five exact accepted Code references, no version properties, payment
  admission default false, no media processor or upload activation.
- B: verified API candidate changes only API Code across the complete test
  template; all worker configurations, IAM, events and other resources match.
- C: future media resource additions are rejected by the current comparator.
  A future contract must enumerate separately approved processor resources,
  permissions and separate artifact, while forbidding worker changes. No media
  infrastructure scenario is implemented or claimed to pass.

CLI synthesis adds asset metadata when using `Code.fromAsset`. Switching to
accepted bucket references removes only the three `aws:asset:*` metadata entries
from each Lambda; `aws:cdk:path` remains. A future CLI-generated API override can
add API asset metadata. The strict comparison does not silently ignore this:
release review must explicitly account for it under a separately approved
comparison contract. Tests use consistent CDK assertion synthesis settings.

## Recorded deployed-template drift — deployment blocked

Offline comparison used the locally archived accepted deployment template at
`/Users/jksn/Documents/Batch-and-Batter-Evidence/1A-DEV9-2026-10-13/template.json`,
with its adjacent successful deployment summary. Its freshness was not verified
against AWS during this assignment. The cached us-east-1 template is not a
release baseline.

Correct-region CLI synthesis compared with this archive shows:

- All five Lambda Code objects match exactly.
- 27 API Gateway resources added: nine route/integration/invoke-permission
  triples for product listing, details, six media routes and storefront assignment.
- Three archived assignment resources removed: `AdminStorefrontAssignmentRoute`,
  `AdminStorefrontAssignmentIntegration`, `AdminStorefrontAssignmentInvokePermission`.
- Five Lambda metadata changes removing stale asset annotations.
- Four payment parameter definitions differ: source removes archived fixed
  defaults/AllowedValues on `StripeSandboxAccountId`, `DevPaymentLedgerNamespace`
  and `DevPaymentLedgerAccountId`; `PaymentStartEnabled` remains default false
  but source permits true as well as false, unlike the archive.
- No other existing resource properties differ from this archived template.

The complete comparator rejects this drift. No normalization or exception is
applied to the deployed comparison. A separate source-to-source diagnostic,
normalizing the pre-edit synthesis region only, confirms this implementation
changes only the five Code objects and their asset metadata. It is not live
baseline evidence and does not excuse the deployment drift.

## Deployment guard and unresolved gates

`npm --prefix infra run deploy:dev` now always fails before spawning any deploy
process, regardless of arguments. The pure legacy argument helper remains only
for contract tests. There is no enabled release executor or override switch.
Direct privileged AWS/CDK CLI access is outside this script's enforcement; this
is not an IAM boundary. GitHub workflows remain validation-only.

A future release contract must require the explicit target, reviewed manifest,
candidate hash verification, fresh accepted worker artifact/hash verification,
complete authoritative template comparison, explicit allowed-change review and
separate release authorization. Do not run a full-stack deploy to resolve drift.

Artifact availability/retention remains unresolved: observed bucket versioning
is enabled, noncurrent versions expire after approximately 30 days, Object Lock
is absent, and Code references are unversioned. Recorded versions do not prevent
replacement or deletion. Reverify current and rollback artifacts before any
release; retention/write protection needs separate review and authorization.
No copying, lifecycle changes, Object Lock or bucket changes were performed.

Local validation: 44 infrastructure tests; 1,037 backend tests; 10 unchanged
artifact checks; one new API artifact test covering two-build reproducibility,
ZIP contents and synthetic invocation; backend/infra type checks; offline CDK
synthesis; lint, formatting and diff checks. No hosted acceptance occurred.

Smallest next assignment: read-only authoritative template reconciliation plan
covering the route identities, payment parameter constraints and metadata,
plus artifact availability/retention evidence. Do not activate media, catalog
readiness or payments. Hosted duplicate-activation acceptance remains NOT PASSED.

## 1B-2I-D: authoritative API-only release proposals

LOCAL TEMPLATE ISOLATION VERIFIED. DEPLOYMENT AUTHORIZED: FALSE.

The new `infra/scripts/build-api-release.cjs` is a local proposal builder, not a
release executor. It reads the reviewed anchor in
`infra/config/api-release-baseline.json`. This anchor pins the DEV account,
region, full stack ARN, stack name, last update timestamp and canonical SHA-256
of the authoritative 1B-2I-C template. It contains no parameter values.
Changing the anchor requires reconciliation and review; the CLI has no anchor
or environment override.

The builder consumes a read-only evidence snapshot containing `account`,
`region`, `stackId`, `stackName`, `lastUpdatedTime`, `status`, `retrievedAt`,
`original`, `processed` and the current stack `parameters`. Both templates must
match the pinned hash. The stack must be UPDATE_COMPLETE, and the snapshot must
be no more than 15 minutes old, with no future timestamp. All parameter keys
must be present exactly once. The four payment bindings must match the existing
singleton constraints and defaults, with payment admission false.

This is local evidence validation, not AWS attestation: snapshot timestamps and
contents are unsigned files. Fresh authenticated AWS retrieval is required again
at release, and a change between inspection and execution remains possible.
The tool cannot establish live freshness merely from a caller-supplied timestamp.
It therefore never grants deployment eligibility.

The candidate JSON has the five existing API selection fields (`logicalId`,
`account`, `region`, `sha256`, `reviewedForLocalSynthesis`) plus `releaseId`,
`destinationBucket` and `destinationKey`. The release ID must be a UUID v4;
the destination must be the existing DEV asset bucket and exactly
`api-releases/<releaseId>/<sha256>.zip`. Extra fields, arbitrary local paths,
accepted-key reuse and worker selection are rejected. The independent API
verifier reads the fixed local ZIP and checks its bytes against the expected
hash and build evidence. A UUID proposes uniqueness; only a separately
authorized conditional publication can establish that the destination was
unused. No S3 existence or publication is assumed.

After building infrastructure locally, usage is:

```sh
node infra/scripts/build-api-release.cjs snapshot.json candidate.json /private/new-output-directory
```

The output directory must not exist. It is created owner-only, with owner-only
JSON files. Output includes the proposed template, a NOT DEPLOYABLE report,
rollback identity and unverified availability, and parameter instructions using
`UsePreviousValue: true` for every current parameter. The CLI never prints the
template, parameter values or raw validation exceptions. Keep output and raw
evidence outside Git. The compiled artifact-selector module is required; build
infrastructure before invoking this tool.

Only `Resources.ApplicationApi5D63FF39.Properties.Code` is replaced. The complete
comparison preserves all other data, including all four payment definitions,
worker Code objects without versions, handlers, runtime, environment, IAM,
routes, integrations, authorizers, permissions, dependencies, S3 resources,
resource/top-level metadata and existing assignment identities. No broad CDK
reconciliation or asset-metadata cleanup occurs. This narrow proposal avoids
the previously documented full-CDK drift; that drift remains unresolved.

The existing deployment guard now shares the builder's explicit release-blocker
list. It still always rejects ordinary deployment before invoking any executor.
Even supplied rollback evidence cannot enable deployment. Required future gates:

1. Fresh authenticated stack/template and parameter verification.
2. Exact local and published candidate hashes, plus accepted worker/rollback
   versions and hashes.
3. Reviewed retention and create-only publication protections.
4. Complete comparison allowing exactly the approved API Code replacement.
5. Separate release authorization and a reviewed CloudFormation change set.
6. A post-release verification plan, then actual artifact/configuration checks.

No deployment workflow, change set, upload or direct Lambda update is implemented.
Local template equality also does not prove behavioral equivalence of the new
API code, which includes existing financial endpoints. Existing regression and
release acceptance gates remain required; payment admission stays disabled.

### Approved retention direction and future protection scope

Active artifacts remain retained while deployed; designated rollback artifacts
remain retained until explicit authorized retirement. Candidate keys are unique
and create-only. Exact accepted and candidate keys must be protected against
routine overwrite, deletion and version deletion, with version availability
verified before release. Do not rely on the 30-day noncurrent-version lifecycle.

The smallest proposed control is an exact-key write/delete protection policy for
accepted/retained artifacts, plus conditional create-only publishing under the
new API release prefix. Review publisher permissions and enforcement of
`If-None-Match: *`; a preliminary HEAD check alone does not prevent races.
Freeze the newly published candidate as a retained release artifact before use.
Scope controls to these keys/prefixes so unrelated assets in the shared CDK bucket
continue working. Preserve existing accepted locations and Code references.
These controls are not Object Lock and do not constrain administrators who can
change the policy. Lifecycle handling must explicitly cover any retained version
that becomes noncurrent; a delete-deny policy alone is not a lifecycle exception.
The approved retirement process must govern eventual removal of protection.
All policy, lifecycle and publishing work needs separate implementation/review
and AWS authorization. None was performed here.

### Validation and remaining gates

Fresh read-only AWS verification matched the 1B-2I-C stack identity, update time,
and both deployed templates before local implementation. The builder was then
run against that fresh evidence: no-change output was identical, and the API-only
proposal differed solely at Code. Parameter output contains only keys and
UsePreviousValue flags. The proposed ZIP remains unpublished.

All 60 infrastructure tests passed (44 prior tests plus 16 release tests).
Synthetic fixtures cover A–K: zero change, API Code only, worker Code,
payment constraints, route addition, assignment removal, IAM, Lambda metadata,
bad hash, stale baseline and missing rollback evidence. Additional tests reject
runtime/environment/dependency/top-level metadata changes and unsafe candidate
destinations. Independent API rebuild/reproducibility and synthetic health passed;
type checking, offline synthesis, lint, formatting and diff checks passed.
Changed CommonJS files were linted with the require-import prohibition disabled,
consistent with the existing CommonJS script convention.

Next: focused local review of the builder and its fail-closed contracts, followed
by a separately authorized exact-key retention/create-only publishing design.
No live artifact protection or deployment readiness is established by this work.
Hosted duplicate-activation acceptance remains NOT PASSED.

## 1B-2I-E final review

A credential-free CLI synthesis exposed a CI-only default-region rejection.
The app now keeps its explicit us-east-2 stack target rather than rejecting CDK's
ambient us-east-1 fallback. A regression test verifies the emitted assembly
still targets only account 302154194958/us-east-2. No deployment path is enabled.
Final infrastructure validation includes 61 tests; API packaging and the ten
existing artifact checks remain applicable. The checkpoint does not authorize
AWS changes, artifact publication or media activation.

### Exact-key protection and publishing proposal (read-only)

The inspected bootstrap file-publishing role has bucket-wide `s3:PutObject*`,
`s3:DeleteObject*`, read/list and abort permissions. The current bucket policy
only denies non-TLS access. Versioning is enabled; CleanupOldVersions expires
noncurrent versions after 30 days. Bucket encryption uses the enabled AWS-managed
S3 KMS key. These facts do not establish artifact immutability.

Proposed controls, requiring separate AWS authorization:

- For the three exact accepted object keys in `dev-lambda-artifacts.json`, deny
  routine `s3:PutObject`, `s3:DeleteObject` and `s3:DeleteObjectVersion`. The policy
  must constrain the existing broad publishing role, not merely grant a new
  role fewer permissions. Keep all unrelated bootstrap keys unaffected.
- For `api-releases/*`, deny deletion/version deletion and enforce conditional
  create-only writes with the `s3:if-none-match` condition. Restrict publication
  to a dedicated approved role; it gets `s3:PutObject` on its approved candidate
  key, `s3:GetObject`/`s3:GetObjectVersion` for read-back, and no delete or policy
  administration rights. Do not use the broad bootstrap publisher as the
  unrestricted release identity. Any role/trust creation and `sts:AssumeRole`
  grant require separate IAM authorization.
- With current SSE-KMS, the publishing/verifying identity needs
  `kms:GenerateDataKey` and `kms:Decrypt` on the resolved S3 KMS key, constrained
  to S3 in us-east-2 where applicable. Do not change encryption settings or key
  policies as part of publication. No ACL or tagging permissions are needed by
  the proposed simple PutObject procedure.
- Review controls with `s3:GetBucketPolicy`, `s3:GetBucketVersioning`,
  `s3:GetLifecycleConfiguration`, `s3:GetEncryptionConfiguration`,
  `s3:GetBucketObjectLockConfiguration`, prefix-scoped `s3:ListBucketVersions`,
  and object reads. A separately approved policy operator would need
  `s3:PutBucketPolicy`; publisher-role setup requires the corresponding scoped
  IAM role/trust/inline-policy administration. These are future grants, not
  permissions granted by this checkpoint.
- Preserve every active/rollback artifact until explicit retirement. Reconfirm
  accepted versions are current before protection. Current objects are not
  expired by the observed lifecycle; preventing overwrites/deletion keeps them
  current even after Lambda moves to a different key. A retained version that
  becomes noncurrent is a release blocker until explicit lifecycle protection
  is approved. A delete-deny policy does not prevent lifecycle expiration.
  Do not apply a blanket lifecycle change that disrupts unrelated CDK assets.
- Retirement must name exact keys/versions, confirm no active or designated
  rollback reference, and have explicit authorization before any exceptional
  policy change or deletion. These controls are not administrator-proof WORM.

Future publishing procedure (not implemented): verify the local ZIP SHA-256,
assign a UUID/hash key, then use the S3 **PutObject** API with `IfNoneMatch: "*"`,
`ChecksumSHA256` (base64 SHA-256), expected bucket owner 302154194958 and the
verified bytes. The installed CLI model and official API support these fields.
Do not substitute `aws s3 cp` or a HEAD-then-unconditional-PUT sequence. A 412 is
an explicit collision rejection; on a 409 or ambiguous result, reconcile the
object/version and checksum before any bounded retry using the same condition.
Never retry unconditionally or claim success from ETag alone. Read back the exact
returned version, hash its bytes, and verify that the current key still resolves
to that version. Record key, version, SHA-256, source commit, build evidence,
publisher identity and timestamp without credentials or ZIPs in Git. Verify
retention controls and fresh stack/template evidence before any separately
authorized release. No publication or deployment is authorized by this plan.

References:
[PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html),
[conditional-write enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).
