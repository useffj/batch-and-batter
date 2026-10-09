# Batch & Batter — Project Development Handoff

Last reviewed: **October 9, 2026 (America/Denver)**. Documentation-only checkpoint; no cloud inspection or hosted execution performed for this update.

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

Current phase: **Hosted Duplicate-Activation Acceptance**. The October 7 replacement remains **NOT PASSED**. Relock-v2 is **IMPLEMENTED / LOCALLY VALIDATED**, but untracked and not integrated with a live hosted runner. Browser gesture evidence and human-readiness coordination remain separate work.

Cart reservation and several bounded hosted payment paths have acceptance evidence. This does not establish all checkout paths, all original product features, or production readiness. The final targeted executor security review is complete: **READY FOR MAINTAINED-RUNNER DEVELOPMENT**, with no remaining demonstrated defect in the corrected profile-header implementation. This disposition supports subsequent local development planning only; it does not establish hosted readiness or authorize runner implementation/live execution. Next milestone: **MAINTAINED HOSTED-ACCEPTANCE RUNNER DEVELOPMENT**, separately scoped and locally validated.

## 4. CURRENT REPOSITORY STATE

| Item | Recorded state |
| --- | --- |
| Repository | `/Users/jksn/Developer/batch-and-batter` |
| Reviewed pre-publication branch / HEAD | `main` / `0203b250e48489f2af63c7d7b6481d7b6c272c96` |
| Pre-publication working-tree inspection | `?? docs/PROJECT_HANDOFF.md` and `?? tools/hosted-acceptance/`; tracked tree clean |
| This update | Publishes only `docs/PROJECT_HANDOFF.md` under explicit approval; harness files remain untracked |
| Toolchain | Node 24.19.0; npm 11.11.0; web Next.js 15.5.27; see package/lock files for exact dependencies |
| DEV identity | AWS account `302154194958`, `us-east-2`, stack `batch-and-batter-dev` |
| Last observed admission | Disabled, October 7 closeout; **not freshly verified October 9** |

Last accepted mixed deployment, verified again in the October 7 replacement closeout:

| Functions | Deployed ZIP SHA-256 |
| --- | --- |
| API and payment worker | `57a4c98fd6e773bd4b31aa53e248b0151376a85ea7640bb759f613ce5f4f5205` |
| Stripe webhook, expiry worker, expiry reconciler | `6697aafd6f62df7224ee22845578f44be908f430ed53bee74fce4f6cf690997c` |

Preserve this intentional mixed deployment. HEAD is not proof that all functions run its build. Hosting Job 9 is a separate artifact, SHA-256 `5ca85d05c8945f323f81f277603d2ca8e05094e96c04b3f0d488a42e56b5f151`; it is not a backend rollback artifact. Automatic hosting builds were disabled in the recorded acceptance workflow; current remote settings were not rechecked.

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

| Milestone | Evidence-based status and boundary |
| --- | --- |
| Catalog/admin APIs, Drop composition/publish/open/lifecycle | IMPLEMENTED; scheduled lifecycle has DEV ACCEPTED evidence in [5C1/5C2 record](PHASE_5C1_SCHEDULED_DROP_LIFECYCLE.md). Not proof of a full admin dashboard. |
| Reservation engine, inventory transactions, expiry, customer Cart | IMPLEMENTED / DEPLOYED / ACCEPTED for [Phase 6A](PHASE_6A_CUSTOMER_CART_RESERVATIONS.md). |
| Payment foundation, provider ingress, durable execution/settlement/recovery | IMPLEMENTED / locally tested / DEPLOYED; acceptance is path-specific, not blanket completion. |
| Hosted checkout UI and client submission lock | IMPLEMENTED / DEPLOYED; [Phase 9A locked-admission UI ACCEPTED](PHASE_9A_CUSTOMER_CHECKOUT.md), with later financial records below. |
| DEV account/ledger separation | IMPLEMENTED / DEPLOYED / ACCEPTED stage-3 identity rollout; no ledger migration. |
| Sanitized worker diagnostics and concurrency coverage | IMPLEMENTED / LOCALLY VALIDATED / DEPLOYED within accepted artifacts; does not retrospectively prove old exception causes. |
| Authentication-wait recovery correction | IMPLEMENTED / DEPLOYED / ACCEPTED for the scoped path and subsequent abandonment disposition. |
| Hosted duplicate activation | BLOCKED / NOT PASSED; intended gesture evidence absent. |
| Relock-v2 controller, transport adapter and AWS CLI executor | IMPLEMENTED / LOCALLY VALIDATED: 44 / 39 / 83 tests respectively; untracked, not deployed or hosted accepted. Final targeted executor review: READY FOR MAINTAINED-RUNNER DEVELOPMENT. |
| Wallet/device acceptance, customer self-service, refunds/restock, messaging, waitlist, full admin UI, production launch | Original scope remains PLANNED or acceptance UNKNOWN/BLOCKED as applicable; no completion evidence established in this review. Inventory existing code/evidence before planning implementation. |

Current source includes storefront/checkout routes under [web/src/app](../web/src/app/), domain/workflow handlers under [backend/src](../backend/src/), and CDK under [infra/lib](../infra/lib/). Do not restart these completed foundations from the old phase plan.

## 8. ACCEPTANCE TESTING STATUS

| Scenario | Disposition / proof boundary |
| --- | --- |
| Customer Cart reservation/inventory | Phase 6A live DEV PASSED, human approved October 5. |
| Hosted checkout UI | Phase 9A PASSED October 6 with payment submission locked; not financial acceptance. |
| October 7 hosted successful purchase | Financial criteria PASSED. Original `acceptance-result.json` explicitly retains exact-fixture variance and human-review exceptions; later summaries call it successful. Do not claim an unqualified exact-fixture pass without a disposition. Historical worker-exception cause remains unproven. |
| Hosted intended decline | PASSED; canonical cancellation, zero financial effect, one release, normal closure. |
| Hosted interactive 3DS success | PASSED; one successful capture/settlement/outbox/inventory conversion. Replayed provider HTTP requests with matching idempotency keys were observed; one financial effect does not mean one HTTP request. |
| Hosted authentication abandonment retest | PASSED by appended exception review; customer-visible expiry, canonical cancellation before release, zero captured funds and correct inventory. Original stop/inconclusive evidence remains preserved. |
| Obsolete payment DLQ disposition | Operational closeout complete under targeted authorization; no continuing queue-mutation permission. |
| First duplicate-activation attempt | UNTESTED; setup failed to reach activation within the required reservation boundary; preserved. |
| October 7 duplicate-activation replacement | **NOT PASSED / INCONCLUSIVE**; no accepted start and no established double-click. |
| Relock-v2 | Latest recorded October 9 result: 166 passed / 0 failed / 0 skipped (44 controller, 39 adapter, 83 executor). Components locally validated; maintained-runner integration and live propagation remain unverified. Final review did not rerun tests. |

Replacement timeline (October 7, America/Denver): verified enabled **21:13:17.609538**; relock procedure entry **21:15:17.614638** (+120.005100 s, 5.1 ms late); false-update request marker **21:15:19.443467** (+121.833929 s); verified false **21:15:23.668210** (+6.053572 s after entry). The old harness waited the full 120 seconds and then performed reads before update dispatch.

The sole API start arrived at **21:15:44**, second precision, and was rejected `503 PAYMENTS_DISABLED` at **21:15:45.103**. One token-creation HTTP request was recorded; SDK invocation count was not independently established. Physical gesture count/spacing were unconfirmed, and the retained DOM trace ended before the request. A combined browser filter's initial zero-count interpretation was corrected by endpoint-specific evidence. Accepted starts, Attempts, Intents, captures and settlements were zero. Rejection after relock supports the safety gate, **not duplicate-activation acceptance**.

Normal closure left Cart EXPIRED, Drop CLOSED, inventory **20 total / 0 reserved / 0 sold / 20 available**. No application defect or payment/inventory integrity compromise was demonstrated. This is bounded evidence, not proof all application behavior is defect-free.

## 9. ACTIVE BLOCKERS

- Duplicate activation remains unproven. Controller, adapter and executor corrections/reviews are complete locally. Maintained-runner integration, gesture evidence and readiness/instruction gating must precede any proposal for another hosted run. No additional hosted scenario is authorized.
- Relock-v2 has a locally validated transport adapter and concrete CLI executor, but no maintained hosted runner. Durable single-window authorization, concurrency control, independent monitoring, critical report persistence and caller integration remain outstanding. These are integration obligations, not newly confirmed application defects.
- Infrastructure dependency audit remains failing under a scoped DEV exception, not a passing audit. See [Dependency Risks](DEPENDENCY_RISKS.md). Expiration: **October 14, 2026, 17:00 America/Denver (23:00 UTC)**, with earlier termination for applicable fixed releases/new advisories/changed exposure or artifact/scope conditions. Historical extensions do not authorize a new artifact or scenario; applicability must be freshly reviewed when authorized.
- Other prolonged processing/retry paths retain a documented recursion limitation. Authentication-wait acceptance does not cover them.
- Production pricing/tax authority, wallets/devices, broader security/accessibility and later product/launch gates remain open or not verified.

## 10. CURRENT WORK

The relock-v2 README (local-only, untracked: `tools/hosted-acceptance/relock-v2/README.md`) records the implemented, locally validated components:

- Controller (local-only, untracked: `tools/hosted-acceptance/relock-v2/admission_window.py`) and 44 controller tests (local-only, untracked: `tools/hosted-acceptance/relock-v2/test_admission_window.py`): +100-second relock target from verified enablement; unchanged hard 120-second deadline; controller-owned monotonic/UTC verification handoff; separate entry/dispatch/disabled timestamps; protective cleanup. Callback completion cannot restart the timer.
- Transport adapter (local-only, untracked: `tools/hosted-acceptance/relock-v2/transport.py`) and 39 adapter tests (local-only, untracked: `tools/hosted-acceptance/relock-v2/test_transport.py`): exact configuration/RevisionId preservation, executor-owned dispatch callback boundary and shared timeout budget. Late or ambiguous outcomes cannot become successful results.
- CLI executor (local-only, untracked: `tools/hosted-acceptance/relock-v2/cli_executor.py`) and 83 executor tests (local-only, untracked: `tools/hosted-acceptance/relock-v2/test_cli_executor.py`): bounded subprocess supervision, pinned profile/region/function, protected request input, explicit single-attempt behavior, process-group cleanup and sanitized failures. Callback recording is distinct from process launch, AWS receipt and verified relock.

Executor corrections close post-callback expiry followed by launch, incomplete effective credential-profile checks and the demonstrated alternate profile-header bypass. A final check of the original monotonic budget prevents launch at or beyond expiry. Config/credentials precedence is preserved; direct legacy and sso-session SSO remain supported. Botocore-compatible profile/session recognition handles tabs, whitespace, quoting and unusual prefixes; duplicate normalized names and malformed headers fail closed. Regression tests explicitly assert zero launches for rejected configurations and cover the original alias bypass in both orders.

Latest recorded validation: **166 passed / 0 failed / 0 skipped** (44 controller + 39 adapter + 83 executor), including four harmless isolated local Python subprocess supervision tests. Command:

```sh
python3 -B -m unittest discover -s tools/hosted-acceptance/relock-v2 -p 'test_*.py' -v
```

The final targeted security review did not rerun the suite and found no remaining demonstrated defect in the corrected profile-header implementation. Disposition: **READY FOR MAINTAINED-RUNNER DEVELOPMENT**. No tests were rerun for this documentation update. The older VALIDATION.txt (local-only, untracked: `tools/hosted-acceptance/relock-v2/VALIDATION.txt`) is a preserved earlier checkpoint, not the latest aggregate result. Review authority is the October 9 conversation; the README records the latest execution result but its recommendation for a subsequent review is now superseded by that completed review.

All harness files remain **untracked/local only**; references are labeled local repository paths, not GitHub links; these files are not included in this publication. Historical external scripts and SHA256SUMS remain immutable. None of these local milestones means deployed, hosted accepted or ready for a financial scenario. Browser gesture evidence and human-readiness coordination remain unimplemented separate gates.

Remaining integration limitations and obligations:

- Verify executable provenance/version, approved AWS account/principal/resource identity and noninteractive SSO/session readiness before admission enablement. The October 7 DLQ closeout records CLI 2.36.47 historically; the final review did not establish the current packaged CLI/Botocore version. A profile name or SSO account setting alone is not caller-identity proof.
- Credential files may change after validation; validation and subprocess use are not atomic. OS scheduling can delay launch after the final deadline check.
- Process termination cannot cancel an AWS request already transmitted. Indefinitely blocked callbacks require independent monitoring and escalation.
- Actual Lambda update-response compatibility and propagation remain unverified; do not fabricate fields or weaken configuration guards.
- Critical reports need protected durable persistence; single-window authorization must survive concurrency/restarts. Human-facing Pay instructions must be protected against stop/authorization races.

## 11. EXACT NEXT ENGINEERING TASK

**MAINTAINED HOSTED-ACCEPTANCE RUNNER DEVELOPMENT.** First define a bounded implementation assignment and local acceptance criteria; obtain separate implementation authorization. Resume from the completed controller/adapter/executor work rather than repeating their accepted investigations. No historical runner or AWS operation is authorized by this handoff.

The separately scoped runner must provide:

1. Preflight and approved execution identity, artifact/configuration checks and session readiness.
2. Integration with the existing relock controller, transport adapter and CLI executor without weakening their contracts.
3. Immediate recording of actual verified enablement through the controller-provided verification handoff.
4. One authoritative owner of relock timing and the unchanged +100-second target / 120-second hard deadline.
5. Durable, concurrency-safe single-window authorization and restart handling.
6. Shared stop signals and preserved failure reasons.
7. Independent safety monitoring and monitor-health checks.
8. Reliable critical-failure escalation, including indefinitely blocked operations.
9. Protected durable evidence/report persistence, including critical exceptions.
10. Protective cleanup and guarded fresh disabled verification, with separate entry, dispatch and confirmation evidence.
11. No Pay authorization without separately validated readiness and instruction gating.

Initial implementation and validation must be local-only with fakes/synthetic inputs and blocked cloud/payment operations. Browser gesture capture and human readiness remain separately scoped work. Neither this milestone nor the dependency exception authorizes live AWS execution, admission changes, fixtures or payments.

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

[CI](../.github/workflows/ci.yml) checks web formatting/types/lint/tests/build; backend types/tests/artifacts and audit; infrastructure types/tests/synthesis without lookups. It does not deploy, and infrastructure audit is not a CI step. [Amplify build configuration](../amplify.yml) is separate. Remote CI status was not refreshed here; passing CI would not prove hosted acceptance or a clean infrastructure audit. The new Python harness is not added to CI.

Cloud changes, deployments, admission windows, financial tests and destructive cleanup require their specific approved scope. Do not infer authorization from this handoff, an old script or a still-unexpired dependency exception. Flag proposed recurring cost before adding a service. This publication is explicitly authorized for this document only, to the verified private GitHub repository; it grants no engineering or hosted-execution authorization.

## 15. CRITICAL DECISIONS NOT TO REVERSE

| Decision | Authority |
| --- | --- |
| Retain original feature scope and custom AWS + Stripe; no platform redesign | [PRD](PRD.md), [Technical Specification](TECHNICAL_SPEC.md), current human direction |
| Atomic inventory, immutable reservation/payment deadlines, canonical settlement | [Technical Specification](TECHNICAL_SPEC.md), [Recovery Runbook](PAYMENT_RECOVERY_RUNBOOK.md) |
| Automatic confirmation/manual capture; recovery owns ambiguous financial outcomes | Spec C3A2 amendment and recovery runbook |
| Preserve actual account binding separately from immutable historical namespace | [DEV configuration](../infra/config/dev-payment.json), runbook identity amendment, stage-3 acceptance |
| Preserve accepted mixed artifacts; do not homogenize by ordinary deployment | Authentication-wait acceptance and replacement closeout |
| Retain 120-second maximum; schedule early rather than weaken it | Replacement closeout and relock-v2 contract (local-only, untracked: `tools/hosted-acceptance/relock-v2/README.md`) |
| No acceptance claims from merged code/local tests or post-relock rejection | Scoped phase records and replacement closeout |
| Historical evidence and paid history are preserved | Recovery runbook and dated closeout records |
| Low idle cost; no unsupported dependency overrides/blanket exception | Spec cost strategy and [Dependency Risks](DEPENDENCY_RISKS.md) |

## 16. EVIDENCE AND REFERENCE INDEX

Repository references above are relative to this file. Additional implementation/test anchors:

- [Financial settlement](PHASE_5B2B_FINANCIAL_SETTLEMENT.md), [local acceptance client and amendments](PHASE_5B2C3A_LOCAL_ACCEPTANCE_CLIENT.md), [abandonment readiness](PHASE_5B2C3D1_ABANDONMENT_READINESS.md).
- [Backend tests](../backend/test/), notably `cart.test.ts`, `expiry.test.ts`, `payment-execution.test.ts`, `payment-settlement.test.ts`, `payment-transport.test.ts`, `payment-diagnostics.test.ts`.
- [Infrastructure admission tests](../infra/test/admission-deploy.test.ts), [payment infrastructure tests](../infra/test/payments.test.ts), [browser checkout tests](../tools/checkout/browser.test.cjs), and relock-v2 files in section 10. Presence is not a new passing test claim.
- Commit anchors: `7a293a7` hosted UI checkpoint; `16df413` Pay focus; `141f007` ledger merge; `530dad0` diagnostics merge; `0203b25` authentication-wait merge. Use `git show <commit>` locally; no remote verification was performed.

**External evidence — not committed to this repository.** Base directory:
`/Users/jksn/.codex/artifacts/batch-and-batter/`

| Path relative to external base | Use |
| --- | --- |
| `dev-ledger-stage3-completion-20261007/stage-3-acceptance.json` | Accepted identity rollout and historical preservation |
| `hosted-single-payment-20261007/acceptance-result.json` | Successful financial result and retained fixture/exception qualifications |
| `hosted-single-decline-20261007/acceptance-report.txt` | Scoped decline pass and explained retry |
| `hosted-single-3ds-success-20261007/acceptance-report.txt` | Scoped 3DS pass, provider replay versus effect counts |
| `authentication-wait-approved-execution-20261007/acceptance.json` | API/worker artifact acceptance; its then-unresolved transport status is historical |
| `hosted-abandonment-retest-exception-review-20261007/review-disposition.txt` | Later abandonment/transport PASSED disposition |
| `obsolete-payment-dlq-disposition-retry-20261007/closeout-report.txt` | Later targeted operational closeout |
| `hosted-duplicate-activation-preparation-20261007/scenario.txt` | Historical bounded scenario contract, not reusable authorization |
| `hosted-duplicate-activation-execution-20261007/closeout-report.txt` | Original UNTESTED attempt |
| `hosted-duplicate-activation-replacement-20261007/closeout-report.txt` | NOT PASSED replacement; corrected evidence counts and final health |
| Same replacement directory: `admission-window.py`, `common.py`, `checkout-gate.py`, `test-admission.py`, `validate-admission-request.py`, `SHA256SUMS` | Historical runner/reference inputs; inspect as text, do not execute or edit |

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
- October 9: final targeted security review found no remaining demonstrated profile-header defect and classified the executor READY FOR MAINTAINED-RUNNER DEVELOPMENT. No suite rerun, deployment or hosted acceptance occurred in that review. This documentation update records that milestone only.

## 18. CURRENT RESUMPTION POINT

`0203b25` is the reviewed historical code baseline, not a reset or rollback target. Before resuming, inspect the current checked-out branch, HEAD and working tree, and preserve existing untracked relock-v2 files. Do not reset or roll back to the historical commit. **Batch & Batter v4 resumption: scope maintained hosted-acceptance runner development as described in section 11, then seek separate local implementation authorization.** Completed controller, adapter and executor investigations need not be repeated without a concrete contradiction. No additional hosted scenario, payment, fixture, configuration change, deployment or evidence mutation is authorized. The duplicate-activation result remains **NOT PASSED**.

Known source conflicts/staleness to carry forward:

- Root [README](../README.md) describes an early implementation checkpoint and older dependency version; it is not current completion authority. The original phase sequence similarly cannot determine remaining work.
- Phase 9A's older pending ordinary-payment/3DS/decline/abandonment bullets must be read alongside later October 7 scoped records. Its wallet/production/broader gates are not closed by those records.
- Runbook headings such as “local, not deployed,” old shared ZIP identity and initial alert-subscription blockers describe earlier checkpoints; later rollout/closeout evidence establishes subsequent state. Operational recovery rules still apply.
- Successful-purchase summaries are broader than the original exact-fixture-qualified result; a separate unqualified disposition was not established in this review. Keep the financial pass and unresolved qualification distinct.
- Namespace shorthand versus full deployed namespace remains explicitly documented in section 4; do not change identity to make prose agree.
- Relock-v2 components and local adapter/executor composition are validated; maintained-runner integration, real AWS response compatibility and hosted acceptance are not. Older 31-test validation and README next-review wording are historical/superseded as explained in section 10. No fresh cloud/remote CI evidence was collected for this document.

## 19. HANDOFF MAINTENANCE PROCEDURE

Update this file after each reviewed implementation milestone, accepted deployment, scoped acceptance/stop, approved amendment or change to the next task. Record review date, branch/commit, working-tree exceptions, exact scope/status, source paths and unresolved gaps. Separate source, local validation, deployed artifact and accepted behavior every time.

Before updating, read the prior handoff and applicable governance, inspect current Git state, and locate later evidence. Link rather than duplicate requirements. Preserve historical stops and qualifications; append a later disposition with its authority instead of rewriting old evidence. Never store secrets or customer data here.

Refresh section 11 and the resumption point together. Check relative links, all 19 sections, status consistency and `git diff --check`; report the final working-tree state. Run tests or live checks only when the task authorizes/requires them, labeling dated results otherwise. Commit/push only when authorized. The next maintainer must stop at the task boundary and return a report for ChatGPT review.

Latest maintenance checkpoint: October 9, 2026, following the final targeted profile-header review. Only this handoff was updated. Preserve the existing 166-test result as dated local evidence; next maintenance should follow the separately authorized runner milestone. All 19 sections and repository-relative links were checked locally; untracked tooling and external evidence are not included in the handoff publication. GitHub repository visibility was verified PRIVATE before publication.
