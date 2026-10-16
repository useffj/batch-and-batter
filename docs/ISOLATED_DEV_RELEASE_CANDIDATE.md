# Isolated Catalog release candidate — 1N-B

Proposal only. No AWS writes, publication, IAM activation, change sets, stack
creation, database initialization or hosting release is authorized by this
checkpoint. Hosted duplicate-activation acceptance remains NOT PASSED.

## Candidate and publication boundary

Runtime source: `85f44867a6c724158fb02bb6923cc48e330a9342`; backend sources and
lockfile are unchanged by this checkpoint. The final source-control report binds
the release-tooling merge commit to this same runtime ZIP.

- Artifact type: `isolated-catalog`; handler `handler.handler`, Node 24, x86_64.
- Fixed input: `backend/dist/isolated-catalog-release/api.zip`.
- SHA-256: `69e6ec8aeb468e1023b203d0a23e8f33ebfe3ca522c861593570b98e81c78fcb`.
- Size: 2,107,927 bytes; one bundled `handler.js` entry.
- Backend lock SHA-256: `76ee0b2d071b95814fd726ce113bb14c235e8547be101741f9bbd76898e829ca`.
- Proposed operation UUID: `5f10ad5a-beb2-405b-bc9f-2a6135f62b38`.
- Bucket: `cdk-hnb659fds-assets-302154194958-us-east-2`.
- Proposed key: `api-releases/5f10ad5a-beb2-405b-bc9f-2a6135f62b38/69e6ec8aeb468e1023b203d0a23e8f33ebfe3ca522c861593570b98e81c78fcb.zip`.

The existing publisher now accepts only `api` and `isolated-catalog` fixed paths.
Omitted type remains ordinary API for compatibility with existing durable receipts;
all new approvals should specify the type. A typed operation cannot be retried as
another type. ZIP/evidence symlinks and caller-selected paths are rejected.
Hash, size, dependency evidence, create-only writes, receipt durability and
uncertain-write recovery remain enforced. The publisher entry point remains
mock-only; this change does not activate a live publishing path.

The exact S3 VersionId does not exist yet. After separately approved publication,
use only the verified durable receipt's original VersionId. Call
`isolatedArtifactParameters(key, versionId)` before preparing CloudFormation
parameters: it preserves well-formed opaque UTF-8 exactly and rejects missing,
empty, literal `null`, malformed Unicode and values over 1,024 UTF-8 bytes.
CloudFormation's length bound is character-based; its pattern now permits opaque
characters, so it does not replace the local byte-validation gate. Never choose
a newer version or fabricate a placeholder. Publication and deployment remain
separate authorization steps.

## Exact publisher permission proposal

Smallest next AWS action, only after explicit authorization: attach the
materialized exact-key identity policy to the existing dormant role
`arn:aws:iam::302154194958:role/batch-and-batter-dev-api-artifact-publisher`.
Use `materializeIdentityPolicy` with the key above, preserving its existing
permissions boundary and trust. This is a proposal, not permission to attach it.

The policy permits only:

- `s3:PutObject` on the exact key, conditioned on `s3:if-none-match = *`.
- `s3:GetObject` and `s3:GetObjectVersion` on that exact object.
- `s3:ListBucketVersions` on the bucket with exact `s3:prefix` equal to that key.
- `kms:GenerateDataKey` and `kms:Decrypt` on
  `arn:aws:kms:us-east-2:302154194958:key/c4361324-2444-4484-82ef-f98ba10b5ad3`,
  conditioned on S3 in us-east-2, caller account 302154194958 and the exact object
  ARN encryption context.

No delete, overwrite, wildcard object grant or accepted-artifact changes. A later
approved operator publication must retain the same operation identity and receipt,
use the existing adapter's conditional PUT and exact-version verification, and
reconcile uncertain results without a second PUT. No live launcher is enabled here.

## Quarantined deployment and initialization

Only new stack `batch-and-batter-dev-isolated-catalog`, account 302154194958,
region us-east-2. Its 21 resources are exactly:

| Logical IDs                      | Resource type                       | Count |
| -------------------------------- | ----------------------------------- | ----- |
| Catalog                          | DynamoDB table                      | 1     |
| Logs6819BB44                     | CloudWatch log group                | 1     |
| CatalogRole0D3BB0F5              | IAM role                            | 1     |
| CatalogRoleDefaultPolicy177B9A56 | IAM inline policy                   | 1     |
| CatalogApi                       | Lambda function                     | 1     |
| Api                              | HTTP API                            | 1     |
| AdminAuthorizer                  | Cognito JWT authorizer              | 1     |
| Integration                      | Lambda integration                  | 1     |
| Route0–Route10                   | Protected catalog routes            | 11    |
| Stage                            | API stage                           | 1     |
| GatewayInvoke                    | Scoped Lambda invocation permission | 1     |

No existing application resource changes. Initially the retained, encrypted,
on-demand table has PITR and deletion protection and no seeded records. The
resource policy denies all writes except the approved initializer role; Lambda
reserved concurrency is zero. The dedicated role has only isolated table/log
permissions. No shared Catalog, Commerce, Operations, financial, media, SSM,
notification or public customer routes are included.

Proposed existing initializer role:
`arn:aws:iam::302154194958:role/aws-reserved/sso.amazonaws.com/us-east-2/AWSReservedSSO_AdministratorAccess_e072fc27fb82916d`.
Its use as the exclusive initializer requires explicit approval. Verify actual
resource-policy enforcement and use one operator session, with no concurrent
initializer or policy edits. The existing initializer verifies the exclusive deny,
strongly scans for emptiness, rechecks policy revision and conditionally writes
only the existing version-1 READY marker. Any records or changed policy stop it.
No managed initializer launcher is provided. DynamoDB Local does not prove IAM.

After initialization, separately review and authorize a CloudFormation update
limiting writers to the dedicated catalog role and setting reserved concurrency
to **2**. No maintenance writer is proposed. This activation template is not
implemented or authorized here. No shared-catalog migration is required.

## Restricted frontend and acceptance

After separate approval, change only `admin-dev-3b23b18`:
`ADMIN_CATALOG_MODE=isolated` and `ADMIN_API_BASE_URL` to the new stack's
`AdminApiBaseUrl` output. Preserve the exact origin, Cognito region/client,
`ADMIN_SESSION_KEY_PARAMETER`, Basic Authentication and existing SSR compute role
listed in [the foundation contract](ISOLATED_CATALOG_DEV.md#restricted-frontend-settings).
Keep `CHECKOUT_SUBMISSION_MODE=locked`, `STOREFRONT_API_BASE_URL=https://storefront.invalid`
and `STOREFRONT_CURRENCY=USD`. No session secret is retrieved or copied into a build.
Official PR #79 branding remains unchanged. Public main remains Job 9; restricted
Admin DEV remains Job 1 until a separately authorized release. Automatic builds,
automatic branch creation and PR previews must stay disabled.

After approved deployment and activation, use only synthetic Products/Drops to
verify Basic Authentication, Cognito administrator access, create/edit/reload,
slug collision and retry handling, draft prices/quantities/pickups and protected
saved preview. Verify unauthenticated/nonadmin rejection and no access through
public routes. Public checkout, payments, media and lifecycle operations remain
unavailable. Verify all five accepted Lambda hashes and payment admission false.
Managed concurrency/IAM and the actual Amplify artifact still need hosted evidence.

On any isolation, authorization or integrity discrepancy, stop acceptance. Under
separate rollback authorization restore prior restricted frontend configuration
and artifact, and pause the isolated Lambda with concurrency zero. Retain table,
logs, receipts and evidence; do not delete data or alter public/payment resources.
Synthetic cleanup requires its own exact-record approval.

## Fresh local validation and focused review

- Backend: 1,131 tests, 10 legacy artifact checks and 2 API packaging checks passed.
- Infrastructure: 141 tests passed, including both fixed artifact types, identity
  mismatch rejection, isolated uncertain-write recovery and opaque VersionIds.
- Frontend: 590 tests, type checking, lint and production build passed.
- Backend/infrastructure type checking, formatting and diff checks passed.
- DynamoDB Local isolated initialization/product/draft/preview scenario passed.
- Two isolated ZIP builds were byte-identical. The offline template's 21 resources
  are identical to the 1N-A template; only ArtifactVersion's constraint changed.
  Ordinary offline synthesis also passed.
- Focused review found no remaining confirmed defect in artifact identity,
  publication safety, data isolation, administrator authorization, initial writer
  quarantine or resource scope. No backend, frontend, accepted artifact manifest,
  payment configuration, dependency or workflow changes are included.

AWS documents `MaxLength` as a character constraint, supporting the separate
UTF-8 byte validation: [CloudFormation parameter properties](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html).
