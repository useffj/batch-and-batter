# Controlled isolated Catalog publication — 1N-D

The owner authorized one conditional PutObject for the identity recorded in
[the release proposal](ISOLATED_DEV_RELEASE_CANDIDATE.md). No deployment, IAM
change, deletion, database initialization or payment change is authorized.

The generic `publish()` and its CLI remain mock-only. The separate
`infra/scripts/publish-isolated-catalog-1n-d.cjs` requires exactly
`--publish-approved-1n-d`. Importing either module performs no AWS operation.
The entrypoint accepts no artifact path, destination or operation override.
Its fixed identity includes the approved runtime source commit, ZIP hash and
size, build lock hash, Node version and original UUID. It loads only the approved
isolated build path and verifies ZIP/evidence before touching AWS.

Before invoking it, complete source checkpoint/CI and verify accepted artifact
versions, five Lambda hashes, application stack and hosting invariants. The
entrypoint rereads operator identity, role trust, exact inline policy, boundary,
bucket protections, versioning, lifecycle and encryption. CLI reads use only the
approved profile. The approved SSO operator assumes the dedicated publisher role;
STS verifies that temporary session before the existing S3 adapter is constructed.
Credentials stay in memory and are neither logged nor journaled. Errors print a
constant message rather than raw SDK/CLI exceptions.

The existing journal and state machine are reused. Real receipts have
`simulated: false`; mock and real receipts reject each other. Receipts and locks
are kept outside Git in the current user's
`~/.codex/artifact-publications/isolated-catalog-1n-d/` directory, requiring mode
0700, owned by the current user, with mode-0600 files and no symlinks. The original
operation identity and ATTEMPTED state are fsynced before PUT. Existing crash locks
are never automatically broken; a stale lock requires explicit operator review.

The adapter fully traverses exact-key version history before PUT. It uses the
approved expected owner, IfNoneMatch `*`, checksum, KMS key and disabled Bucket
Keys, with SDK attempts limited to one. No ACL, tags, copy or multipart operation
is available. It reads the original exact version back, verifies bytes, metadata,
encryption and current history, then durably records VERIFIED. No state after
ATTEMPTED can submit another PUT. On an ambiguous response, retain the original
journal and inspect/reconcile read-only; never remove the receipt or change UUID.
A collision stops publication. No automatic CLI retry loop exists.

The installed exact-key IAM permission remains in place. Its eventual removal
requires separate authorization. A VERIFIED receipt permits preparation of exact
CloudFormation ArtifactKey/ArtifactVersion parameters through
`isolatedArtifactParameters()`; it does not authorize a change set or deployment.

Tests cover both fixed artifact types, real/mock receipt separation, alternate
identity rejection, exact-version readback, checksum/VersionId failures, crash
and lost-acknowledgement recovery, collision, receipt persistence and no duplicate
PUT. Existing SDK transport tests verify explicit temporary credentials, transport,
wire-level conditional/checksum/encryption fields and one-attempt behavior.

Hosted duplicate-activation acceptance remains NOT PASSED.
