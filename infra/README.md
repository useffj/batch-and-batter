# Development infrastructure

Phase 3A defines infrastructure locally. Nothing has been deployed.

Use Node 24.19.0 and npm 11.11.0 from the repository baseline:

```sh
cd infra
npm ci
npm run typecheck
npm test
npx cdk synth
npm audit
```

The project-local CDK CLI builds TypeScript before synthesis. Tests build before running Node's built-in test runner with CDK assertions. No separate infrastructure lint configuration is introduced; repository Prettier checks cover these files.

Compilation puts the CDK app, tests, and backend handler in ignored `dist/`. Only `dist/backend/src/` becomes the Lambda asset. Synthesis writes ignored `cdk.out/` containing CloudFormation and the local asset; it does not upload or deploy them. No Docker or bundler is required for this dependency-free handler.

Default context is `environment=dev`. Other environments fail until protective settings are reviewed. Account and Region can eventually come from normal `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` configuration; neither is required locally. Context lookups, version reporting, and CLI telemetry are disabled in `cdk.json`.

Do not run bootstrap or deployment commands in Phase 3A. If a command asks for AWS credentials, stop rather than connecting an account.

See [Phase 3A service guide](../docs/PHASE_3_AWS_INFRASTRUCTURE.md) for resources, IAM, removal policies, and deferred work.
