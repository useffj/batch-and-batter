# 1N-O — Frozen media publication compatibility

Source-only preparation. **No publication or deployment is authorized.** Both
frozen artifacts retain source commit `a0aac8fa67d521a7a6acb7c31a154511feae3579`
and tree `07df83a3f28a724e859eeba3546565aac595e5c6`. Publisher source changes do not
change either artifact's inputs or provenance.

`infra/config/frozen-media-artifacts.json` binds two operation IDs, exact keys,
source/tree, lockfile hashes, byte counts, SHA-256 and per-file ZIP inventories.
The API is 2,822,491 bytes with hash
`4e962eec3b65f0e9e5fb3a93b436d2e69f552566162b24287e2220925fb4e0b3`.
The processor is 12,985,107 bytes with hash
`6596435a4576c4a5bd426b71ebe1c182630da9a0da3582f8b03948f7d119c342`.
The processor matches native AL2023 validation run 39005129600 exactly; no new
native execution or artifact rebuild is required or performed here.

## Dormant implementation

`publish-media-artifact.cjs` accepts only these frozen identities, an explicit
approval reference and captured bytes. Its ZIP parser verifies bounds, CRCs,
paths, duplicate entries, symlinks, expansion limits and complete inventories.
The API must remain a single handler.js; the processor requires index.cjs and the
exact native Sharp/libvips files. The historical single-handler validator is
unchanged. No caller-selected source, hash, key or arbitrary archive is accepted.

The shared publication state machine preserves create-only PUT, full exact-key
history checks, opaque VersionIds, exact-version readback, durable receipts and
uncertain-result reconciliation. It never blindly retries an attempted upload.
The media entrypoint is mock-only. There is no live media publication command.
Mock evidence is not AWS authorization and cannot establish installed policy.

The existing dormant S3 transport has a separate media constructor accepting only
these exact keys/hashes/sizes and explicit session credentials expiring within one
hour. Expiry is rechecked before each request. It performs no credential discovery
or network operation on construction. The historical constructor is unchanged.
No secrets belong in CLI arguments, source, journals or logs.

## Exact policy proposal — not installed

`media-publication-policy.cjs` emits the complete proposed bucket policy, trust,
identity policy and boundary. It uses a new role:
`arn:aws:iam::302154194958:role/batch-and-batter-dev-media-artifact-publisher`.
The historical publisher role, boundary and exact-key approval are untouched.

The new role uses the existing approved SSO operator trust. Its identity policy
and boundary are restricted to the two exact frozen object ARNs: conditional
PutObject, GetObject/GetObjectVersion, exact-prefix ListBucketVersions, and
GenerateDataKey/Decrypt with exact object encryption contexts. No delete, IAM,
policy administration, CloudFormation, deployment or wildcard publication grant.

The installed api-releases prefix deny cannot be bypassed by an identity Allow.
The proposal adds the new principal to that deny's exception list **paired with**
an explicit deny on that principal for every PutObject outside the two exact keys.
All historical principals retain their previous restrictions. A separate exact-key
deny permits only the new principal at the two new keys. Existing accepted-key
and prefix protections remain, including conditional-header and copy restrictions.
Both keys receive permanent deletion/version-deletion/tagging/ACL denies, strict
If-None-Match=* and required SSE-KMS algorithm/key conditions. No existing accepted
artifact gains a new writer. These statements must be installed/reviewed together.

The existing AWS-managed S3 KMS key is
`arn:aws:kms:us-east-2:302154194958:key/c4361324-2444-4484-82ef-f98ba10b5ad3`.
Its read-only inspected policy allows account principals authorized for S3 through
`s3.us-east-2.amazonaws.com` in account 302154194958. No KMS key-policy edit is
proposed. Identity/boundary conditions bind each exact object ARN; Bucket Keys
remain false. Any Bucket Key or encryption drift blocks publication. Local policy
assertions do not replace AWS authorization or effective-policy review.

## Read-only preservation evidence

On October 20, 2026, the approved profile authenticated to account 302154194958 in
us-east-2. The isolated stack remained UPDATE_COMPLETE with the same 21 physical
resources, API ui8k11k343, eleven JWT routes, concurrency two, unchanged exclusive
writer policy and media-free Lambda hash. All ten accepted Catalog records matched
the acceptance snapshot. All five financial Lambda hashes/accepted versions,
PAYMENT_START_ENABLED=false, public Job 9 and restricted Job 2 were preserved.
Automatic builds, branch creation and previews remained disabled. Installed
historical bucket policy, publisher trust/identity/boundary, versioning and KMS
configuration matched reviewed evidence. Both proposed keys had no versions or
delete markers. Frozen bytes matched; original testing workspace was untouched.
Evidence is retained outside Git under the owner's 1n-o-preflight directory.

## Smallest next authorization

Separately approve only installing the reviewed new role/boundary and exact-key
bucket-policy delta, then read-only verification. No publication in that step.
After successful verification, authorize one bounded live execution entrypoint
for these two frozen operations and explicit approval reference, reusing the
reviewed state machine and transport. Require fresh protections and short-lived
credentials, absent complete key history, versioning and retention checks before
any single conditional PutObject. Persist PREPARED and ATTEMPTED before sending;
record returned VersionId and verify full bytes/checksum, encryption, metadata,
current version and complete history before VERIFIED. Stop on uncertainty and
reconcile the original identity; never create a replacement key or retry blindly.

After both receipts verify, separately revoke temporary new-role publication
access while retaining permanent bucket denies, historical permissions, receipts
and approved readback access. No stack execution, hosting build, live upload,
processor activation, business-data write or financial change is included.
Hosted duplicate-activation acceptance remains **NOT PASSED**.
