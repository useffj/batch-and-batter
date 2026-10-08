# Known Dependency Risks

## Frontend security maintenance baseline

- **Review date:** 2026-10-05.
- **Owner:** Batch & Batter project.
- **Baseline:** `next` and `eslint-config-next` updated from exact `15.5.24` pins to exact `15.5.27` pins through normal npm installation. Only matching Next.js transitive packages changed; React, TypeScript, and other direct dependencies remain unchanged.
- **Reason:** [Next.js 15.5.27](https://github.com/vercel/next.js/releases/tag/v15.5.27) is a supported 15.5.x security release addressing GHSA-f87g-xv8r-7p7x, GHSA-4jqv-mc3x-m676, and GHSA-mcj8-r9mp-w47p. No Next.js 16 migration, overrides, audit suppression, or audit-fix operation was used.
- **Hosting compatibility:** [Amplify Hosting supports Next.js 12–15 SSR](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-nextjs-app.html); this patch stays within that supported major. This is not verification of a future hosted artifact.
- **Fresh audits:** Before and after the update, full audit reports five unique advisories across seven affected package nodes (six high, one moderate); production-only audit reports four unique advisories across two affected nodes (one high, one moderate). The remaining advisories are the braces and PostCSS findings below, not direct Next.js security advisories fixed by this release. Audit remains visibly nonzero.

Historical maintenance gate: Hosting A and Hosting B were blocked pending their respective reviews. Those reviews are now complete: Hosting A is merged, and Hosting B1/B2B passed human acceptance on 2026-10-05 under the artifact-specific PostCSS exception below. Existing advisory findings remain unchanged.

## Braces temporary exception

- **Status:** Temporarily accepted by human review for development under this documented lint/build-tooling scope; upstream blocked. This is not production approval.
- **Advisory:** [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) / CVE-2026-93687, high severity.
- **Installed:** `braces@3.0.3`; affected range `<=3.0.3`.
- **Patched release:** None listed upstream as of 2026-10-05.
- **Exact path:** `eslint-config-next@15.5.27` → `@next/eslint-plugin-next@15.5.27` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3`.
- **Installation/exposure:** Development lint tooling. Fresh `npm explain braces` and `npm ls braces --all` confirm this single path. The Next ESLint plugin uses fast-glob for repository-controlled root-directory/configuration patterns. No storefront-request path into those inputs is demonstrated.
- **Local runtime evidence:** Absent from all seven generated Next.js 15.5.27 SSR NFT traces, together with micromatch, fast-glob, and the Next ESLint plugin. Generated server/browser JavaScript scans also found no corresponding package-path markers. This does not establish absence from a future Amplify artifact.
- **Residual risk:** Malicious repository/build glob inputs can still expose tooling to resource exhaustion. The issue is not harmless merely because linting is a development dependency.

Do not downgrade eslint-config-next to npm audit's proposed 14.2.35 remediation, remove linting, or add unsupported overrides. Reevaluate when a patched braces release or compatible parent dependency is available, and before Hosting B public deployment. Audit findings must remain visible.

## Next.js transitive PostCSS dependency

- **Status:** Temporary development risk acceptance retained, with a separately human-approved, narrowly scoped public Hosting B exception for the specific artifact below. This is not blanket production or payment-launch risk acceptance.
- **Installed path:** `next@15.5.27` → `postcss@8.4.31`.
- **Installation classification:** Production dependency through Next.js, not a development-only dependency.
- **Observed application exposure:** CSS/build processing. The current storefront does not accept user-supplied CSS.
- **Local runtime artifact:** The vulnerable PostCSS package path is absent from all seven freshly built Next.js SSR NFT traces. Generated server/browser JavaScript scans found no `postcss/lib` marker. These local checks do not prove absence from a future Amplify deployment artifact.
- **Audit:** Four unique advisories across the PostCSS and inherited Next.js nodes (one high and one moderate affected package). Next.js 15.5.27 still depends on PostCSS 8.4.31 and does not fix these findings.

### Relevant advisories

| Advisory                                                                 | Affected range | First patched version |
| ------------------------------------------------------------------------ | -------------- | --------------------- |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | `<8.5.10`      | `8.5.10`              |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | `<=8.5.11`     | `8.5.12`              |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | `<=8.5.22`     | `8.5.23`              |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | `<=8.5.17`     | `8.5.18`              |

Retain the supported 15.5.27 baseline while monitoring compatible upstream fixes. Do not use audit fix, unsupported PostCSS overrides, or npm audit's proposed Next.js 16 migration. Reassess before public hosting, including the actual Amplify SSR artifact. The frontend has not been deployed by this maintenance.

### Maintenance validation and repeatable runtime check

Validation passed on 2026-10-05: 54 frontend tests, 844 backend functional tests, seven backend artifact tests, 34 infrastructure tests, and two production-exclusion tests. Frontend typecheck, lint, production build, repository formatting, and `git diff --check` also passed. Inspect every `files` entry in `web/.next/**/*.nft.json` after building for braces, micromatch, fast-glob, @next/eslint-plugin-next, and the vulnerable PostCSS package path; also scan generated server and browser JavaScript for their package-path markers. Keep generated artifacts out of Git.

## AWS CDK bundled brace-expansion

- **Owner:** Batch & Batter project.
- **Review date:** 2026-09-30.
- **Status:** TEMPORARILY ACCEPTED / UPSTREAM BLOCKED, by human review for development only.
- **Package:** `brace-expansion@5.0.9` (vulnerable; not fixed).
- **Exact dependency path:** `aws-cdk-lib@2.269.0` → bundled `minimatch@10.2.5` → bundled `brace-expansion@5.0.9`.
- **Installed audit path:** `node_modules/aws-cdk-lib/node_modules/brace-expansion` in `infra/`.
- **Upstream blocker:** Official AWS CDK releases tested through `2.271.0` still bundle `5.0.9`. Downstream npm overrides cannot safely replace this bundled dependency. The current audit requires `brace-expansion >=5.0.12` to resolve all three findings; npm's generic `fixAvailable` flag does not establish a supported bundled fix.

### Exact accepted advisories

| Advisory                                                                                   | Severity | Affected range    | Patched version |
| ------------------------------------------------------------------------------------------ | -------- | ----------------- | --------------- |
| [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) / CVE-2026-102277 | Moderate | `>=4.0.0 <5.0.12` | `5.0.12`        |
| [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) / CVE-2026-102278 | High     | `>=4.0.0 <5.0.11` | `5.0.11`        |
| [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) / CVE-2026-102276 | High     | `>=4.0.0 <5.0.10` | `5.0.10`        |

The infrastructure audit remains visibly nonzero: one high-severity affected package covering these three advisories. No audit suppression or package-name-only allowlist is authorized. Only these exact advisories at the dependency path above are accepted temporarily; any additional/new vulnerability fails validation and requires review.

### Exposure and mitigation

Malicious brace/glob input reaching the vulnerable code can cause denial of service/resource exhaustion in the Node process. Exposure here is infrastructure/CDK synthesis tooling. The approved workflow accepts trusted repository/operator input only, with no user-controlled glob/pattern input. There is no identified customer/runtime exposure: the affected chain is absent from the built Lambda deployment bundles.

Use official AWS CDK packages only, retain Node 24, and run full tests, synthesis, and a reviewed diff before deployment. Do not modify vendor bundles, manually edit `node_modules`, use a repackaged fork, hide dependencies in the lockfile, or run `npm audit fix --force`. Continue monitoring official AWS CDK releases.

### Runtime absence evidence and repeatable check

After a fresh backend build, inspect every input in `backend/dist/bundle-meta.json` for `brace-expansion` and `minimatch`, and scan these generated bundles for both package names:

- `backend/dist/lambda/handler.js` — application API
- `backend/dist/lambda/payment-worker-handler.js` — payment worker
- `backend/dist/lambda/stripe-webhook-handler.js` — Stripe webhook
- `backend/dist/lambda/expiry-worker-handler.js` — shopping expiry worker
- `backend/dist/lambda/expiry-reconciler-handler.js` — expiry reconciler

The 2026-09-30 verification found neither package in the esbuild inputs or any of these five bundles. These are local deployment artifacts; this check does not download or execute live Lambda code. Preserve this check when reevaluating the exception. Absence from runtime bundles does not make the tooling dependency non-vulnerable.

### Exit condition and production gate

Upgrade promptly when an official compatible `aws-cdk-lib` release bundles `brace-expansion >=5.0.12`, or another version verified to resolve every current advisory. Re-run audits, runtime absence checks, tests, synth, and diff when upgrading.

**This exception MUST be reevaluated before production payment launch.** It is temporary development risk acceptance, not a clean audit or a production security approval.

## DEV identity/ledger rollout exception renewal — 2026-10-07

**HUMAN APPROVED — temporary DEV-only risk acceptance; audit remains failing.**
Jackson approved this renewal for checkpoint
`ce9978f847e92bdb4eb1fe36b06395bb8fbbba99` and its reviewed three-stage
identity/ledger rollout in AWS account `302154194958`, region `us-east-2`.
The approval-record commit adds documentation only; it does not change the
reviewed application code, dependency versions, candidate bytes or rollout scope.

- **Exact scope:** the three CDK bundled brace-expansion advisories listed above,
  at `aws-cdk-lib@2.269.0 -> minimatch@10.2.5 -> brace-expansion@5.0.9`.
  No other advisory, environment, dependency version or rollout is accepted.
- **Candidate ZIP SHA-256:**
  `6697aafd6f62df7224ee22845578f44be908f430ed53bee74fce4f6cf690997c`.
- **Expires:** October 14, 2026, 5 p.m. America/Denver
  (`2026-10-14T23:00:00Z`), with no automatic extension.
- **Earlier termination:** a verified compatible fixed official release, any new
  advisory, changed exposure, artifact or rollout scope. Recheck before execution;
  stop on a termination condition. Do not silently transfer acceptance to new bytes.
- **Authority:** repository finalization and the reviewed three-stage DEV rollout
  are approved, subject to required CI, fresh operational checks, inspection of
  each actual change set, and verification of each stage before advancing.
  `PaymentStartEnabled=false` throughout. No payment test, new Drop/Cart or
  production authorization is granted.

The reviewed workflow uses trusted, pinned official dependencies and fixed backend
asset directories. CDK synthesis is tooling exposure; the vulnerable packages were
absent from all five backend bundles and their esbuild inputs. The actual staged
update uses reviewed fixed templates/ZIPs through AWS CLI, not ordinary CDK asset
selection. These observations do not make the dependency safe: crafted repository
or tooling patterns can still exhaust CPU/stack resources.

All proposed controls remain required: credential-isolated, time/memory-bounded
synthesis; trusted source and no untrusted pattern/plugin input; unchanged artifact
hashes; reviewed change sets; current operator/alert responsibility; healthy queues,
alarms and recovery heartbeats; and no unresolved commerce responsibility. Keep the
historical namespace, compatible readers, worker, webhook, expiry/reconciliation
and durable recovery intact across stages. The temporary legacy binding preserves
an existing mismatch and is not a new account approval. Follow the staged recovery
constraints in `PAYMENT_RECOVERY_RUNBOOK.md`; never pair legacy code with the
corrected account or use a code-only rollback after the correction.

Retain full infrastructure audit output and its nonzero exit status. Existing CI
runs infrastructure typecheck/tests/synthesis but does not run infrastructure audit;
passing CI is therefore separate from this explicit risk acceptance. No CI/release
check, dependency, audit severity or advisory is suppressed or modified. Any
additional finding requires a stop and human review.

Remove this exception when an official compatible package bundles
`brace-expansion >=5.0.12` and resolves the assessed findings. Upgrade normally,
repeat audit and relevant validation, and review affected artifact/template changes.
This record grants no production risk acceptance and does not assert deployment
success; deployment identifiers and acceptance results belong in the resulting
operator evidence.

## Hosting B artifact-specific PostCSS acceptance — 2026-10-05

Human review accepted Hosting B1 and B2B as PASSED under a **TEMPORARY, NARROWLY SCOPED** exception. This supplements, rather than erases, the earlier local-trace evidence and advisory table.

- App `batch-and-batter-storefront` / `d1aw7cfglvejmo`, branch `main`, WEB_COMPUTE / Next.js SSR, Job 1 SUCCEED.
- Accepted repository HEAD: `395a03f918ac5577a6cc9354243d713f021597b0`.
- Actual downloaded compute artifact SHA-256: `922e2460594dcc5994e3902ddbf21b3592c329a2587862977d30bb9d28072e5f`.
- Next.js 15.5.27 physically packages vulnerable PostCSS 8.4.31. Local NFT absence did **not** predict Amplify package absence.
- Classification: **PACKAGED BUT NOT REQUEST-REACHABLE**, for the reviewed read-only routes/configuration only.
- The production entrypoint sets dev=false; PostCSS references lead into CSS build/development tooling, not the identified normal storefront request path. No user-supplied CSS feature exists, and public HTTP inputs do not reach PostCSS configuration or CSS input.
- Representative local execution of the downloaded compute package loaded 391 unique modules, with zero modules beneath node_modules/postcss. Braces/micromatch/fast-glob/ESLint tooling were absent from relevant runtime execution. Representative execution is not exhaustive proof of all possible future requests.
- Vulnerable advisory ranges and audit findings still apply. No audit suppression, override or dependency workaround was used. PostCSS is not fixed or universally safe; package presence is not irrelevant.
- The temporary URL and canonical https://batchandbatter.com use the same accepted artifact. B2B domain/certificate/redirect configuration introduced no new application build; Job 1 and repository HEAD remained unchanged. New hostname/redirect behavior was reviewed separately.
- Automatic builds remain disabled. PAYMENT_START_ENABLED was verified false before and after hosting/domain work; no Cart, checkout or Stripe browser SDK is exposed.

Renewed security review is mandatory for changes to Next.js, PostCSS, Amplify packaging behavior, build configuration, serving artifact, server routes, middleware, server actions, CSS-processing features, public request surface or hosting architecture. The exception must not silently transfer to a new artifact. Continue monitoring supported upstream remediation; retain all existing advisory records and the independent CDK production-review gate.

Full acceptance, DNS/email preservation and rollback evidence are recorded in [Amplify hosting readiness and acceptance](PHASE_5B_AMPLIFY_HOSTING_READINESS.md). This documentation does not authorize a deployment or payment launch.

## Phase 9A source-map-js review and local remediation — 2026-10-05

The fresh pre-install frontend audit found a previously unrecorded high finding:
[GHSA-68fv-2mgg-jv7q / CVE-2026-93749](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
The affected range is `>=1.0.0 <1.2.2`; installed version was 1.2.1. Indexed
source-map section offsets can cause synchronous event-loop denial of service.
This was present before adding Stripe and must not be attributed to Stripe.

It is transitive through both `next@15.5.27 -> postcss@8.4.31 -> source-map-js`
(production dependency classification) and `vitest@4.1.11 -> vite@8.3.0 ->
postcss@8.5.28 -> source-map-js` (development tooling). The corresponding parent
ranges, `^1.0.2` and `^1.2.1`, both accept patched 1.2.2.

The retained accepted Phase 6A Job 3 BUILD.zip was rehashed locally to
`f3ed72232fed0c153474be3610e24ac6ee08aafef51afbba3545a7e66dcdb494`, matching the
acceptance record. It physically contains source-map-js 1.2.1. Inspection found
imports from PostCSS input, previous-map and map-generator modules. There is no
application feature accepting source maps or CSS. Its retained representative
runtime trace has 1,251 successful module-load edges / 463 unique modules and zero
source-map-js or PostCSS loads. This is evidence of bounded tooling exposure for
that artifact/request surface, not proof of universal non-reachability and not a
claim that the deployed package is patched. No live AWS request was used for this
review; current live artifact identity was not independently re-queried.

Under the authorized bounded-dependency review, normal targeted `npm update
source-map-js --ignore-scripts` resolved 1.2.2 without overrides, direct dependency
addition, parent upgrades or audit suppression. Only that transitive version and
its integrity/resolved URL changed. Full regressions accompany this local patch.
No deployment is authorized; the accepted historical artifact still contains 1.2.1.

Stripe preflight used a separate package-lock-only resolution before installation.
Exact pins `@stripe/stripe-js@10.0.0` and `@stripe/react-stripe-js@7.0.0` are
compatible with React 19.1.9; the wrapper requires Stripe.js >=10 <11 and React

> =16.8 <20. Two new nodes are added. Five existing nodes (`prop-types`, `react-is`,
> `object-assign`, `loose-envify`, `js-tokens`) become part of the production closure;
> none changes version. Stripe.js has no runtime package dependencies; the React
> wrapper depends on prop-types. No new advisory appears in the isolated or actual
> installation. Registry unpacked sizes are 1,032,122 and 870,381 bytes; those are
> package sizes, not browser payload sizes.

Full audit changes from 8 affected nodes (7 high / 1 moderate) to the previously
recorded 7 (6 high / 1 moderate). Production-only audit retains the two Next/PostCSS
nodes (1 high / 1 moderate). Existing PostCSS, braces and CDK exceptions are neither
expanded nor erased. A future checkout deployment creates a NEW Amplify artifact
and request surface requiring independent PostCSS and source-map reachability
reevaluation. This local source-map fix does not make the remaining audit clean.

## DEV worker diagnostics artifact exception — 2026-10-07

**HUMAN APPROVED — temporary DEV-only risk acceptance; infrastructure audit remains failing.**

Jackson approved the worker-only diagnostics deployment in AWS account
`302154194958`, region `us-east-2`, for candidate ZIP SHA-256
`409bfe6323f3f1e9f5947c33394621f58be4851fb52983e2cb3b2ef380cd6c29`.
Reviewed application patch SHA-256:
`b0822522982cc58a9a0ce9310a7c25a6d842f3bff8592aff7aae344ae21e8850`.
Worker-only proposed template SHA-256:
`8e45d034f781380400cd0bb2d88211c1c02310178de197c3eb381909b011ca77`.

Only PaymentWorker code may change. The other four functions retain accepted code.
Preserve actual account/binding `acct_1UL8LdDz3QSwRsAl`, historical namespace
`dev:acct_1UL8xeDXKfaUH9bm`, compatible readers/recovery, and payment admission
false. The compatible recovery ZIP is
`6697aafd6f62df7224ee22845578f44be908f430ed53bee74fce4f6cf690997c`;
recovery must retain the current identity/ledger configuration. No payment,
message replay, commerce creation, Stripe configuration change or Amplify build
is authorized. Stop for unexpected change-set effects.

This explicit extension covers only the three existing bundled brace-expansion
advisories and locked dependency versions listed above. Expiration remains
October 14, 2026, 5 p.m. America/Denver (`2026-10-14T23:00:00Z`). All existing
controls and earlier termination conditions remain in force, including a verified
compatible fixed release, new advisory, changed exposure, artifact or scope.
No suppression, dependency change or release-gate bypass is authorized.
Fresh checks on October 7 found the same three advisories (audit exit 1) and
unchanged official CDK 2.272.0 package integrity. Runtime bundle inspection
found neither brace-expansion nor minimatch; tooling risk remains. Passing CI
is distinct from this approved exception and does not mean the audit passed.

The successful hosted $5.25 purchase remains preserved. The lowercase `useff`
name deviation is accepted: submitted and stored values matched. Local controlled
concurrency tests reproduced safe contention/idempotent replay without duplicate
capture or settlement. The historical worker exception cause remains unproven;
this change does not resolve it retroactively or claim all hosted scenarios passed.

## DEV authentication-wait correction — 2026-10-07

**HUMAN APPROVED — temporary DEV-only exception; infrastructure audit remains failing.**

Jackson approved API and payment-worker code updates only in account
`302154194958`, region `us-east-2`, using candidate ZIP SHA-256
`57a4c98fd6e773bd4b31aa53e248b0151376a85ea7640bb759f613ce5f4f5205`.
The narrowed template SHA-256 is
`d382b95ae3ac587bb4d9ba7dff0643fc2776f838b0c9b8722fd1053ff4b44954`.
Retain deployed webhook, expiry-worker and reconciler artifacts. Preserve actual
account/binding, historical ledger namespace, recovery configuration and admission
false. The unchanged webhook durably accepts the same inbox schema; sequential
API/worker updates remain compatible with existing work and readers.

The same three brace-expansion advisories, locked versions and controls apply.
Expiration remains October 14, 2026, 5 p.m. America/Denver; a verified compatible
fixed release, new advisory, changed exposure, artifact or scope terminates the
exception earlier. Fresh audit still exits 1 with the same three advisories.
The official CDK 2.272.0 package integrity was verified again; its bundled
brace-expansion remains 5.0.9. Passing CI does not mean the audit passed.

The inspected obsolete abandonment message and its existing payment DLQ alarm
are explicitly acknowledged, preserved pre-existing conditions. No deletion is
permitted to make preflight green. Stop for new failures or unreviewed change-set
or replacement effects. Preserve the retained compatible API and worker rollback
artifacts with current identity/ledger configuration and admission false.

The correction leaves authentication-wait work durable for scheduled discovery.
Background waiting checks now depend on minute-cadence reconciliation; continuation
and webhook-driven progress retain immediate wake-ups. Other repeated processing
and retry paths remain outside this narrow correction. Financial/customer
abandonment remains passed; transport acceptance remains unresolved pending hosted
verification. This approval does not authorize a payment test, commerce creation,
DLQ receive/delete/redrive/replay, Stripe change, metrics or tracing/protection
change, or Amplify build.
