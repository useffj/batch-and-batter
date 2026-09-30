# Known Dependency Risks

## Next.js transitive PostCSS dependency

- **Decision:** Safe to commit with documented dependency risk.
- **Owner:** Batch & Batter project.
- **Status:** Accepted temporarily for development.
- **Next.js version:** 15.5.24.
- **Transitive dependency:** postcss 8.4.31.
- **Dependency path:** application → next@15.5.24 → postcss@8.4.31.
- **Audit result:** npm audit currently reports one moderate and one high affected package. Next.js inherits the finding from PostCSS; these package counts cover the four advisories below.

### Relevant advisories

- [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93)
- [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q)
- [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)
- [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849)

### Current exposure assessment

- Primarily build/development CSS processing for this application.
- The current application does not process user-supplied CSS.
- The project is not yet deployed.

### Current mitigation and review requirements

- Stay on the supported Next.js 15.5.24 project baseline. This version retains the known PostCSS risk; retaining the baseline does not fix the advisories.
- Do not use `npm audit fix --force`.
- Do not add unsupported PostCSS overrides without review.
- Re-check when a newer supported Next.js 15 release is available.
- Reassess before any production deployment.

**Review again before production deployment.** This is temporary acceptance for development, not production risk acceptance.

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
