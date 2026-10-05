# Known Dependency Risks

## Frontend security maintenance baseline

- **Review date:** 2026-10-05.
- **Owner:** Batch & Batter project.
- **Baseline:** `next` and `eslint-config-next` updated from exact `15.5.24` pins to exact `15.5.27` pins through normal npm installation. Only matching Next.js transitive packages changed; React, TypeScript, and other direct dependencies remain unchanged.
- **Reason:** [Next.js 15.5.27](https://github.com/vercel/next.js/releases/tag/v15.5.27) is a supported 15.5.x security release addressing GHSA-f87g-xv8r-7p7x, GHSA-4jqv-mc3x-m676, and GHSA-mcj8-r9mp-w47p. No Next.js 16 migration, overrides, audit suppression, or audit-fix operation was used.
- **Hosting compatibility:** [Amplify Hosting supports Next.js 12–15 SSR](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-nextjs-app.html); this patch stays within that supported major. This is not verification of a future hosted artifact.
- **Fresh audits:** Before and after the update, full audit reports five unique advisories across seven affected package nodes (six high, one moderate); production-only audit reports four unique advisories across two affected nodes (one high, one moderate). The remaining advisories are the braces and PostCSS findings below, not direct Next.js security advisories fixed by this release. Audit remains visibly nonzero.

Hosting A work is preserved separately. Its commit remains blocked until this maintenance is reviewed and merged. Hosting B public deployment remains blocked pending its own review and actual Amplify artifact verification.

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

- **Status:** Existing temporary development risk acceptance retained; not production risk acceptance.
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
