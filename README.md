# Batch & Batter Cookie Co.

Batch & Batter is a local weekly cookie-drop ecommerce project. The customer-facing wordmark is **Batch & Batter**, with **Cookie Co.** as its descriptor.

## Current status

Phases 0–3B are complete, and the development AWS stack is deployed in us-east-2. Phase 4A adds the catalog data layer and read-only Drop APIs locally, pending review and deployment approval. The web page remains the minimal name, descriptor, and “Coming Soon.” Final branding and later commerce workflows are deferred.

Approved PRD v1.1, Technical Specification v1.1, and Implementation Plan v1.0 are in `docs/` and remain unchanged. See [the Phase 3A guide](docs/PHASE_3_AWS_INFRASTRUCTURE.md) for services, safeguards, and deferred work.

## Local development

Install Node.js **24.19.0** (Node 24 LTS, pinned in `.nvmrc`) and npm **11.11.0**. If using nvm, run `nvm install` and `nvm use` from the repository root. Use `npm install --global npm@11.11.0` if your npm version differs.

Run all application commands from `web/`:

```sh
cd web
npm ci
npm run dev
```

Open http://localhost:3000. No environment file or external services are required.

| Task                         | Command (from `web/`)  |
| ---------------------------- | ---------------------- |
| Unit tests                   | `npm test`             |
| Watch tests                  | `npm run test:watch`   |
| Lint                         | `npm run lint`         |
| Type-check                   | `npm run typecheck`    |
| Production build             | `npm run build`        |
| Serve local production build | `npm start`            |
| Check repository formatting  | `npm run format:check` |
| Format repository files      | `npm run format`       |

The type-check command generates Next.js route types before running strict TypeScript checks, so it works on a fresh checkout. Unit tests are colocated with application code. Formatting covers the repository; web dependencies live in `web/`, and backend and infrastructure dependencies live independently in `backend/` and `infra/`.

## Environment and security

`web/src/lib/env.ts` validates the existing `NODE_ENV` setting when Next.js loads its configuration. Next.js supplies the appropriate value for its commands. Only development, test, and production are accepted. Future settings should be explicitly validated here when actually introduced; never expose secrets through `NEXT_PUBLIC_` variables or Next.js configuration. No custom environment values are needed, so no `.env.example` is included.

Environment files, credentials (`*.pem`, `*.key`), dependencies, and generated artifacts are ignored. The lockfile is intended to be committed with the source. `.tools/` is ignored local bootstrap tooling, not part of the application.

## Structure and CI

- `web/`: Next.js 15.5.24, App Router, TypeScript, plain CSS, ESLint, Prettier, and Vitest.
- `backend/`: independent TypeScript catalog/API package, offline tests, local seed tooling, and a pinned esbuild Lambda bundle.
- `infra/`: CDK TypeScript app, pinned dependencies, assertions, and local synthesis.
- `shared/`, `tests/`: placeholders for later phases.
- `docs/`: approved governing documents, dependency risk record, and Phase 3A guide.
- `.github/workflows/ci.yml`: clean npm installation, formatting, type-checking, linting, unit tests, and a production build on pushes and pull requests.

CI has read-only repository permissions and no deployment steps, AWS credentials, or secrets. The repository is connected to GitHub and the initial web CI run passed. Separate backend and infrastructure jobs validate the API, deployment artifact, and CDK synthesis without AWS credentials or lookups; remote validation of Phase 4A awaits review and a later push.

Next.js is deliberately pinned to the requested 15.5.24 baseline. Review dependency advisories and hosting compatibility before any future production release; upgrades require an explicit baseline decision.

Initial dependency audit reports two findings (one moderate, one high) involving Next.js's PostCSS dependency. npm proposes Next.js 16 as its automatic fix, which is outside the approved baseline; no forced upgrade or dependency override has been applied. ESLint 9 also emits an upstream support warning; it is retained for compatibility with the Next.js 15 ESLint configuration. Review these dependency constraints before production use.

## Known Dependency Risks

See [the dependency risk record](docs/DEPENDENCY_RISKS.md) for the temporarily accepted Next.js/PostCSS risk, relevant advisories, and required review before production deployment.

## Backend and infrastructure validation

Use the same Node/npm baseline. From the repository root:

```sh
cd backend
npm ci
npm run typecheck
npm test
npm run build
npm audit
cd ../infra
npm ci
npm run typecheck
npm test
npx cdk synth
npm audit
```

The local CDK CLI builds the independent backend bundle and compiles the CDK app before synthesis. No AWS credentials, account ID, fixed Region, Docker, or global CDK installation is required. Generated `infra/dist/` and `infra/cdk.out/` are ignored. Do not deploy or execute the development seed against AWS without separate approval. See [infra instructions](infra/README.md).

See [Phase 4A catalog and Drops](docs/PHASE_4_CATALOG_AND_DROPS.md) for key patterns, public APIs, Lambda packaging, and development seed safeguards.
