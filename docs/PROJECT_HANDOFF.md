# Batch & Batter — Project Development Handoff

Last reviewed: **October 9, 2026 (America/Denver)**. Documentation-only checkpoint; no cloud inspection or hosted execution performed for this update.

## October 14, 2026 — 1B-1A integration review follow-up

This later review supersedes the validation gaps in the implementation entry
below. Branch and baseline remain `codex/admin-product-integrity-1b1a` and
`1987371c27efdb3acc2317b27c97e4834b8df551`. The initial 22-file change set was
preserved; two focused test files were added, for 24 uncommitted files. No commit,
push, AWS API call, deployment, live data write or migration occurred. The original
payment-testing worktree was not modified. Hosting statements below are historical,
not fresh AWS verification. Hosted duplicate-activation acceptance is **NOT PASSED**.

Verified defects corrected:

- A receipt arriving between a failed transaction's reconciliation and diagnostic
  reads could incorrectly produce SLUG_CONFLICT. A final durable receipt read now
  takes precedence over the apparent conflict.
- Transaction cancellations with validation reasons could be mislabeled as slug
  conflicts. Business diagnostics now require confirmed, positional conditional
  failures. Unknown timeouts and transaction conflicts remain ambiguous without a
  receipt; bounded retries preserve the identity. Unexpected cancellations fail
  closed through existing sanitized API errors.
- An uncertain/resumed browser creation could discard its pending key after a
  later non-ambiguous rejection. It now retains the key and frozen retry details
  until reconciliation. Recovery also respects session expiration/logout.
- Stale edits after rename now report PRODUCT_CONFLICT instead of an ownership
  inconsistency. Slug help text now describes inactive-cookie slug reservation.

Local integration engine: official AWS DynamoDB Local **3.3.1**, temporary
Amazon Corretto **21.0.12.1** for macOS arm64, under
`/tmp/bb-integrity-dynamodb-local`. Both archives were downloaded over verified
HTTPS from official AWS distribution links and checked against official SHA-256
files before extraction/execution:

- DynamoDB archive: `f80bcec477f85f57e2c77f8d54aa6b672a8403fceff0c450560aee1cf6c21163`.
- Corretto archive: `8594556550766865662411ef3a7a71a66df9a9065f28a7b318a5352bda91b6a4`.

The temporary launcher bound Jetty to **127.0.0.1:18765 before starting**;
`lsof` confirmed loopback-only listening. In-memory mode, telemetry disabled,
synthetic records, explicit dummy credentials and no AWS profile were used.
[The opt-in integration script](../backend/scripts/test-product-integrity-local.mjs)
hardcodes the endpoint and checks hostname, port and protocol at the SDK request
boundary; it cannot silently fall back to AWS. It creates uniquely named local
tables and deletes them in cleanup. No project dependency or system runtime
installation was needed. Run `tsc` in `backend`, start the isolated engine as above,
then `node scripts/test-product-integrity-local.mjs`; do not run the live seed CLI.

**12 real-engine integration groups passed:** atomic creation; original replay;
changed-payload conflict; administrator scope; concurrent identical and competing
requests; inactive slug reservation; atomic rename/former-slug reuse; stale edits;
rollback; replay after edits; readiness and bad ownership; Product/receipt limits
(including an exact 358,400-byte receipt and one-byte-over rejection); internal
record filtering and pagination; readiness revocation at transaction boundary;
real commit followed by injected response loss; development seed prerequisites,
claims and rollback; empty filtered continuation; concurrent same-key different
payloads. Seed commands were remapped to isolated local test tables, never sent
to DEV. Product, owner, receipt and readiness keys do not overlap in a transaction.

[Six injected-failure tests](../backend/test/product-integrity-failures.test.ts)
cover late receipts, validation cancellation, transaction-conflict retry, ambiguous
timeouts with an occupied slug, and corrupted receipts. The first two regressions
failed before correction and passed afterward. The real-engine lost-response case
uses an injected transport failure after an actual local commit.

DynamoDB Local does not emit every managed-service conflict behavior and does not
model production throughput/timing. This is not proof of every production race.
See [AWS local usage notes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.UsageNotes.html),
[official distribution](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html)
and [Corretto downloads](https://docs.aws.amazon.com/corretto/latest/corretto-21-ug/downloads-list.html).

Synthetic browser checks passed: Add Cookie/automatic slug, duplicate warning,
same-identity lost-response retry with one record, navigation persistence, saved
slug rename, deactivation cancel/confirm, and full-reload recovery. Safari native
accessibility successfully handled both confirmation and before-unload dialogs.
The explicit preview `?recover&lost` mode retains only synthetic fixture state in
that tab's sessionStorage to model a durable backend across reloads; ordinary
preview reset modes still clear it. Production stores only the scoped operation
UUID, not fixture state or credentials. After reload, Add Cookie stayed disabled
until Check creation result recovered the original cookie. At 375px, document
width equaled viewport width with readable controls and no horizontal overflow;
keyboard Tab moved between labeled inputs and Enter expanded Advanced Details.
These checks are not a comprehensive accessibility audit or hosted acceptance.

Fresh validation: **462 frontend tests, 978 backend tests, 10 backend artifact
checks, and 12 local database integration groups passed**. Backend/frontend type
checks, frontend lint, backend build, frontend production build, formatting and
`git diff --check` passed. Prior 461/972/10 counts below are historical.
Infrastructure was unchanged; its prior 37 passing tests were not rerun.

Source-control disposition: **READY FOR SOURCE-CONTROL CHECKPOINT**, subject to
separate commit/push authorization and deployment-trigger verification. No
remaining verified application defect was identified. The historical catalog
backfill, duplicate-owner decisions, writer quiescence/retirement, complete
ownership verification and explicit readiness activation remain separate release
requirements. Receipts remain indefinite/no-TTL; pagination remains non-snapshot;
closing a tab/clearing storage requires manual catalog reconciliation before
recreating an uncertain operation. No live product-creation acceptance is granted.

## October 14, 2026 — 1B-1A local Product integrity implementation

Uncommitted local implementation on `codex/admin-product-integrity-1b1a`, based
on merged main `1987371c27efdb3acc2317b27c97e4834b8df551` (PR #59; post-merge
CI passed). No deployment, migration, readiness activation or business-data
writes occurred. Admin DEV remains Job 1; public main remains Job 9.

Product records retain their existing strict schema and IDs. New internal Catalog
items use `PRODUCT_SLUG#<sha256(canonicalSlug)> / OWNER`,
`PRODUCT_CREATE#<sha256(JSON([subject, lowercase UUID]))> / RESULT`, and
`PRODUCT_INTEGRITY#V1 / STATE`. Slug records store canonicalSlug and productId.
The readiness item must have `version: 1, state: READY`; missing/incomplete state
blocks writes. No implementation path creates this readiness item.

POST requires an Idempotency-Key UUID, scoped to authenticated Cognito subject
and Product creation. Receipt version 1 hashes fixed-order JSON
`[1,name,slug,description,ingredients,allergens,active]` after existing validation;
array order and meaningful text remain significant. The completed receipt stores
subject, normalized request key, version, hash, original Product and completion
time. Receipts have no TTL. Replays return the original 201 Product even after
later edits; different payloads return 409 IDEMPOTENCY_CONFLICT. Same display
names are allowed; inactive Products continue to own their slugs.

Creation transaction: readiness condition plus three conditional Puts (Product,
slug owner, receipt). Rename transaction: readiness condition, revision-protected
Product Put, new slug claim, owner-checked old slug Delete. Unchanged slugs require
an ownership condition. Stored canonical slugs are compared; digest/ownership
inconsistency fails closed. Occupied slugs return 409 SLUG_CONFLICT. Former slugs
are reusable after a successful rename. Reevaluate redirects before introducing
customer-facing slug URLs. Creation attempts reconcile a strongly consistent
receipt after errors and use bounded retries; no short-lived DynamoDB token is
used as the durable guarantee. Legacy unkeyed repository creates fail closed.

Safe size policy: at most 358,400 serialized UTF-8 JSON bytes per written Product,
owner or receipt item, and at most 1,048,576 aggregate serialized bytes checked
before writes. These conservative ceilings leave room below DynamoDB's 400-KiB
item and 4-MiB transaction limits. They intentionally reject some otherwise
storable large values, including large escaped strings, without truncation.
Oversize returns 413 PRODUCT_TOO_LARGE; no partial record or receipt is retained.
The Product edit path applies the same item ceiling. Existing larger records are
not rewritten or removed automatically. Existing frontend 4-MiB full-detail and
256-KiB list/auth transport limits remain unchanged.

Browser creation uses a UUID per Add Cookie editor. Frozen in-memory submission
fields and the same identity are reused after an ambiguous failure. Tab-local
sessionStorage holds only the UUID under an authenticated server-derived subject
scope hash; no fields, access tokens or session secrets are stored. Navigation or
reload offers receipt reconciliation through the existing protected catalog GET
with `creationKey`, or resumption with the original identity and reentered fields.
A different completed payload conflicts. Successful replay is followed by a fresh
Product detail read before editing. Closing the tab/clearing browser storage
loses the local reference: do not blindly recreate; reconcile the catalog first.
Independent intentional operations in other tabs are still separate operations.

The development seed transaction now also checks readiness and claims its Product
slugs atomically; its fixed IDs still prevent rerun overwrites. Its error report
now distinguishes prerequisite failure from an assertion that a record exists.
Drop/inventory seed values and ordinary Drop/inventory/payment behavior are not
changed. This does not authorize running the seed tool.

Required separate rollout: quiesce Product writers; inventory all existing
Products; detect duplicate slugs including inactive; obtain owner decisions;
conditionally backfill owners while checking revisions; verify complete ownership;
retire old writer deployments; activate readiness only after verification.
No live table scan or migration was run. Do not infer migration completeness from
ordinary catalog pagination. Pagination remains bounded, deduplicated in the UI,
and not a cross-page snapshot; fresh detail and revision checks protect edits.

Validation uses a synthetic serializable transaction model that checks all
conditions against one pre-commit state before applying writes. It exercises
races, rollback, lost responses, durable replay and readiness changes. It is NOT
DynamoDB Local or live DynamoDB proof. Docker is unavailable and the system Java
launcher reports no installed runtime. Real DynamoDB transaction integration
validation remains outstanding; no full service-concurrency claim is made.
Synthetic browser checks confirmed creation after a lost-response retry creates
one cookie, navigation persistence, and a clear duplicate-slug message. Remaining
visual rename/recovery checks were blocked by browser automation stalling on a
native discard dialog; automated rename/recovery coverage is recorded separately.
The preview remains loopback-only, outside Next routes/builds, with synthetic
fixtures; `?lost` demonstrates a committed create whose first response is lost.
Full preview reload resets its synthetic store and recovery reference, unlike
production's durable backend and tab-local recovery metadata.

Final local validation: **461 frontend tests, 972 backend tests, 10 backend
artifact checks passed**, zero failures/skips. Backend and frontend type checks,
frontend lint, backend artifact build, frontend production build, formatting and
`git diff --check` passed. Infrastructure files and IAM are unchanged; the prior
37-test infrastructure result was not rerun for this slice. No hosted tests ran.
The old Product single-Put assertions were replaced by transaction-level synthetic
coverage; unchanged Drop persistence tests remain. Before source-control approval,
review these 22 files and the outstanding real-DynamoDB/visual validation limits.

Exact changed-file inventory (relative to the MVP workspace):

- `backend/src/admin-catalog.ts`
- `backend/src/admin-writes.ts`
- `backend/src/api.ts`
- `backend/src/product-integrity.ts`
- `backend/src/repository.ts`
- `backend/test/admin-catalog.test.ts`
- `backend/test/admin-writes.test.ts`
- `backend/test/fixtures.ts`
- `backend/test/product-integrity.test.ts`
- `backend/test/repository-writes.test.ts`
- `backend/test/seed-errors.test.ts`
- `backend/test/seed.test.ts`
- `backend/tools/seed-dev.ts`
- `backend/tools/seed-plan.ts`
- `docs/PROJECT_HANDOFF.md`
- `web/scripts/preview-admin-products.mjs`
- `web/src/app/admin/products/page.tsx`
- `web/src/components/admin/products.tsx`
- `web/src/lib/admin/creation-state.ts`
- `web/src/lib/admin/product-client.ts`
- `web/src/lib/admin/products.test.ts`
- `web/src/lib/admin/server.ts`

No new AWS resources, table/index, IAM permissions, dependency upgrades, pricing,
media or Product schema fields. Product media remains 1B-2; per-Drop pricing and
inventory remain 1C. Hosted duplicate-activation acceptance remains NOT PASSED.

## October 14, 2026 — Admin DEV manual acceptance update

This later, scoped update supersedes the historical resumption point below for
this website development track only. Current assignment: local product-catalog
work on `codex/admin-product-catalog-1b1`, based on verified merged main
`3b23b18b3e5b4e9cbd902919cb8b0feb6f5a83b3`. No deployment or business-data
writes are authorized; hosted `admin-dev-3b23b18` remains unchanged.

The product owner reported these manual passes: Basic Authentication; Cognito
administrator login; protected `/admin` rendering; the no-Drop-assigned empty
state; Refresh updating the last-loaded timestamp; Sign Out returning to login;
and direct `/admin` navigation redirecting to login after sign-out. The owner
approved the existing visual design. These are operator-reported observations,
not newly repeated automated hosted tests.

Still untested/incomplete: approved nonadministrator rejection; natural
15-minute expiry; inventory/pickup accuracy with an assigned Drop; independent
verification of every upstream protected response; browser cookie attributes;
and authentication challenge variants not encountered. **Full administrator
acceptance is not established. Hosted duplicate-activation acceptance remains
NOT PASSED.** Preserve the separate payment-testing workspace and its unfinished
work; its historical harness resumption instructions are not this assignment.

## October 14, 2026 — 1B-1 targeted corrections (latest local status)

**LOCALLY VALIDATED — READY FOR REVIEW.** This update supersedes the earlier
1B-1 validation counts and preview/list-contract descriptions below. Branch
and base remain `codex/admin-product-catalog-1b1` /
`3b23b18b3e5b4e9cbd902919cb8b0feb6f5a83b3`; all 24 milestone files remain
uncommitted. No new schema, route, service, dependency or IAM change was needed
for these corrections.

- Creation derives a valid slug from the name, including accent normalization;
  names without ASCII letters/numbers receive the valid fallback `cookie`.
  Advanced Details contains optional manual editing and plain-language help.
  Manual customization stops automatic updates. Editing a saved Product never
  changes its slug merely because its name changes. Slug syntax is validated;
  **uniqueness is not guaranteed**, and no customer product URL is implied.
- The disappearing-cookie reproduction was preview-only: native sidebar links
  loaded a new document, recreating module-local fixtures. The preview now
  intercepts its own ordinary sidebar navigation and remounts the actual
  Products component against the same in-memory mock store. Its overview is
  explicitly a preview placeholder. Production navigation and backend reads
  are unchanged. Full browser refresh, a new tab, Empty/Error reset links, or
  restarting the preview still resets fixtures; modified-click/new-tab
  navigation is outside this single-document session. No browser storage or
  deployable demo-auth path was introduced.
- Catalog GET now returns summaries: ID, active status, name, description
  excerpt and explicit truncation flags. Name/description JSON strings are
  capped at 512/1,024 serialized UTF-8 bytes, including quotes and escaping,
  without splitting Unicode code points. All records from the bounded scan
  remain in the response, so the original continuation cursor is preserved.
  The 100-evaluated-record bound and empty-page behavior are unchanged.
  The frontend deduplicates IDs across pages and fetches full details for edits.
  Stored descriptions, ingredients and allergens are not truncated.
- The global 256-KiB JSON limit remains unchanged for lists/authentication.
  Authenticated full Product detail/write payloads alone use a **4-MiB cap**:
  a DynamoDB Product item can be up to 400 KiB and JSON escaping can expand
  string data sixfold; this cap leaves bounded envelope room. This is a
  transport ceiling, not permission to exceed DynamoDB item limits. Oversized
  requests return 413 before mutation; oversized upstream Product responses
  return an explicit error rather than an empty catalog. Existing same-origin,
  session, backend authorization and no-store protections still apply.
- Active-to-inactive saves require an accessible native confirmation explaining
  immediate live-Drop visibility/cart impact. Cancel sends no save. Reactivation
  may restore visibility where the Drop association remains active. Neither
  transition deletes inventory or historical orders. No new status restrictions.
- Duplicate-submit prevention covers concurrent UI submissions, **not server
  idempotency for independent POST requests**. Ambiguous saves still require
  reconciliation rather than blind retry. Scan pages are not a cross-page
  snapshot or a guaranteed sorted order. Prices remain per Drop; inventory
  stays in the Drop model; product media remains required in 1B-2 and per-Drop
  pricing/inventory management in 1C. MVP scope is unchanged.

Fresh validation: **455 frontend tests, 953 backend tests, 10 artifact checks,
37 infrastructure tests passed**, zero failures/skips. All three type checks,
frontend lint, frontend production build, backend build, formatting and
`git diff --check` passed. Regression coverage includes the 100-record oversized
response, compact Unicode/escaped boundaries with envelope/cursor overhead,
large full details and edits, exact 4-MiB/over-limit response boundaries,
pre-mutation oversized-request rejection, continuation, deduplication, mock
create/edit persistence followed by fresh list/detail reads, slug behavior and
deactivation-confirmation predicates. Browser checks separately verified
keyboard Advanced Details, automatic/manual/saved slugs, creation, edited data
surviving sidebar navigation, cancel/accept deactivation, and 375px layout
(document width 375px). These are local mock/synthetic checks, not hosted tests.

Exactly eight existing milestone files changed in this correction pass:
`backend/src/admin-catalog.ts`, `backend/test/admin-catalog.test.ts`,
`web/src/lib/admin/products.ts`, `web/src/lib/admin/products.test.ts`,
`web/src/lib/admin/server.ts`, `web/src/components/admin/products.tsx`,
`web/scripts/preview-admin-products.mjs`, and this handoff.

Preview restart: stop the prior preview process with Ctrl-C, then from the MVP
worktree run `node web/scripts/preview-admin-products.mjs` and open
`http://127.0.0.1:4175`. Add a cookie by name, optionally inspect Advanced Details,
save, navigate Overview → Products, then edit. Use an initially active fixture
to inspect/cancel/confirm deactivation. Everything is labeled synthetic and
remains in the browser document's memory; no AWS credentials are needed.

Next assignment: focused read-only review of these corrections and the complete
24-file milestone before separately authorizing a source-control checkpoint.
No commit, push, hosted action or AWS/business-data write occurred. The original
payment-testing workspace is untouched. Hosted duplicate-activation acceptance
remains **NOT PASSED**.

## October 14, 2026 — Milestone 1B-1 local implementation

**LOCALLY VALIDATED; uncommitted and undeployed.** Branch
`codex/admin-product-catalog-1b1` still has HEAD at
`3b23b18b3e5b4e9cbd902919cb8b0feb6f5a83b3`.

The owner approved preserving the existing Product schema: name, slug, one
reusable description, ingredients, allergens and active/inactive status.
The UI says **Price set per Drop**. No catalog price, media fields, fake images,
placeholder prices or database migration were introduced. Product media remains
required in 1B-2; pricing and per-Drop inventory remain required in 1C.

`/admin/products` now supports inactive-inclusive listing, explicit pagination,
refresh, loading/empty/error states, creation and editing. Existing protected
POST/PUT product contracts are reused; the browser sends an `updatedAt` revision
which the server forwards as `If-Match`. Stale revisions return 409 and the
existing conditional repository write protects the subsequent read/write race.
Legacy API clients without that optional header retain existing semantics.
New products default inactive. Saves affect only Product records, not Drop
associations, inventory, orders or payment snapshots. The form explains global
catalog-status impact, guards duplicate submissions and requires refresh after
an ambiguous save outcome rather than blindly retrying creation.

Two protected backend GET routes were added: `/admin/products` and
`/admin/products/{productId}`, with corresponding existing-Lambda API Gateway
routes. Listing uses one DynamoDB Scan with Limit 100 evaluated records per
request because the approved schema has no catalog-list index. Empty filtered
pages can carry a cursor; Load more continues explicitly. There is no unbounded
scan loop, new index or IAM expansion. This is not a snapshot across pages and
scan cost grows with the shared catalog table; the UI deduplicates IDs. Revisit
access-pattern design separately if volume makes this unsuitable.

Cognito access-token/admin-group enforcement, encrypted HttpOnly sessions and
server-only SSM key retrieval are preserved. Same-origin write checks, no-store
responses, sanitized failures and required browser edit revisions protect the
new same-origin proxy. Session expiry clears the catalog and cannot be blocked
by the unsaved-change navigation guard. No deployable preview-auth bypass exists.

Approved dashboard refinements: America/Denver timestamps, actionable no-Drop
explanation without a nonfunctional Create Drop button, and optional technical
details for internal IDs. The existing neutral design is retained.

Validation: **441 frontend tests, 949 backend tests, 10 backend artifact checks,
37 infrastructure tests passed**, with no failed/skipped tests. Frontend,
backend and infrastructure type checks passed; frontend lint and production
build passed; backend artifact build and offline CDK synthesis
(`--lookups=false`) passed. Formatting and `git diff --check` passed.
Synthetic browser checks covered create/edit persistence, unchanged ingredient
and allergen values, active/inactive display, blank-name validation, unsaved
change confirmation, keyboard focus/status/save controls, loading/empty/error
states, desktop rendering and a 375px viewport (document width also 375px).
These checks are local evidence, not hosted administrator acceptance.

Local preview: from the MVP worktree run
`node web/scripts/preview-admin-products.mjs`, then open
`http://127.0.0.1:4175`. It uses the actual UI with clearly labeled synthetic
in-memory fixtures, binds to loopback, blocks non-mocked fetches, and rejects
production mode. Refresh resets fixtures; Empty and Error links show those
states. It is outside Next routes/builds and needs no AWS credentials.

Changed-file inventory (24 files):

- Backend: `src/admin-catalog.ts` (new), `src/admin-writes.ts`, `src/api.ts`,
  `src/repository.ts`, `test/admin-catalog.test.ts` (new), `test/admin.test.ts`,
  `test/fixtures.ts`.
- Infrastructure: `lib/development-stack.ts`, `test/development-stack.test.ts`.
- Web: `src/app/admin/admin.css`, `src/app/admin/products/page.tsx` (new),
  `src/app/api/admin/products/route.ts` (new),
  `src/app/api/admin/products/[productId]/route.ts` (new),
  `src/components/admin/navigation.tsx` (new),
  `src/components/admin/products.tsx` (new),
  `src/components/admin/dashboard.tsx`, `src/components/admin/overview.tsx`,
  `src/lib/admin/products.ts` (new), `src/lib/admin/product-client.ts` (new),
  `src/lib/admin/products.test.ts` (new), `src/lib/admin/runtime.ts`,
  `src/lib/admin/server.ts`, `scripts/preview-admin-products.mjs` (new).
- Documentation: this handoff.

No commits, pushes, AWS operations, hosted changes or business-data writes were
performed. No dependency manifests changed. The original testing workspace's
three-file uncommitted diff fingerprint is unchanged:
`4acc509f1c3a70ee096e180d8540afdc3c2d39e47ef63a9062a1d8aa8085dc67`.
Next assignment: focused review of this local 24-file product-management change,
then separately authorized source-control checkpoint. Deployment requires its
own approval and narrow artifact/resource plan. Hosted duplicate-activation
acceptance remains **NOT PASSED**.

## 1. PROJECT IDENTITY

**Batch & Batter Cookie Co.** is an existing production-oriented direct-to-consumer cookie business application, not a new project. Limited inventory is sold through configurable weekly Drops with local pickup. The brand wordmark is “Batch & Batter,” with “Cookie Co.” as descriptor. The original approved feature scope and custom AWS + Stripe architecture remain in force. Low ongoing operating cost is a design constraint.

## 2. DOCUMENT PURPOSE AND AUTHORITY

This is the maintained continuity entry point for a new ChatGPT conversation, Codex session or engineer. It summarizes evidence; it does not grant execution authorization or replace requirements.

- [PRD v1.1 — APPROVED](PRD.md): product authority.
- [Technical Specification v1.1 — APPROVED](TECHNICAL_SPEC.md): technical authority, including its later C3A2 confirmation amendment.
- [Implementation Plan v1.0 — READY FOR IMPLEMENTATION](IMPLEMENTATION_PLAN.md): original sequencing and review framework, **not an accurate remaining-work checklist**.
- Later scoped acceptance records, [payment recovery amendments](PAYMENT_RECOVERY_RUNBOOK.md), [dependency decisions](DEPENDENCY_RISKS.md) and explicit human approvals qualify those historical checkpoints. Apply each only to its stated scope/artifact.

When sources conflict, retain both claims, identify their dates/scope and seek resolution before dependent execution. Do not silently rewrite requirements or infer acceptance. No applicable `AGENTS.md` was located in the repository/ancestor inspection for this checkpoint.

## 3. CURRENT DEVELOPMENT STATUS

Current phase: **MAINTAINED HOSTED-ACCEPTANCE RUNNER DEVELOPMENT**. Controller/adapter/executor, Runner 1A, Phase 1B-1A durable authorization and Phase 1B-1B-A synthetic closure evidence are merged, reviewed and locally validated. They are not integrated into a live hosted runner or deployed by these milestones. The October 7 duplicate-activation replacement remains **NOT PASSED**.

Latest recorded full Python validation: **277 passed, 0 failed, 0 skipped**. Phase 1B-1B-B design is **READY FOR INCREMENTAL IMPLEMENTATION**. Exact next task: **Assignment A — Synthetic SQLite Schema Version 2 and Ownership-Preserving Recovery States**, requiring separate implementation authorization. Cart and bounded financial acceptance do not establish production readiness or completion of the original product scope.

## 4. CURRENT REPOSITORY STATE

| Item                    | Recorded state                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository              | `/Users/jksn/Developer/batch-and-batter`                                                                                                     |
| Reviewed code baseline  | `main` / `ccf9b98ec22b9c5300c7e020588364e57acf37e4` at the October 9 documentation checkpoint; subsequent documentation commits advance main |
| Working-tree inspection | Clean before this documentation edit; only this handoff modified afterward                                                                   |
| This update             | Documentation-only publication authorized; harness milestones are tracked and merged                                                         |
| Toolchain               | Node 24.19.0; npm 11.11.0; web Next.js 15.5.27; see package/lock files for exact dependencies                                                |
| DEV identity            | AWS account `302154194958`, `us-east-2`, stack `batch-and-batter-dev`                                                                        |
| Last observed admission | Disabled, October 7 closeout; **not freshly verified October 9**                                                                             |

Last accepted mixed deployment, verified again in the October 7 replacement closeout:

| Functions                                        | Deployed ZIP SHA-256                                               |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| API and payment worker                           | `57a4c98fd6e773bd4b31aa53e248b0151376a85ea7640bb759f613ce5f4f5205` |
| Stripe webhook, expiry worker, expiry reconciler | `6697aafd6f62df7224ee22845578f44be908f430ed53bee74fce4f6cf690997c` |

Preserve this intentional mixed deployment. HEAD is not proof that all functions run its build. Hosting Job 9 is a separate artifact, SHA-256 `5ca85d05c8945f323f81f277603d2ca8e05094e96c04b3f0d488a42e56b5f151`; it is not a backend rollback artifact. Automatic hosting builds were disabled in the earlier recorded acceptance workflow. Separate read-only October 9 Amplify inspections verified main automatic builds and automatic branch creation disabled for the relevant DEV application at inspection time. No fresh Amplify inspection was performed during this documentation-only update. Future deployment-sensitive operations must evaluate current applicable settings; these dated observations do not establish perpetual deployment safety.

**Nonsecret identity discrepancy:** conversational instructions repeatedly said exact namespace `dev`. [Reviewed configuration](../infra/config/dev-payment.json), the runbook and later deployment evidence instead record `DevPaymentLedgerNamespace=dev:acct_1UL8xeDXKfaUH9bm`. Actual sandbox and ledger account binding are `acct_1UL8LdDz3QSwRsAl`. The later instruction was to preserve verified configuration byte-for-byte and use the approved manifest as source of truth. This document flags the discrepancy, not permission to normalize identity. `Environment=dev`, historical namespace and actual Stripe account are distinct concepts. No identity change is authorized.

## 5. APPROVED ARCHITECTURE

- Next.js/TypeScript customer web application on AWS Amplify; same-origin checkout routes mediate the backend contract.
- API Gateway HTTP API and Node.js/TypeScript Lambda; Cognito administrator authentication with backend authorization.
- DynamoDB on-demand Catalog, Commerce and Operations tables; conditional transactions protect inventory, ownership and settlement.
- Standard SQS with DLQs, expiry/payment workers, durable recovery and reconciliation; EventBridge scheduling for Drop opening and pickup-date work. Do not substitute per-Cart Scheduler jobs for the accepted queue approach.
- Stripe PaymentIntents, Payment Element and intended Express Checkout support. Automatic confirmation with **manual capture**, canonical provider verification and durable idempotent commands.
- CDK v2 infrastructure, SSM SecureString secrets, CloudWatch monitoring, S3 media; SES email and an SMS provider abstraction in approved scope. Provider/launch readiness is separate from payment acceptance.
- Prefer serverless low-idle-cost components. No VPC/NAT, persistent servers, Redis, WAF or added recurring service without a concrete need and explicit cost review. DEV, staging and production separation remains the planned operating model.

See [Technical Specification](TECHNICAL_SPEC.md) and [infrastructure source](../infra/lib/).

## 6. APPROVED PRODUCT DECISIONS

The [PRD](PRD.md) remains the full scope. Important continuity constraints:

- Configurable Drops; Sunday noon is a default, not mandatory automatic weekly creation. Pickup defaults Thursday–Saturday in America/Denver; customers select a pickup date, not appointment-capacity slots.
- Individual cookies with a `cookieUnits` abstraction for future packs; default per-order limit 12, configurable per Drop.
- First successful item reservation establishes one immutable eight-minute shopping deadline. Additions do not reset it; removals release inventory.
- First valid payment submission establishes one immutable four-minute customer payment window. Refreshes/tabs do not extend it. Backend recovery deadlines are different from the harness's 120-second admission limit.
- Guest checkout and secure order-management capabilities; no customer account requirement for MVP.
- Pickup changes default to 3 p.m. the preceding day; full-refund cancellation cutoff defaults to 24 hours before pickup start, with explicit admin exceptions and RESTOCK/DO_NOT_RESTOCK choices. Missed pickup does not automatically refund/restock.
- Paid-order confirmations, pickup reminders, consent-controlled SMS, waitlists, order management and admin operations remain required. Messaging failure must not invalidate a paid order; waitlist membership reserves nothing.
- Authoritative production pricing/tax decisions remain a launch gate. Synthetic DEV zero-tax/fee fixtures do not establish production tax policy.
- Mobile usability, accessibility and the approved visual direction remain required; bounded checkout acceptance is not broad accessibility certification.

## 7. IMPLEMENTATION MILESTONES

Statuses can coexist. **IMPLEMENTED** means code exists; **LOCALLY VALIDATED** means recorded local checks; **DEPLOYED** requires artifact evidence; **ACCEPTED** requires scoped acceptance. **PLANNED**, **BLOCKED**, and **UNKNOWN** are not completion claims.

| Milestone                                                                                                               | Evidence-based status and boundary                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog/admin APIs, Drop composition/publish/open/lifecycle                                                             | IMPLEMENTED; scheduled lifecycle has DEV ACCEPTED evidence in [5C1/5C2 record](PHASE_5C1_SCHEDULED_DROP_LIFECYCLE.md). Not proof of a full admin dashboard.                                     |
| Reservation engine, inventory transactions, expiry, customer Cart                                                       | IMPLEMENTED / DEPLOYED / ACCEPTED for [Phase 6A](PHASE_6A_CUSTOMER_CART_RESERVATIONS.md).                                                                                                       |
| Payment foundation, provider ingress, durable execution/settlement/recovery                                             | IMPLEMENTED / locally tested / DEPLOYED; acceptance is path-specific, not blanket completion.                                                                                                   |
| Hosted checkout UI and client submission lock                                                                           | IMPLEMENTED / DEPLOYED; [Phase 9A locked-admission UI ACCEPTED](PHASE_9A_CUSTOMER_CHECKOUT.md), with later financial records below.                                                             |
| DEV account/ledger separation                                                                                           | IMPLEMENTED / DEPLOYED / ACCEPTED stage-3 identity rollout; no ledger migration.                                                                                                                |
| Sanitized worker diagnostics and concurrency coverage                                                                   | IMPLEMENTED / LOCALLY VALIDATED / DEPLOYED within accepted artifacts; does not retrospectively prove old exception causes.                                                                      |
| Authentication-wait recovery correction                                                                                 | IMPLEMENTED / DEPLOYED / ACCEPTED for the scoped path and subsequent abandonment disposition.                                                                                                   |
| Hosted duplicate activation                                                                                             | BLOCKED / NOT PASSED; intended gesture evidence absent.                                                                                                                                         |
| Relock-v2 controller, transport adapter and AWS CLI executor                                                            | IMPLEMENTED / LOCALLY VALIDATED: 44 / 39 / 83 tests respectively; reviewed and merged in PR #51; not deployed or hosted accepted.                                                               |
| Runner 1A and Phase 1B-1A durable authorization                                                                         | REVIEWED / LOCALLY VALIDATED / MERGED in PR #52; 78 tests added; simulation-only and single-host storage. No ownership release.                                                                 |
| Phase 1B-1B-A synthetic evaluator                                                                                       | REVIEWED / LOCALLY VALIDATED / MERGED in PR #53; 33 evaluator tests. No live closure authority.                                                                                                 |
| Wallet/device acceptance, customer self-service, refunds/restock, messaging, waitlist, full admin UI, production launch | Original scope remains PLANNED or acceptance UNKNOWN/BLOCKED as applicable; no completion evidence established in this review. Inventory existing code/evidence before planning implementation. |

Current source includes storefront/checkout routes under [web/src/app](../web/src/app/), domain/workflow handlers under [backend/src](../backend/src/), and CDK under [infra/lib](../infra/lib/). Do not restart these completed foundations from the old phase plan.

## 8. ACCEPTANCE TESTING STATUS

| Scenario                                   | Disposition / proof boundary                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer Cart reservation/inventory        | Phase 6A live DEV PASSED, human approved October 5.                                                                                                                                                                                                                                               |
| Hosted checkout UI                         | Phase 9A PASSED October 6 with payment submission locked; not financial acceptance.                                                                                                                                                                                                               |
| October 7 hosted successful purchase       | Financial criteria PASSED. Original `acceptance-result.json` explicitly retains exact-fixture variance and human-review exceptions; later summaries call it successful. Do not claim an unqualified exact-fixture pass without a disposition. Historical worker-exception cause remains unproven. |
| Hosted intended decline                    | PASSED; canonical cancellation, zero financial effect, one release, normal closure.                                                                                                                                                                                                               |
| Hosted interactive 3DS success             | PASSED; one successful capture/settlement/outbox/inventory conversion. Replayed provider HTTP requests with matching idempotency keys were observed; one financial effect does not mean one HTTP request.                                                                                         |
| Hosted authentication abandonment retest   | PASSED by appended exception review; customer-visible expiry, canonical cancellation before release, zero captured funds and correct inventory. Original stop/inconclusive evidence remains preserved.                                                                                            |
| Obsolete payment DLQ disposition           | Operational closeout complete under targeted authorization; no continuing queue-mutation permission.                                                                                                                                                                                              |
| First duplicate-activation attempt         | UNTESTED; setup failed to reach activation within the required reservation boundary; preserved.                                                                                                                                                                                                   |
| October 7 duplicate-activation replacement | **NOT PASSED / INCONCLUSIVE**; no accepted start and no established double-click.                                                                                                                                                                                                                 |
| Relock-v2                                  | Latest recorded October 9 full Python result: 277 passed / 0 failed / 0 skipped (166 original components + 78 Runner/store + 33 evaluator). Local evidence only; final technical review did not rerun tests.                                                                                      |

Replacement timeline (October 7, America/Denver): verified enabled **21:13:17.609538**; relock procedure entry **21:15:17.614638** (+120.005100 s, 5.1 ms late); false-update request marker **21:15:19.443467** (+121.833929 s); verified false **21:15:23.668210** (+6.053572 s after entry). The old harness waited the full 120 seconds and then performed reads before update dispatch.

The sole API start arrived at **21:15:44**, second precision, and was rejected `503 PAYMENTS_DISABLED` at **21:15:45.103**. One token-creation HTTP request was recorded; SDK invocation count was not independently established. Physical gesture count/spacing were unconfirmed, and the retained DOM trace ended before the request. A combined browser filter's initial zero-count interpretation was corrected by endpoint-specific evidence. Accepted starts, Attempts, Intents, captures and settlements were zero. Rejection after relock supports the safety gate, **not duplicate-activation acceptance**.

Normal closure left Cart EXPIRED, Drop CLOSED, inventory **20 total / 0 reserved / 0 sold / 20 available**. No application defect or payment/inventory integrity compromise was demonstrated. This is bounded evidence, not proof all application behavior is defect-free.

## 9. ACTIVE BLOCKERS

- Duplicate activation remains unproven. Controller, adapter and executor corrections/reviews are complete locally. Maintained-runner integration, gesture evidence and readiness/instruction gating must precede any proposal for another hosted run. No additional hosted scenario is authorized.
- Relock-v2 has a locally validated transport adapter and concrete CLI executor, but no maintained hosted runner. Single-host durable synthetic claims and concurrency control are reviewed; cross-host exclusion, database closure, independent monitoring, critical escalation, report persistence and live caller integration remain outstanding. These are integration obligations, not newly confirmed application defects.
- Infrastructure dependency audit remains failing under a scoped DEV exception, not a passing audit. See [Dependency Risks](DEPENDENCY_RISKS.md). Expiration: **October 14, 2026, 17:00 America/Denver (23:00 UTC)**, with earlier termination for applicable fixed releases/new advisories/changed exposure or artifact/scope conditions. Historical extensions do not authorize a new artifact or scenario; applicability must be freshly reviewed when authorized.
- Other prolonged processing/retry paths retain a documented recursion limitation. Authentication-wait acceptance does not cover them.
- Production pricing/tax authority, wallets/devices, broader security/accessibility and later product/launch gates remain open or not verified.

## 10. CURRENT WORK

The tracked [relock-v2 README](../tools/hosted-acceptance/relock-v2/README.md) and source record these merged milestones:

| PR                                                        | Scope                                              | Squash commit                              |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| [#51](https://github.com/useffj/batch-and-batter/pull/51) | Controller, transport adapter and CLI executor     | `1535cd4ae838f86459b6f4a5187a1ccf2b87612c` |
| [#52](https://github.com/useffj/batch-and-batter/pull/52) | Runner 1A and Phase 1B-1A durable authorization    | `8ab68f3da7306071e8f3f833d44023821212cd32` |
| [#53](https://github.com/useffj/batch-and-batter/pull/53) | Phase 1B-1B-A synthetic closure-evidence evaluator | `ccf9b98ec22b9c5300c7e020588364e57acf37e4` |

All are source-control milestones, not deployments or hosted acceptance.

- [Controller](../tools/hosted-acceptance/relock-v2/admission_window.py): +100-second target and unchanged 120-second hard deadline from controller-owned verified enablement; separate entry, dispatch and verified-disabled timestamps; protective cleanup. Callback completion cannot restart the timer.
- [Transport](../tools/hosted-acceptance/relock-v2/transport.py) and [executor](../tools/hosted-acceptance/relock-v2/cli_executor.py): exact environment/RevisionId guards, bounded single attempts, post-callback deadline checks, profile normalization and credential-policy validation. Dispatch markers do not prove AWS receipt.
- [Runner 1A](../tools/hosted-acceptance/relock-v2/runner.py): reviewed local simulation orchestration, synchronized callback-entry/stop boundary and preserved primary/secondary exceptions. No hosted entry point or live component integration.
- [Authorization store](../tools/hosted-acceptance/relock-v2/authorization.py): reviewed schema version 1, explicit synthetic provisioning, atomic single-use claims, permanent consumption, exclusive resource ownership, restart persistence and event/allocator validation. Single designated local store only; no ownership release.
- [Synthetic evaluator](../tools/hosted-acceptance/relock-v2/closure_evidence.py): immutable typed records; operation completeness; participant quiescence; typed controller-result binding; causal ordering; integers in `1..2^63-1` with schema version exactly 1; conflicting evidence rejection and identical-duplicate idempotence; deterministic digests. Results are `SYNTHETIC_ELIGIBLE` / `SYNTHETIC_BLOCKED`, preserving historical critical codes for valid evidence. No SQLite ownership release, live authorization, AWS disabled-state verification, durable replay prevention or hosted acceptance follows from eligibility.

Latest recorded full Python suite: **277 passed / 0 failed / 0 skipped** — 166 controller/adapter/executor tests, 78 Runner/authorization additions and 33 evaluator tests. The source-control checkpoint reran this suite in 2.996 seconds before committing the unchanged files:

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

The most recent technical review did not rerun the suite; neither did this documentation update. [Post-merge CI run 38002707570](https://github.com/useffj/batch-and-batter/actions/runs/38002707570) was freshly verified completed with validate, validate-backend and validate-infra all PASSED for `ccf9b98`. GitHub Actions does **not** execute the Python harness suite; adding suitable Python CI coverage remains separately scoped work. [VALIDATION.txt](../tools/hosted-acceptance/relock-v2/VALIDATION.txt) is an older preserved local checkpoint. README wording awaiting review is superseded by the completed focused reviews in the October 9 conversation.

Historical external evidence and checksums remain immutable. No merged harness milestone retroactively changes the unsuccessful hosted scenario.

Remaining integration limitations and obligations:

- Verify executable provenance/version, approved AWS account/principal/resource identity and noninteractive SSO/session readiness before admission enablement. The October 7 DLQ closeout records CLI 2.36.47 historically; the final review did not establish the current packaged CLI/Botocore version. A profile name or SSO account setting alone is not caller-identity proof.
- Credential files may change after validation; validation and subprocess use are not atomic. OS scheduling can delay launch after the final deadline check.
- Process termination cannot cancel an AWS request already transmitted. Indefinitely blocked callbacks require independent monitoring and escalation.
- Actual Lambda update-response compatibility and propagation remain unverified; do not fabricate fields or weaken configuration guards.
- Critical reports need protected durable persistence; single-window authorization must survive concurrency/restarts. Human-facing Pay instructions must be protected against stop/authorization races.

## 11. EXACT NEXT ENGINEERING TASK

**PHASE 1B-1B-B — ASSIGNMENT A: Synthetic SQLite Schema Version 2 and Ownership-Preserving Recovery States.** The design is READY FOR INCREMENTAL IMPLEMENTATION; coding requires separate authorization.

The bounded first assignment is limited to `authorization.py`, `test_authorization.py` and the relock-v2 README. It must provide:

1. Explicit schema-v2 initialization with fixed `SYNTHETIC_ONLY` purpose and a separate synthetic resource namespace.
2. Preservation of version-1 stores; incompatible versions fail closed. No automatic migration, replacement database or claim reset.
3. Recovery-state support for CLAIMED, CLEANUP_REQUIRED and RECOVERY_REQUIRED. Reserve CLOSED_DISABLED for later guarded closure; Assignment A must not expose that transition or release ownership.
4. Permanent authorization consumption and historical execution retention, separating historical resource identity from exclusive unresolved ownership.
5. Transactional expected-version/state checks, schema/store identity validation and event-sequence/allocator integrity, retaining filesystem and crash safeguards.
6. Deterministic local tests for state transitions, retained ownership, version incompatibility, concurrency, corruption and transaction rollback.

Assignment A excludes atomic ownership release, database-backed closure, live AWS integration, external evidence verification, independent monitoring and hosted testing. Durable evidence persistence (Assignment B) and atomic guarded synthetic closure (Assignment C) follow only after separately authorized implementation and review of their prerequisites. Synthetic eligibility must never release actual hosted authority.

Future live integration still requires identity/session and artifact preflight; controller verification handoff at actual completion; unchanged relock deadlines; shared stop propagation; protected reports; independent monitoring and critical escalation; and separately validated gesture capture and human-readiness/instruction gating. No dependency exception or local milestone grants permission to enable admission, create fixtures or submit payments.

## 12. REQUIRED FUTURE ACCEPTANCE WORK

After separately scoped maintained-runner development, browser gesture capture and human-readiness coordination still need **separately scoped corrections and local validation**. Do not infer two physical gestures, token SDK invocations, HTTP requests or accepted starts from one Intent. Instrumentation must be passive, protected and established before reservation; payment requests are not instrumentation probes.

Only after those gates may a newly authorized replacement be proposed. Prior authorization is consumed; this handoff grants none. The proposal must retain the original bounded controls: one authorized fixture/Cart, freshly valid pickup and authoritative pricing, at least **300 unrounded seconds** remaining at the approved activation checkpoint, one coordinated rapid double-click with observed timing, immediate relock on acceptance/ambiguity/stop and dispatch before the hard deadline. Do not reuse expired October 8 pickup timing.

Separately establish gestures, token creation, browser/API requests, accepted starts, Attempt/Intent count, provider replay/idempotency, capture, settlement/outbox and inventory conversion. Preserve the approved maximum financial outcome, normal Drop closure, paid history/SOLD inventory on success, and bounded transport/health observation. Stop without an automatic replacement if a gate fails. Reuse closed acceptance evidence unless a concrete change justifies repetition. Broader product acceptance remains governed by the PRD/spec and scoped phase records.

## 13. SECURITY AND DATA INTEGRITY

Inventory and settlement authority is backend transactional state plus canonical Stripe evidence, never a browser success screen or timeout. Unknown financial outcome retains reservation responsibility; technical expiry alone does not permit release. Admission blocks new starts while compatible continuation/recovery remains available for accepted work. See [Payment Recovery Runbook](PAYMENT_RECOVERY_RUNBOOK.md).

Do not manually edit DynamoDB, retry capture, create replacement Intents, release/reset inventory, erase history, or delete/replay queue work to recover a payment. Prior targeted DLQ approval was exhausted. Preserve idempotency, token ownership, durable command/work records and actual-account binding independently from the historical namespace.

Last October 7 replacement closeout: all seven queues/DLQs empty, 32/32 alarms OK, recovery heartbeats healthy, unresolved responsibility zero, admission false. These are dated observations, not present health guarantees. Readback confirms configuration, not the end of every in-flight request.

Keep credentials, tokens, card data, customer contact details, raw provider payloads and sensitive configuration out of this file/log summaries. External artifacts may be sensitive; inspect selectively and redact exports. Unresolved historical gaps include the first successful payment's worker exception, earlier HTTP 401 cause, and missing duplicate-gesture evidence. No speculative application fix follows from those gaps.

## 14. DEVELOPMENT GOVERNANCE

**ChatGPT -> Codex -> Implementation/Test -> Codex Report -> ChatGPT Review -> Next Task**

Work from approved requirements and current evidence. Define bounded scope and acceptance before implementation; report changes, validation, limitations and review needs. The original plan's PLAN/BUILD/EXPLAIN/TEST/REVIEW/COMMIT/CONTINUE cycle does not override a task's explicit no-commit or read-only boundary.

[CI](../.github/workflows/ci.yml) checks web formatting/types/lint/tests/build; backend types/tests/artifacts and audit; infrastructure types/tests/synthesis without lookups. It does not deploy, and infrastructure audit is not a CI step. [Amplify build configuration](../amplify.yml) is separate. Post-merge CI was freshly verified as recorded in section 10; passing CI does not prove hosted acceptance or a clean infrastructure audit. Python harness CI coverage remains outstanding.

Cloud changes, deployments, admission windows, financial tests and destructive cleanup require their specific approved scope. Do not infer authorization from this handoff, an old script or a still-unexpired dependency exception. Flag proposed recurring cost before adding a service. This update authorizes a documentation-only commit and normal push of this file; it grants no engineering implementation or hosted-execution authorization.

## 15. CRITICAL DECISIONS NOT TO REVERSE

| Decision                                                                          | Authority                                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Retain original feature scope and custom AWS + Stripe; no platform redesign       | [PRD](PRD.md), [Technical Specification](TECHNICAL_SPEC.md), current human direction                  |
| Atomic inventory, immutable reservation/payment deadlines, canonical settlement   | [Technical Specification](TECHNICAL_SPEC.md), [Recovery Runbook](PAYMENT_RECOVERY_RUNBOOK.md)         |
| Automatic confirmation/manual capture; recovery owns ambiguous financial outcomes | Spec C3A2 amendment and recovery runbook                                                              |
| Preserve actual account binding separately from immutable historical namespace    | [DEV configuration](../infra/config/dev-payment.json), runbook identity amendment, stage-3 acceptance |
| Preserve accepted mixed artifacts; do not homogenize by ordinary deployment       | Authentication-wait acceptance and replacement closeout                                               |
| Retain 120-second maximum; schedule early rather than weaken it                   | Replacement closeout and [relock-v2 contract](../tools/hosted-acceptance/relock-v2/README.md)         |
| No acceptance claims from merged code/local tests or post-relock rejection        | Scoped phase records and replacement closeout                                                         |
| Historical evidence and paid history are preserved                                | Recovery runbook and dated closeout records                                                           |
| Low idle cost; no unsupported dependency overrides/blanket exception              | Spec cost strategy and [Dependency Risks](DEPENDENCY_RISKS.md)                                        |

## 16. EVIDENCE AND REFERENCE INDEX

Repository references above are relative to this file. Additional implementation/test anchors:

- [Financial settlement](PHASE_5B2B_FINANCIAL_SETTLEMENT.md), [local acceptance client and amendments](PHASE_5B2C3A_LOCAL_ACCEPTANCE_CLIENT.md), [abandonment readiness](PHASE_5B2C3D1_ABANDONMENT_READINESS.md).
- [Backend tests](../backend/test/), notably `cart.test.ts`, `expiry.test.ts`, `payment-execution.test.ts`, `payment-settlement.test.ts`, `payment-transport.test.ts`, `payment-diagnostics.test.ts`.
- [Infrastructure admission tests](../infra/test/admission-deploy.test.ts), [payment infrastructure tests](../infra/test/payments.test.ts), [browser checkout tests](../tools/checkout/browser.test.cjs), and relock-v2 files in section 10. Presence is not a new passing test claim.
- Commit anchors: `7a293a7` hosted UI checkpoint; `16df413` Pay focus; `141f007` ledger merge; `530dad0` diagnostics merge; `0203b25` authentication-wait merge. Use `git show <commit>` locally. Merged harness anchors and current CI verification are in section 10.

**External evidence — not committed to this repository.** Base directory:
`/Users/jksn/.codex/artifacts/batch-and-batter/`

| Path relative to external base                                                                                                                         | Use                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `dev-ledger-stage3-completion-20261007/stage-3-acceptance.json`                                                                                        | Accepted identity rollout and historical preservation                              |
| `hosted-single-payment-20261007/acceptance-result.json`                                                                                                | Successful financial result and retained fixture/exception qualifications          |
| `hosted-single-decline-20261007/acceptance-report.txt`                                                                                                 | Scoped decline pass and explained retry                                            |
| `hosted-single-3ds-success-20261007/acceptance-report.txt`                                                                                             | Scoped 3DS pass, provider replay versus effect counts                              |
| `authentication-wait-approved-execution-20261007/acceptance.json`                                                                                      | API/worker artifact acceptance; its then-unresolved transport status is historical |
| `hosted-abandonment-retest-exception-review-20261007/review-disposition.txt`                                                                           | Later abandonment/transport PASSED disposition                                     |
| `obsolete-payment-dlq-disposition-retry-20261007/closeout-report.txt`                                                                                  | Later targeted operational closeout                                                |
| `hosted-duplicate-activation-preparation-20261007/scenario.txt`                                                                                        | Historical bounded scenario contract, not reusable authorization                   |
| `hosted-duplicate-activation-execution-20261007/closeout-report.txt`                                                                                   | Original UNTESTED attempt                                                          |
| `hosted-duplicate-activation-replacement-20261007/closeout-report.txt`                                                                                 | NOT PASSED replacement; corrected evidence counts and final health                 |
| Same replacement directory: `admission-window.py`, `common.py`, `checkout-gate.py`, `test-admission.py`, `validate-admission-request.py`, `SHA256SUMS` | Historical runner/reference inputs; inspect as text, do not execute or edit        |

Transfer/access to external evidence must be arranged separately for another workstation; repository access alone is insufficient. Do not bulk-copy potentially sensitive evidence into Git.

## 17. RECENT DEVELOPMENT HISTORY

- Earlier phases established catalog/Drop lifecycle, reservations and durable payment recovery. The old local acceptance client has its own scoped financial history; it is not hosted customer-site proof.
- October 5: customer Cart live acceptance and hosting/security work recorded.
- October 6: locked hosted checkout UI accepted; submission/phone UX and Pay-focus corrections recorded. Governing Phase 9 remained incomplete.
- October 7: explicit ledger/account rollout accepted; hosted financial success, decline and 3DS records created; diagnostics improved explanation of later contention without proving the earlier exception.
- October 7: authentication-wait correction deployed to API/worker only; abandonment retest later passed after exception review; obsolete DLQ targeted closeout completed.
- October 7: first duplicate attempt remained UNTESTED; replacement missed relock entry by 5.1 ms and did not establish the intended gesture. Normal cleanup completed.
- October 9: initial relock-v2 deadline correction recorded 31 tests; verified timestamp-handoff correction expanded controller coverage to 44. Transport adapter and concrete CLI executor brought local coverage to 122.
- October 9: post-callback expiry and effective credential-profile corrections brought coverage to 150; profile-header normalization/duplicate-alias correction added 16 tests, yielding 166 passed / 0 failed / 0 skipped.
- October 9: final targeted security review found no remaining demonstrated profile-header defect and classified the executor READY FOR MAINTAINED-RUNNER DEVELOPMENT. No suite rerun, deployment or hosted acceptance occurred in that review. That was the earlier handoff checkpoint, superseded by the merged milestones below.

- October 9: PR #51 merged the 166-test original harness; PR #52 merged Runner 1A and durable authorization, bringing the suite to 244.
- October 9: PR #53 merged the reviewed synthetic evaluator and its corrections, bringing the suite to 277. Post-merge CI passed all three jobs; Python tests remain local-only. Phase 1B-1B-B design is ready for incremental implementation; Assignment A is next and not yet authorized.

## 18. CURRENT RESUMPTION POINT

The reviewed code baseline at the October 9 documentation checkpoint is `ccf9b98ec22b9c5300c7e020588364e57acf37e4`, with PRs #51, #52 and #53 merged. Subsequent documentation commits advance main; this SHA is a historical reference, not a reset or rollback target. Current phase is **Maintained Hosted-Acceptance Runner Development**; recorded Python baseline is **277 passed, 0 failed, 0 skipped**. Exact next coding task is **Schema Version 2 — Assignment A**, as bounded in section 11, requiring separate authorization. No schema-v2 code exists yet.

Before resuming, inspect the current checked-out branch, HEAD and working tree; preserve any changes. `0203b25` and other historical commits are reference points, not reset or rollback targets. Do not repeat completed controller, adapter, executor, runner, authorization-store or evaluator reviews without new evidence. No hosted scenario, payment, fixture, configuration change, deployment or evidence mutation is authorized. Duplicate-activation acceptance remains **NOT PASSED**.

Known source conflicts/staleness to carry forward:

- Root [README](../README.md) describes an early implementation checkpoint and older dependency version; it is not current completion authority. The original phase sequence similarly cannot determine remaining work.
- Phase 9A's older pending ordinary-payment/3DS/decline/abandonment bullets must be read alongside later October 7 scoped records. Its wallet/production/broader gates are not closed by those records.
- Runbook headings such as “local, not deployed,” old shared ZIP identity and initial alert-subscription blockers describe earlier checkpoints; later rollout/closeout evidence establishes subsequent state. Operational recovery rules still apply.
- Successful-purchase summaries are broader than the original exact-fixture-qualified result; a separate unqualified disposition was not established in this review. Keep the financial pass and unresolved qualification distinct.
- Namespace shorthand versus full deployed namespace remains explicitly documented in section 4; do not change identity to make prose agree.
- Relock-v2 components and local adapter/executor composition are validated; maintained-runner integration, real AWS response compatibility and hosted acceptance are not. Older 31-test validation and README next-review wording are historical/superseded as explained in section 10. No fresh AWS/Stripe evidence was collected for this document; GitHub post-merge CI was verified. Local synthetic recovery work does not close live integration gaps.

## 19. HANDOFF MAINTENANCE PROCEDURE

Update this file after each reviewed implementation milestone, accepted deployment, scoped acceptance/stop, approved amendment or change to the next task. Record review date, branch/commit, working-tree exceptions, exact scope/status, source paths and unresolved gaps. Separate source, local validation, deployed artifact and accepted behavior every time.

Before updating, read the prior handoff and applicable governance, inspect current Git state, and locate later evidence. Link rather than duplicate requirements. Preserve historical stops and qualifications; append a later disposition with its authority instead of rewriting old evidence. Never store secrets or customer data here.

Refresh section 11 and the resumption point together. Check relative links, all 19 sections, status consistency and `git diff --check`; report the final working-tree state. Run tests or live checks only when the task authorizes/requires them, labeling dated results otherwise. Commit/push only when authorized. The next maintainer must stop at the task boundary and return a report for ChatGPT review.

Latest maintenance checkpoint: October 9, 2026, after PR #53 squash merge. Local and remote main matched `ccf9b98ec22b9c5300c7e020588364e57acf37e4`, working tree was clean before editing, and post-merge CI passed. Only this handoff was updated; its documentation-only commit and normal push were separately authorized after review. All 19 sections and repository-relative links were checked. Preserve the recorded 277-test local baseline separately from GitHub CI. Next implementation requires separate Assignment A authorization.
