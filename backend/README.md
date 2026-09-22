# Backend

Phase 4A provides validated catalog models, DynamoDB reads, customer Drop DTOs and the Application API Lambda. `src/health.ts` retains the existing health response. `src/handler.ts` dispatches the three GET routes.

Use Node 24.19.0 and npm 11.11.0. From this directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit
```

`npm test` builds and runs offline domain, repository, API, seed-plan and deployment-artifact tests. It never executes a confirmed AWS seed. Repository Prettier is run with `npm --prefix ../web run format:check`.

`dist/lambda/handler.js` is the sole deployment artifact, containing bundled runtime SDK and Zod code. `dist/bundle-meta.json` explains bundle inputs; compiled tests and tools remain outside the asset. The pinned esbuild build targets Node 24 and verifies reproducibility in tests.

`tools/seed-dev.ts` is local development tooling with a preview default, exact development target restrictions, and an explicit confirmation flag before any AWS operation. **AWS seed execution requires separate review.** See [Phase 4A guide](../docs/PHASE_4_CATALOG_AND_DROPS.md) for schema/key patterns, API/error contracts, packaging, dependencies, limitations, and seed instructions.
