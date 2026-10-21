# 1N-Q — Controlled frozen media publication

The only live command is `node infra/scripts/publish-media-1n-q.cjs --publish-approved-1n-q owner:1N-Q`.
It accepts no artifact path, key, role, source or deployment override. This command
requires the owner's separate 1N-Q authorization; merging the command alone is
not permission for another publication or a deployment.

It loads the two owner-only frozen ZIPs from the existing `1n-n-freeze` directory,
validates the reviewed descriptors and complete inventories, and preserves source
`a0aac8fa67d521a7a6acb7c31a154511feae3579` / tree
`07df83a3f28a724e859eeba3546565aac595e5c6`. No rebuilding or recompression occurs.
The original native CI evidence is run 39005129600.

Preflight reads the actual AWS operator identity, installed new and historical
publisher trust/boundary/identity policies, full paired bucket policy, versioning,
lifecycle, public-access block, bucket encryption, KMS identity/state and key policy.
The checked baseline is recorded in `media-publication-baseline.json`. Drift stops
execution. IAM/KMS inspection uses the approved operator, not elevated permissions
on the restricted publisher role.

Only the exact media publisher role is assumed, for 900 seconds. Credentials stay
in process memory; the identity subprocess receives them in its isolated environment,
never command arguments, logs or files. Its actual STS identity must match the fixed
role/session. The existing tested transport uses single-attempt SDK requests,
exact frozen keys/checksums and SSE-KMS configuration. A per-artifact transport guard
blocks a second PUT independently of SDK retry settings and reports safe attempt
counts. Both complete exact-key histories must be empty before either PUT.

The unchanged publication core performs A then B, with B reachable only after A
is VERIFIED. Live receipts use simulated=false and deploymentAuthorized=false.
Every operation writes durable PREPARED/ATTEMPTED state, captures the opaque VersionId,
and verifies exact-version bytes, metadata, encryption, current version and history.
Any uncertain result stops without another PUT. The mock-only API is unchanged.

The fixed owner-only journal is `~/.codex/artifact-publications/media-1n-q`.
An exclusive batch lock prevents concurrent execution; prior receipts block a new
CLI invocation. A crash leaves its lock for separately authorized investigation.
Do not delete a lock or receipt to retry. Reconciliation is read-only and separately
reviewed; the state-machine mock tests cover lost acknowledgements without repeat PUT.
No credentials are placed in receipts. Temporary local mock receipts are not live
publication evidence, even when exercising simulated=false behavior.

Before live execution, separately complete the 1N-Q preservation checks for the
Catalog, accepted records/artifacts, payment false and hosting Jobs 9/2. Afterward
recheck them and verify both exact object histories. No IAM/S3 policy mutation,
permission revocation, third artifact, deployment, photo upload or business-data
write is included. Publication permissions remain installed pending separate cleanup
approval. Hosted duplicate-activation acceptance remains **NOT PASSED**.
