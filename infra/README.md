# Development infrastructure

The Phase 3B development stack exists in us-east-2. Phase 4A changes are local until separately approved for deployment.

Use Node 24.19.0 and npm 11.11.0. Install backend dependencies first; infra builds bundle the Lambda without Docker:

```sh
cd backend
npm ci
cd ../infra
npm ci
npm run typecheck
npm test
npx cdk synth --lookups=false
npm audit
```

Run these from the repository root initially. Tests compile CDK and use Node's test runner with CDK assertions. Repository Prettier covers infra; there is no separate infra linter.

CDK output remains in ignored `infra/dist/` and `infra/cdk.out/`. The independent backend build produces `backend/dist/lambda/handler.js`; only that directory becomes the Lambda asset. No tests, seed tooling, or infrastructure source are packaged. The existing `lambda.Function` construct and Node 24 runtime remain.

Default context is `environment=dev`. Other environments fail until protective settings are reviewed. Account and Region use normal `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` when supplied; neither is required for local synthesis. Context lookups, version reporting, and CLI telemetry are disabled in `cdk.json`.

For an approved read-only AWS comparison, use profile `batch-and-batter-dev`, region `us-east-2`, and `cdk diff --no-change-set` to avoid creating a change set. No deployment or AWS seed is authorized by these instructions.

See [Phase 3 service guide](../docs/PHASE_3_AWS_INFRASTRUCTURE.md) for original resources and [Phase 4A guide](../docs/PHASE_4_CATALOG_AND_DROPS.md) for the current read routes, exact IAM scope, packaging and validation.
