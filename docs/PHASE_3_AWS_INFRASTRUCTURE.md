# Phase 3A — AWS development infrastructure

This phase is a local blueprint and validation exercise. No AWS account connection, credentials, bootstrap, deployment, or cloud resources are needed or created by the validation commands. PRD v1.1, Technical Specification v1.1, and Implementation Plan v1.0 remain unchanged.

## What each service does

| Service     | Batch & Batter purpose                                                                                              | Defined now                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| AWS CDK     | The TypeScript blueprint that describes our AWS infrastructure.                                                     | One development stack; local CloudFormation synthesis and assertions.                                                                   |
| DynamoDB    | Where Batch & Batter will eventually store Drops, inventory, carts, and orders.                                     | Catalog, Commerce, and Operations tables with string `PK`/`SK`, on-demand billing, default AWS-owned encryption, no indexes or records. |
| Lambda      | Where our server-side cookie business rules will eventually run.                                                    | One Node.js 24.x function returning service health JSON; no data access.                                                                |
| API Gateway | The controlled front door between the website and backend.                                                          | HTTP API with one public `GET /health` route and its Lambda integration.                                                                |
| SQS         | The waiting line that will eventually wake the reservation system after an 8-minute timer or process notifications. | Standard Reservation and Notification queues, each with its own dead-letter queue; no workers or messages.                              |
| Cognito     | The future administrator login system.                                                                              | Admin-only user pool with self-signup disabled; no users, app client, domain, or customer authentication.                               |
| S3          | Where cookie product photos and media will eventually live.                                                         | Private encrypted bucket with public access blocked and HTTPS required; no uploads or website hosting.                                  |
| CloudWatch  | How we will see errors and operational logs.                                                                        | Pre-created Lambda log group with 14-day retention; no dashboards or alarms.                                                            |

## Naming and development safeguards

Project tag: `batch-and-batter`. Environment tag: `dev`. Names use `batch-and-batter-dev-...`; the log group uses `/aws/lambda/batch-and-batter-dev-api`. The media bucket adds CloudFormation account and Region tokens to avoid global name collisions. No literal account ID or fixed Region is in the code.

Only `dev` is accepted. This keeps the environment-aware naming explicit while preventing accidental reuse of destructive development settings for staging or production. Normal CDK account/Region environment configuration can be supplied in Phase 3B. Synthesis performs no context lookups.

Tables, queues, user pool, media bucket, and logs use development `DESTROY` removal policies. Table deletion protection is disabled. The S3 bucket deliberately does **not** auto-delete objects: a future nonempty bucket will block deletion until its contents are handled explicitly. No cleanup custom-resource Lambda is created.

Before production, review retention, deletion protection, DynamoDB recovery/backups, media versioning, administrator MFA and password policy, monitoring, API controls, and operational costs. Production must use more protective data-removal settings. These are later-phase decisions, not implemented here.

## Queue behavior

Both source queues retain messages for four days, use a 30-second visibility timeout, and send messages to their respective DLQs after five failed receives. DLQs retain messages for 14 days. All four queues are Standard and use SQS-managed encryption.

Queue-wide delay is zero. Future reservation code will set per-message delay timers for the approved eight-minute reservation strategy. Queue visibility must be reviewed against worker execution time when workers are added. There are no event source mappings, scheduling jobs, email/SMS services, or notification consumers yet.

## IAM and logging

The Application Lambda role has no managed policies and permits only `logs:CreateLogStream` and `logs:PutLogEvents` on its own pre-created log group. It cannot access the tables, queues, bucket, or user pool. API Gateway receives route-scoped permission to invoke the Lambda.

The log group's CloudFormation ARN includes a stream wildcard so Lambda can create and write its runtime-generated log streams; it does not grant access to other groups. The bucket's CDK-generated secure-transport policy uses `s3:*` and principal `*` in an explicit **Deny** scoped to this bucket and its objects, preventing insecure requests from any caller. The object ARN's `/*` covers all objects. These wildcards do not grant broad access. API Gateway's CDK-generated invocation ARN uses stage and method wildcards on `/health`; the API exposes only `GET /health`. It is scoped to this API and Lambda, not other APIs or functions.

Only Lambda operational logging is configured now. API access logs, dashboards, and alarms are deferred. No log-retention custom-resource function or broad basic-execution managed policy is needed.

## Local validation and CI

From `infra/`:

```sh
npm ci
npm run typecheck
npm test
npx cdk synth
npm audit
```

The pinned local CDK CLI runs `npm run build` before loading the compiled app. TypeScript also compiles `backend/src/health.ts`; its compiled directory is the Lambda asset. Tests use Node's built-in test runner and CDK assertions, including queue-to-DLQ and route-to-Lambda relationships, restrictive IAM, private media, naming/tags, and health JSON.

`cdk.json` disables lookups, version reporting, and CLI telemetry. A clean checkout requires Node/npm and npm registry access for installation, but no AWS credentials. CI has separate web and infrastructure validation jobs. It does not configure AWS authentication or perform deployment. If synthesis requests credentials, stop rather than establishing an AWS connection.

Generated `infra/dist/` and `infra/cdk.out/` are ignored. Synthesis outputs include the API endpoint, three table names, four queue names, administrator pool ID, and media bucket name. These remain CloudFormation tokens until an eventual approved deployment.

## Version choices and scope

Pinned dependencies: `aws-cdk-lib` 2.269.0, local `aws-cdk` CLI 2.1142.0, `constructs` 10.8.1, TypeScript 5.9.3, and `@types/node` 24.10.1. CLI and library version numbers follow separate release sequences. The Node/npm baseline remains 24.19.0 / 11.11.0.

AWS documents [Node.js 24 Lambda support](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) and the CDK [Node 24 runtime constant](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda.Runtime.html). The runtime is explicitly pinned to `NODEJS_24_X` rather than a moving latest value.

Deferred: deployments, credentials, account setup, ecommerce behavior, reservations, payments/Stripe, worker functions, customer authentication, admin UI, SES/SMS, EventBridge reminders, media delivery, and final brand design. Phase 3B requires separate human authorization.

## Local verification record

Validated with Node 24.19.0 and npm 11.11.0:

- Both packages: clean lockfile installation with `npm ci` (using the local npm cache offline).
- Web: typecheck, lint, 7 tests, production build, and repository formatting passed.
- Infrastructure: typecheck, compilation, all 10 tests, and CDK synthesis passed.
- Synthesis ran with credential environment variables removed, shared credential/config paths set to `/dev/null`, and instance metadata disabled. No AWS connection was required. CDK supplied its default Region during CLI synthesis; the source has no fixed Region or account ID.
- Online infrastructure audit: zero vulnerabilities. No new dependency risk needs recording.
- Online web audit: the existing one moderate (`next`) and one high (`postcss`) finding remain. Path: web → next@15.5.24 → postcss@8.4.31. The audit proposes Next.js 16.3.5, a major upgrade outside the approved baseline; no safe in-baseline automatic fix was reported and no fix or override was applied. Existing ESLint 9 support warning remains.
- CDK reports unconfigured optional feature flags; defaults are left unchanged in this phase and locked dependency versions make them reviewable.

The approved governing documents already failed Prettier before this change. They are now explicitly excluded from automatic formatting to preserve them verbatim; all other repository formatting checks remain active. No governing document or existing dependency risk record was modified.

This verifies local templates and the handler, not deployed AWS behavior. The updated GitHub Actions workflow still needs its first remote run after a human-approved commit/push.
