# Batch & Batter Cookie Co.

Batch & Batter is a local weekly cookie-drop ecommerce project. The customer-facing wordmark is **Batch & Batter**, with **Cookie Co.** as its descriptor.

## Current status

This repository contains only Phases 0–2: the project workspace, a minimal Next.js application foundation, and continuous integration. The page intentionally displays only the name, descriptor, and “Coming Soon.” Final branding and visual design are deferred.

Future architecture is expected to include AWS services, DynamoDB, Stripe, SQS, SES, and Cognito. These are future intentions only; no infrastructure, backend, database, payments, cart, authentication, or deployment is implemented here. Approved source documents will be inserted into `docs/` later.

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

The type-check command generates Next.js route types before running strict TypeScript checks, so it works on a fresh checkout. Unit tests are colocated with application code. Formatting covers the repository; dependency installation and application tooling live only in `web/`.

## Environment and security

`web/src/lib/env.ts` validates the existing `NODE_ENV` setting when Next.js loads its configuration. Next.js supplies the appropriate value for its commands. Only development, test, and production are accepted. Future settings should be explicitly validated here when actually introduced; never expose secrets through `NEXT_PUBLIC_` variables or Next.js configuration. No custom environment values are needed, so no `.env.example` is included.

Environment files, credentials (`*.pem`, `*.key`), dependencies, and generated artifacts are ignored. The lockfile is intended to be committed with the source. `.tools/` is ignored local bootstrap tooling, not part of the application.

## Structure and CI

- `web/`: Next.js 15.5.24, App Router, TypeScript, plain CSS, ESLint, Prettier, and Vitest.
- `backend/`, `shared/`, `infra/`, `tests/`: documentation-only placeholders for later phases.
- `docs/`: placeholders for approved source documents; no invented requirements.
- `.github/workflows/ci.yml`: clean npm installation, formatting, type-checking, linting, unit tests, and a production build on pushes and pull requests.

CI has read-only repository permissions and no deployment steps or secrets. It will run once this repository is connected to GitHub; no remote is configured by this implementation.

Next.js is deliberately pinned to the requested 15.5.24 baseline. Review dependency advisories and hosting compatibility before any future production release; upgrades require an explicit baseline decision.

Initial dependency audit reports two findings (one moderate, one high) involving Next.js's PostCSS dependency. npm proposes Next.js 16 as its automatic fix, which is outside the approved baseline; no forced upgrade or dependency override has been applied. ESLint 9 also emits an upstream support warning; it is retained for compatibility with the Next.js 15 ESLint configuration. Review these dependency constraints before production use.

## Known Dependency Risks

See [the dependency risk record](docs/DEPENDENCY_RISKS.md) for the temporarily accepted Next.js/PostCSS risk, relevant advisories, and required review before production deployment.
