# Backend

`src/health.ts` is the Phase 3A Application API Lambda handler. Its only behavior is returning HTTP 200 with `{ "status": "ok", "service": "batch-and-batter-api" }`.

The infrastructure package compiles and tests this TypeScript handler and packages its JavaScript output as a local Lambda asset. It has no dependencies, data access, or business logic. Run validation from `infra/`; no separate backend package is needed yet.
