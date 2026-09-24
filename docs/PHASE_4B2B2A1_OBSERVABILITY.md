# Phase 4B2B2A.1 — API and Lambda observability

## Purpose and scope

The publish-response investigation could verify deployed code and identify separate Lambda invocations, but could not associate the reported API Gateway request ID with a route or invocation. This phase supplies request correlation for future investigations. It does not establish the cause of that historical observation and cannot recover logs that were never collected.

Implementation starts from main `21d98f2`, after the publish-response regression tests were merged. Only observability changes: response bodies and headers, status mappings, authorization, repository calls, readiness, transactions, storefront visibility, and lifecycle behavior are preserved. No dependency or lockfile change is needed. No live acceptance request or deployment is performed in this phase.

## API Gateway access logs

The existing HTTP API `$default` stage keeps its logical identity and automatic deployment setting. It gains a dedicated log destination, `/aws/vendedlogs/apigateway/batch-and-batter-dev-http-api`, with **14-day retention** and the existing development convention of deletion on stack removal. The existing Lambda log group also retains its 14-day retention.

The format is a JSON object with string-valued substitutions. Missing Gateway values can be `-`; consumers must not assume numeric fields always contain numbers.

| Field                   | HTTP API variable                  | Meaning                                                                    |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| requestId               | `$context.requestId`               | Gateway request identifier                                                 |
| routeKey                | `$context.routeKey`                | Matched route                                                              |
| httpMethod              | `$context.httpMethod`              | HTTP method                                                                |
| path                    | `$context.path`                    | Request path, excluding arbitrary query-string contents                    |
| status                  | `$context.status`                  | HTTP response status                                                       |
| responseLength          | `$context.responseLength`          | Response payload bytes                                                     |
| integrationStatus       | `$context.integrationStatus`       | Lambda service invocation status, distinct from the function's HTTP status |
| integrationErrorMessage | `$context.integrationErrorMessage` | Gateway integration diagnostic, not an application exception dump          |
| integrationLatency      | `$context.integrationLatency`      | Integration duration in milliseconds                                       |
| integrationRequestId    | `$context.integration.requestId`   | AWS integration endpoint request identifier, when available                |
| requestTime             | `$context.requestTime`             | Gateway request time                                                       |

All selected variables are supported for HTTP APIs. Source IP is available but deliberately omitted because these diagnostics do not need that personal data. See [AWS HTTP API logging variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging-variables.html).

## Lambda completion records

Each normally completed handler request emits one JSON message:

```json
{
  "event": "request.completed",
  "requestId": "example-gateway-request",
  "lambdaRequestId": "example-lambda-request",
  "routeKey": "POST /admin/drops/{dropId}/publish",
  "operation": "publishDrop",
  "statusCode": 409,
  "code": "STOREFRONT_OCCUPIED"
}
```

`requestId` comes from `event.requestContext.requestId`; `lambdaRequestId` comes from the optional Lambda context `awsRequestId`. No tracing identifier is invented. Missing or malformed identifiers are omitted, using a bounded character allowlist. This does not alter existing response request IDs. All normal AWS identifier forms are accepted.

`statusCode` is the actual returned numeric status. `code` is included only for errors from a fixed application-code allowlist. Success records have no error code. Unexpected failures use status 500 and `INTERNAL_ERROR`, without raw messages, stack traces, or SDK details. They use `console.error`; other completion records use `console.info`. A logging transport failure is swallowed so it cannot turn a committed publication into an apparent failure or cause another repository operation.

The helper explicitly selects fields; it never serializes the event, context, response body, or exception. Unsupported route keys are logged as `unmatched`, rather than copying arbitrary input. A recognized route with a mismatched HTTP method still records the supplied recognized Gateway route and the existing 404 result; dispatch behavior is unchanged.

| Route                                             | Operation          |
| ------------------------------------------------- | ------------------ |
| GET /health                                       | health             |
| GET /drops/current                                | getCurrentDrop     |
| GET /drops/{dropId}                               | getDrop            |
| GET /admin/me                                     | getAdminIdentity   |
| POST /admin/products                              | createProduct      |
| PUT /admin/products/{productId}                   | replaceProduct     |
| POST /admin/drops                                 | createDraftDrop    |
| PUT /admin/drops/{dropId}                         | replaceDraftDrop   |
| GET /admin/drops/{dropId}/composition             | getDropComposition |
| POST /admin/drops/{dropId}/products               | attachDropProduct  |
| PUT /admin/drops/{dropId}/products/{productId}    | replaceDropProduct |
| DELETE /admin/drops/{dropId}/products/{productId} | removeDropProduct  |
| PUT /admin/drops/{dropId}/pickups/{date}          | putPickup          |
| DELETE /admin/drops/{dropId}/pickups/{date}       | removePickup       |
| POST /admin/drops/{dropId}/publish                | publishDrop        |

## Correlation workflow

1. Preserve the HTTP method, route, UTC time, status, and Gateway `apigw-requestid` response header. Lambda-generated error bodies already include the same Gateway-supplied request ID. Success DTOs are unchanged.
2. Select the API access-log group in CloudWatch Logs Insights and restrict the time range. Use the identifier from that response, not an adjacent command:

   ```text
   fields @timestamp, requestId, httpMethod, routeKey, path, status,
          responseLength, integrationStatus, integrationRequestId
   | filter requestId = "example-gateway-request"
   | sort @timestamp asc
   ```

3. Select `/aws/lambda/batch-and-batter-dev-api` for the same window:

   ```text
   fields @timestamp, requestId, lambdaRequestId, routeKey, operation, statusCode, code
   | filter requestId = "example-gateway-request"
   | sort @timestamp asc
   ```

4. Use `lambdaRequestId` to locate the corresponding START/END/REPORT records. If automatic JSON field discovery is unavailable, search `@message` for the exact identifier. The shared Gateway ID is the primary cross-log join; the integration endpoint request ID is supplementary and must not be assumed identical to the Lambda invocation ID without checking.
5. Compare route, status, and response length across the two sources. Capture only the selected diagnostic fields when sharing evidence. No new successful publication is needed merely to inspect logs.

## Data exclusions and limits

No Authorization header, access token, cookies, request/response bodies, password, API key, query-string contents, customer email/phone, JWT claims, payment fields, or raw Lambda event is deliberately selected. Application logs also omit raw paths, path parameters, record identifiers, identity responses, and raw exceptions. There is no HTTP data tracing or X-Ray.

Gateway's requested `path` is the actual URL path. Current supported paths use resource identifiers and dates; secrets and customer contact details must never be embedded in URLs. Gateway substitutions do not provide application-level redaction of arbitrary caller-supplied path text, including unmatched paths. The integration diagnostic is Gateway-controlled; future integrations must not insert sensitive content into those diagnostics. The static JSON format is tested offline; runtime substitution/escaping and successful log delivery require separately approved deployment and acceptance verification.

Requests rejected by Gateway before Lambda invocation have no application completion record. Initialization failures, timeouts, forced termination, and log-delivery failures can also leave no completion record. Logs are diagnostic evidence, not durable business audit history or proof that a database transaction committed. The logger deliberately does not inspect repository results or add reads to infer transaction outcomes. Retention expires after 14 days; new routes must be added to the fixed operation map. No alerts, dashboard, distributed traces, or sampling are introduced. X-Ray is deferred because these request identifiers address the immediate gap without adding tracing configuration, IAM, or dependencies.

## Infrastructure and IAM

Changes are limited to one `AWS::Logs::LogGroup`, `AccessLogSettings` on the existing `HttpApiDefaultStage3EEB07D6`, and the existing Lambda code asset. No API, Lambda, table, Cognito, queue, bucket, or business-role identity changes. No explicit resource policy or new role is added by this template.

HTTP API access logging uses the normal AWS CloudWatch log-delivery mechanism. The deployment identity needs the CloudWatch log-delivery/resource-policy administration permissions documented by [AWS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging.html). AWS may manage a delivery resource policy when a future deployment enables logging. Those are deployment/logging capabilities, not Lambda business permissions; this phase does not grant or exercise them through a deployment. The vended-log group prefix follows AWS log-delivery conventions. Lambda's existing scoped `logs:CreateLogStream`/`logs:PutLogEvents` and CatalogTable policy remain exactly unchanged. No REST API account-wide CloudWatch role is introduced.

The pre-edit fixture `infra/test/fixtures/phase-4b2b2a-resources.json` was captured from clean main before changes. Infrastructure tests compare every previous logical resource against it, allowing only Lambda Code and stage AccessLogSettings changes, and exactly one added LogGroup. The earlier protected-resource checks remain in force.

## Validation

Completed locally:

- Backend: `npm ci`, typecheck, build, **235 functional tests** and **5 artifact tests** passed. Tests cover public/admin success, recognized conflict, unexpected admin/public failure, all route operation names, safe field selection, absent context, malformed identifiers, unrecognized routes/codes, and failed logging transport without publication retries. The isolated artifact test checks both the completion log and the unchanged health response.
- Infrastructure: `npm ci`, typecheck/build, **17 tests**, and `npx cdk synth --lookups=false` passed. The fixture comparison preserves all previous resources, business IAM, and resource identities.
- Backend and infrastructure `npm audit --json`: **zero vulnerabilities**. No audit fix, dependency change, or lockfile change.
- Repository-wide formatting and `git diff --check` passed.
- Existing tooling notices remain: esbuild install-script approval notice during backend installation; 83 unconfigured CDK feature flags. Builds and artifact checks pass without changing those configurations.
- The read-only development CDK diff succeeded with `--profile batch-and-batter-dev --no-change-set --lookups=false` after the user refreshed AWS SSO. It proposes exactly one new access-log LogGroup, AccessLogSettings on the existing default stage, and the existing Lambda code asset/asset metadata update. No resource replacements or deletions, IAM changes, table/Cognito/API identity changes, queues, S3 changes, or EventBridge resources. No change set was created. The saved local output is `/private/tmp/batch-observability-aws-diff.log`.

No commit, push, deployment, DynamoDB write, or Cognito mutation occurred. Suggested commit after review: `feat: add API request observability`.
