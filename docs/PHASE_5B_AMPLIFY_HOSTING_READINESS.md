# Phase 5B — Amplify Hosting repository readiness

Local repository preparation only, based on main `c9384ae6d20425ab1f7b7306e53af93709475620`. No Amplify app, deployment, DNS/certificate, AWS/Stripe mutation or payment enablement is authorized here. PAYMENT_START_ENABLED is untouched and must remain false throughout read-only storefront hosting.

## Inspection and target

The repository has independent `web`, `backend` and `infra` npm packages/lockfiles, with no root package.json or npm workspace. The frontend is Next.js 15.5.27 / eslint-config-next 15.5.27 / React 19.1.9. Its scripts are dev (`next dev`), build (`next build`), start (`next start`), typecheck (`next typegen && tsc --noEmit`), lint, Vitest tests and repository Prettier checks. next.config.ts validates NODE_ENV but has no static export or custom output directory. Existing code uses force-dynamic and server-side fetch with cache=no-store. There was no Amplify build specification or frontend hosting configuration.

Target: Amplify Hosting SSR / WEB_COMPUTE, not static export or Classic hosting. AWS documents Next.js 12–15 support, including Node 24 compute matching the build major version. Keep the reviewed Next.js/Node baseline; do not silently upgrade dependencies for hosting.

References reviewed on 2026-10-05:

- https://docs.aws.amazon.com/amplify/latest/userguide/deploy-nextjs-app.html
- https://docs.aws.amazon.com/amplify/latest/userguide/ssr-supported-features.html
- https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-configuration.html
- https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html

## Repository build configuration

Root amplify.yml declares one application, appRoot=web. The future AMPLIFY_MONOREPO_APP_ROOT must also be `web`. Commands execute within web; no root buildPath override is used. This builds only the existing frontend, with no backend generation/deployment phase.

Exact future sequence from web:

```sh
nvm install "$(cat ../.nvmrc)"
nvm use "$(cat ../.nvmrc)"
npm install --global npm@11.11.0
npm ci --cache .npm --prefer-offline
node scripts/prepare-amplify-env.mjs
npm run build
```

The Node pin is 24.19.0. npm ci honors web/package-lock.json. Artifacts are `.next/**/*`, relative to web. Only `.npm/**/*` and `.next/cache/**/*` are cached, not node_modules or environment files. No full `.next` output is restored as a deployment artifact without a new build.

## SSR configuration

The future Amplify console supplies exactly these application settings:

- STOREFRONT_API_BASE_URL: reviewed public HTTPS API base URL, optionally including stage path. No endpoint is committed.
- STOREFRONT_CURRENCY: USD.

Build environment variables alone do not automatically reach Next.js SSR. The explicit helper writes only these two values to web/.env.production, which Next.js recognizes. It does not enumerate process.env, use broad grep, copy secrets, or log values. Missing settings, non-USD currency, invalid/non-HTTPS URLs, credentials, query/fragment, whitespace, quoting or dotenv expansion syntax fail clearly before writing. This hosting path is deliberately HTTPS-only even though the application's local development client permits loopback HTTP.

The file is exclusively created at mode 0600; an existing file causes a safe failure rather than overwriting operator data. Use clean build checkouts. A repeated local build must remove only its own generated file first. `.env*` is already ignored; `.npm/` is now ignored too. Never commit generated environment files. Do not place secrets in these settings or any hosting environment file. No NEXT_PUBLIC prefix is required.

Local validation uses `https://storefront-build.invalid` and USD. The reserved invalid hostname is a build fixture, never a runtime fallback. Build does not fetch Drop data. A separate process verifies Next's production environment loader reads the generated file without inherited storefront variables. The generated file is removed afterward.

## Future deployment gate — not executed

1. Separately authorize Amplify Hosting app creation and GitHub access for `useffj/batch-and-batter`, branch main. Select monorepo root web, WEB_COMPUTE and a Node-24-capable build image. Review hosting service-role permissions; this frontend needs no business-data or secret AWS access.
2. Supply the two reviewed public values plus AMPLIFY_MONOREPO_APP_ROOT=web. Review deployment triggers; do not let connecting main silently authorize uncontrolled deployments.
3. Build using root amplify.yml. Confirm the home page is dynamically server-rendered, `.next` artifacts and environment propagation are correct, and no static Drop snapshot is introduced.
4. First deploy only to the generated amplifyapp.com URL. Verify HTTPS and HTTP-to-HTTPS behavior, SSR responses/cache headers and fresh backend data on reload. Do not add a static SPA rewrite that bypasses SSR behavior.
5. Only after the smoke gate passes, separately review Route 53 domain association: batchandbatter.com as canonical apex, www redirected to apex, Amplify-managed HTTPS certificate. No DNS values or resource IDs are prescribed or created here.
6. Roll back by redeploying the previous known-good Amplify deployment and verifying its configuration and smoke behavior. Record the known-good deployment before each release; for the first deployment, there is no prior release, so review a stop/unpublish contingency before activation. Do not roll back the payment backend or change payment admission.

## Future smoke matrix

On the temporary Amplify URL verify HTTP/HTTPS, OPEN, SCHEDULED and null Drop, names/USD pricing, availability disclaimer, pickup dates/hours/timezone/location/instructions, mobile layout, keyboard/focus and safe failure UI. Confirm an elapsed SCHEDULED timestamp never opens a Drop without a backend state change. Verify fresh data after reload and no stale static/CDN snapshot. Confirm no secret, admin, payment or acceptance-harness exposure.

State/failure scenarios require a separately approved fixture-capable public test API or controlled DEV data plan. Do not create Drops, interrupt a shared API or mutate production merely to exercise smoke cases. Any temporary fixture configuration must be replaced with the reviewed API and revalidated before domain review. No Cart/payment test is part of this smoke gate.

## Cost, security and non-goals

No WAF initially; review ordinary hosting compute/build/transfer costs and budget guardrails at deployment approval. No additional backend, Amplify Auth/Data/full-stack generation, customer authentication, Stripe/payment settings, secret environment variables, cart, checkout, wallets, admin dashboard, refunds, notifications or waitlist. Existing dependency-risk exceptions remain in DEPENDENCY_RISKS.md and require reassessment before production; this readiness change does not resolve them.

This prepares Hosting A repository readiness only. Cloud runtime packaging, domain behavior, cache behavior and rollback still require the separately authorized deployment/smoke gate.

## Local validation and review disposition

- Node 24.19.0 used. Clean lockfile install succeeded using npm 11.11.0 through npx, without changing the operator's global npm. The local download cache was isolated in /tmp; Amplify uses the app-local .npm cache specified above.
- 69 frontend tests passed: 54 existing and 15 hosting configuration cases. Tests cover allowlisting, missing settings, currency, unsafe URL/env injection, safe errors, existing-file preservation and build-spec scope.
- Frontend typecheck, lint and production build passed. Build explicitly loaded .env.production and classified `/` as `ƒ` (dynamic server-rendered on demand); the not-found page remains static.
- Next's production environment loader, in a separate process without inherited storefront variables, read both expected normalized values. Only those public values were written. The generated file was removed after validation and is not tracked.
- Both production-exclusion tests passed. Repository formatting and git diff --check passed. No backend/infra/application runtime/dependency file changed; no CDK diff or deployment was performed.

### Security revalidation on the approved Next 15.5.27 baseline

PR #35 established the reviewed Next.js 15.5.27 baseline. Fresh full audit reports five unique advisories across seven affected package nodes (six high, one moderate); production-only audit reports four unique advisories across two nodes (one high, one moderate). The advisory identities match the accepted maintenance evidence; no new advisory appeared.

GHSA-vfj7-8cjw-p6xm / braces@3.0.3 remains a temporarily accepted, upstream-blocked lint/build-tooling exception under docs/DEPENDENCY_RISKS.md. Its exact path is eslint-config-next@15.5.27 → @next/eslint-plugin-next@15.5.27 → fast-glob@3.3.1 → micromatch@4.0.8 → braces@3.0.3. Repository-controlled patterns limit the observed exposure; residual repository/build-input risk remains. This advisory is neither harmless nor fixed.

PostCSS@8.4.31 remains a production dependency through next@15.5.27. Observed application use is build-time CSS processing; it must not be described as a development-only installation. Fresh local SSR runtime traces exclude the vulnerable PostCSS path and the braces/micromatch/fast-glob/Next ESLint plugin chain. These local results are not proof about a future Amplify packaged runtime.

Audit findings remain visible. No audit fix, override, dependency change, or suppression was performed in this readiness phase. The approved dependency-risk record remains unchanged. Before public Hosting B deployment, reevaluate the exceptions and verify the actual Amplify artifact/runtime; also reevaluate when a patched braces or compatible parent release becomes available. Existing CDK production-review requirements remain in force.

Hosting A is ready for commit approval after this local revalidation. Hosting B remains separately blocked. Do not deploy automatically after merge. PAYMENT_START_ENABLED was last verified false; obtain fresh read-only verification before any future AWS/Amplify mutation. AWS SSO was not refreshed or required for this phase.
