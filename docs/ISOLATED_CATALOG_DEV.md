# Isolated Product and Drop DEV foundation — 1N-A

Source implementation only. No AWS writes, publication, deployment, readiness
activation or hosted acceptance is authorized by this checkpoint. Public main
hosting remains Job 9; restricted Admin DEV remains Job 1. Payment admission
remains disabled. All five accepted Lambda artifacts are preserved. Hosted
duplicate-activation acceptance remains NOT PASSED.

## Exact proposed resource delta

New independent stack `batch-and-batter-dev-isolated-catalog`, account
302154194958, region us-east-2; no changes to `DevelopmentStack`:

- One DynamoDB table `batch-and-batter-dev-isolated-catalog`, string PK/SK,
  on-demand billing, encryption, PITR, deletion protection and retain policy.
  No GSIs, existing records, shared catalog reference, Commerce or Operations.
- One Lambda `batch-and-batter-dev-isolated-catalog`, Node 24, x86_64,
  512 MiB, 30 seconds, `handler.handler`, initially concurrency **zero**.
- One execution role and inline policy: GetItem, Query, Scan, PutItem,
  DeleteItem, ConditionCheckItem on that table only; CreateLogStream/PutLogEvents
  on its retained 30-day log group. No payment, S3, SQS, scheduler or SSM rights.
- One HTTP API, JWT authorizer reusing the existing Cognito pool/client,
  integration, default stage, scoped Lambda invocation permission and **11 JWT
  routes**. Routes are enumerated in `backend/src/isolated-catalog-contract.ts`.
  No public routes, CORS, function URL, cart, payment, media or lifecycle routes.

The initial resource policy denies writes by everyone except the explicitly
approved initializer role. The role is a required parameter, not created or
granted rights here. ArtifactKey and ArtifactVersion are required immutable
publication inputs; there are no deployable placeholder code defaults.

Offline synthesis (after compilation):
`cdk synth --lookups=false --app 'node dist/infra/bin/isolated-catalog.js'`.
The ordinary application stack and blocked deploy command remain unchanged.
The existing API-only Code-change builder is not broadened to deploy this stack.

## Empty catalog initialization

`initializeIsolatedCatalog` has no executable AWS launcher. It reads the exact
new table's resource policy, verifies the exclusive writer deny, strongly scans
for any record, rechecks policy revision, then conditionally inserts only the
existing version-1 READY marker. Unexpected records, absent/changed protection,
or existing readiness fail closed. It cannot target the shared table.

A future authorized operator must use the approved initializer role exclusively,
with no concurrent initializer session; do not change the policy during the
procedure. DynamoDB scan and Put are not an atomic empty-table transaction.
The enforceable writer quarantine, paused Lambda and exclusive operator window
are therefore mandatory. Verify actual IAM/resource-policy enforcement first.

After initialization, a **separately reviewed CloudFormation update** must replace
quarantine with a policy permitting only the dedicated catalog role (plus an
explicitly approved maintenance principal, if needed), and set bounded Lambda
concurrency. No automatic gate-opening function or deployment flag is provided.
No shared-catalog backfill or historical migration is needed or authorized.

DynamoDB Local exercises real persistence/transactions but not IAM. Its policy
responses are explicit synthetic fixtures; this is not managed-AWS acceptance.

## Restricted frontend settings

Apply only to `admin-dev-3b23b18`, after separate approval:

- `ADMIN_CATALOG_MODE=isolated`
- `ADMIN_API_BASE_URL=<new stack AdminApiBaseUrl>`
- `ADMIN_ORIGIN=https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com`
- `ADMIN_COGNITO_REGION=us-east-2`
- `ADMIN_COGNITO_CLIENT_ID=mnvhvb6s87q5hsscdmjj59pv`
- `ADMIN_SESSION_KEY_PARAMETER=/batch-and-batter/dev/admin/session-key`
- `STOREFRONT_API_BASE_URL=https://storefront.invalid`
- `STOREFRONT_CURRENCY=USD`
- `CHECKOUT_SUBMISSION_MODE=locked`

Preserve Basic Authentication, existing SSR role and SSM-backed key. No plaintext
key enters build artifacts. The build allowlist rejects isolated mode on other
branches, public storefront paths, unlocked checkout or the shared API.
Public main settings remain unchanged. Authenticated preview is
`/admin/drops/<id>/preview`; it fetches the protected saved DRAFT composition,
never the public API, and mounts no cart/waitlist/payment controls. Unsaved edits
are excluded. Existing lifecycle controls are unavailable in isolated mode and
the new API rejects them regardless of frontend configuration.

## Artifacts and future release

`node backend/scripts/build-api.mjs --isolated-catalog` reuses deterministic ZIP
packaging and emits `backend/dist/isolated-catalog-release/`. The dependency
closure rejects financial, cart, media and dispatch modules. The existing API
artifact path and all accepted manifest entries are unchanged.

Before any publication: review artifact hash/lock/dependency evidence, obtain an
exact UUID/hash key and version approval, activate only the existing create-only
publisher's necessary grant under separate authorization, conditionally PUT once,
verify checksum/version and retain its receipt. No publisher activation or upload
is implemented here. Historical dependency exceptions confer no approval.

Then separately authorize the quarantined isolated stack; verify no existing
resources change; initialize under the exclusive gate; review/authorize gate and
concurrency update; change only restricted frontend configuration and release
its reviewed artifact. Automatic Amplify builds/previews remain disabled.

## Hosted acceptance and rollback — not executed

Use approved synthetic records. Verify Basic Authentication, Cognito access-token
and group enforcement; create/edit/reload Product, verify duplicate slug rejection
and creation retry; create/save/reload draft with prices, quantities and pickups;
open protected preview and verify saved descriptions, status, planned quantities,
responsive official branding, favicon and keyboard focus. Verify unauthenticated
preview, public Drop reads, carts, reservations, payments, waitlists, publication
and media writes fail. Confirm public Job 9 has no synthetic records, backend
payment admission false, financial artifact identities unchanged, no Stripe or
provider activity. Confirm no browser credentials or business binaries stored.

Stop on any isolation/authentication/integrity discrepancy. Restore the previous
restricted frontend/configuration and pause the dedicated function through an
approved stack update. Retain the table/logs and investigate; do not delete shared
records or discard evidence. Synthetic cleanup is a separate exact-record action.
Media processing/private delivery and customer publication remain the next release.

## Local evidence for this checkpoint

- Frontend: 590 tests, type check, lint and production build passed.
- Backend: 1,131 tests; ten legacy artifact checks plus two API packaging checks.
- Infrastructure: 134 tests; ordinary and isolated offline synthesis succeeded.
- DynamoDB Local: isolated end-to-end scenario, 12 Product-integrity groups and
  weekly draft concurrency/persistence scenario passed. No AWS calls.
- Browser: saved draft reloaded with $4.25 price, 18 planned cookies and three
  16:00–19:00 pickup windows. Desktop (1280px) and mobile (375px) had no horizontal
  overflow. Logos/submark loaded, favicon referenced, visible keyboard focus;
  preview contains no action buttons. This used the explicitly local synthetic
  preview; Cognito/Basic Authentication and managed-AWS policy enforcement still
  require actual hosted acceptance.
- Approved assets are copied byte-for-byte from the local kit; no generated
  photography or dependency changes. Original testing workspace preserved.

The isolated template adds 21 resources: Catalog, Logs6819BB44,
CatalogRole0D3BB0F5, CatalogRoleDefaultPolicy177B9A56, CatalogApi, Api,
AdminAuthorizer, Integration, Route0–Route10, Stage, GatewayInvoke.
No existing application resource is changed or removed.
