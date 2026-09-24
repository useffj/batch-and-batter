# Phase 4B2B2B2 — Automatic SCHEDULED → OPEN

## Architecture and scope

Publication first commits the existing DynamoDB publication transaction, then creates and verifies a one-time EventBridge Scheduler schedule. Scheduler invokes the existing application Lambda directly with an internal event. The automatic handler calls `DynamoCatalogRepository.openScheduled`, exactly as the existing manual HTTP operation does. There is no duplicated opening transaction or force-open path.

The existing manual-open response, JWT/admin enforcement, public current-Drop reads and successful publication `{ drop, storefront }` DTO remain unchanged. This phase adds an explicitly approved admin recovery route, not repeat-publication recovery. It does not implement pause, resume, close or sold-out transitions.

## Schedule contract

Group: `batch-and-batter-dev-openings`. Name: `open-<dropId>`, validated ULID, generated exclusively by the service. The runtime creates schedules; CloudFormation creates only the shared group and supporting configuration.

The schedule uses the persisted published Drop's `opensAt`, converted to UTC `at(yyyy-mm-ddThh:mm:ss)` with `ScheduleExpressionTimezone: UTC`, flexible window OFF, state ENABLED. Fractional seconds round upward to the next whole second so the expression cannot be earlier than the stored time. Scheduler has 60-second precision, so this is not a precise-second opening guarantee. The authoritative repository still checks server time.

The target is the exact unqualified application Lambda ARN, with the dedicated execution-role ARN and this strict input:

```json
{
  "source": "batch-and-batter.scheduler",
  "operation": "openDrop",
  "dropId": "<ULID>"
}
```

Extra keys, arbitrary operations and malformed IDs are rejected without repository access. API Gateway envelopes always take the HTTP path; HTTP bodies are never interpreted as internal events. Authentication for internal delivery is IAM permission to invoke Lambda, not possession of the source string. Existing independently privileged Lambda callers are consequently trusted; this event is not a public authentication mechanism.

## Publication failure boundary and recovery

DynamoDB and Scheduler are not atomic. After DynamoDB commits, the Drop remains SCHEDULED and the storefront pointer remains committed even if schedule creation, verification or configuration fails. A caught failure returns HTTP 503 `PUBLICATION_SCHEDULING_FAILED`, with the explicit message that the Drop was published but automatic opening could not be confirmed. No rollback occurs. A process crash or the existing five-second Lambda timeout can instead produce a transport failure with an ambiguous outcome. Operators must inspect the Drop after ambiguous publication responses.

The approved recovery operation is JWT/admin-protected `POST /admin/drops/{dropId}/reconcile-opening`, with no body or `{}`. It reads the Drop and storefront pointer, requires SCHEDULED and the same storefront Drop, and ensures/verifies the deterministic schedule. It does not write DynamoDB or execute opening. Success returns `{ "reconciled": true }`. Repeating `POST /publish` continues returning 409 `DROP_NOT_EDITABLE` once published.

Recovery responses:

- Missing Drop: 404 `DROP_NOT_FOUND`.
- Non-SCHEDULED Drop: 409 `DROP_NOT_EDITABLE`.
- Missing/other storefront pointer: 409 `STOREFRONT_CONFLICT`.
- Opening time already reached: 409 `OPENING_TIME_PASSED`; use the existing manual `/open` operation after inspection.
- Conflicting schedule configuration: 409 `OPENING_SCHEDULE_CONFLICT`; operator investigation is required. This service never overwrites the conflicting schedule.
- Unconfirmed service failure: 503 `OPENING_SCHEDULE_UNCONFIRMED`; retry reconciliation while the opening time is future.

This is explicit **operator-driven recovery**, not guaranteed eventual scheduling. There is no durable outbox, poller, queue, alarm or automatic repair process in this phase. The persisted Drop ID/status/time and pointer provide the reconstruction data. An unobserved failure can leave a Drop SCHEDULED until operator intervention. Schedule creation can race the deadline; a failed/ambiguous response must never be interpreted as proof the schedule is absent. Reconciliation reads are a point-in-time check: concurrent manual opening or pointer changes can make a newly created schedule unnecessary, but the opening transaction will reject it safely.

## Idempotency and cleanup

CreateSchedule uses a SHA-256 client token derived from the complete expected configuration and the deterministic group/name. After successful creation **or** ConflictException, GetSchedule verifies name, group, expression, timezone, window, enabled state, automatic deletion, exact target ARN/role/input and retry policy. Unexpected start/end bounds or a customer KMS key also fail verification. A successful idempotent Create response alone is insufficient evidence of matching current configuration. Ambiguous creation followed by retry therefore recovers the same schedule, without random-name duplicates.

`ActionAfterCompletion: DELETE` removes completed one-time schedules. Completion/deletion concerns Scheduler delivery; it does not prove the business transition succeeded. Deterministic naming prevents simultaneous duplicate schedules at that name, not lifetime recreation after deletion. Conditional DynamoDB writes provide state-transition idempotency across duplicate events and manual opening.

## Retry layers and terminal outcomes

Scheduler's templated Lambda target invokes **asynchronously**. Scheduler retries delivery failures (including invocation rejection/throttling) with `MaximumRetryAttempts: 3` and `MaximumEventAgeInSeconds: 900`. Those retries do not observe exceptions from a successfully accepted Lambda invocation.

The unqualified Lambda has explicit async configuration: two function-error retries, maximum event age 900 seconds. AWS normally waits about one minute before the first function-error retry and two minutes before the second. Lambda throttling/service failures follow its asynchronous queue backoff up to the event-age limit. The two systems' budgets are distinct; they are not a single guaranteed 15-minute end-to-end deadline. Synchronous HTTP invocations are unaffected by async retry configuration.

Automatic outcomes:

| Outcome                                                 | Handling                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Valid ready SCHEDULED Drop at/after opensAt             | One existing conditional transaction; log `opened`                                                                              |
| Before opensAt                                          | No commit; re-read distinguishes early readiness failure, log `OPENING_TOO_EARLY`, throw sanitized error for Lambda async retry |
| Composition/Product revision conflict                   | Log `COMPOSITION_CONFLICT`; throw sanitized retry error                                                                         |
| AWS/service/unexpected failure                          | Log `INTERNAL_ERROR`; throw sanitized retry error                                                                               |
| Already manually OPEN or any other non-SCHEDULED status | Benign terminal `DROP_NOT_EDITABLE`; no rewrite                                                                                 |
| Drop missing                                            | Terminal `DROP_NOT_FOUND`                                                                                                       |
| Storefront missing/changed                              | Terminal `STOREFRONT_CONFLICT`                                                                                                  |
| Invalid readiness at/after opening time                 | Explicit error-level `rejected`, `DROP_NOT_READY`; operator repair/manual opening required                                      |
| Malformed internal event                                | Error-level `rejected`, `INVALID_INTERNAL_EVENT`; no repository access                                                          |

A slightly early delivery can recover through Lambda retries; excessively early events or exhausted retries require intervention. There is no DLQ/failure destination added. AWS can discard asynchronous events when retry/age limits are exhausted. Inspect logs and Lambda async failure/drop metrics, and use manual opening after correcting readiness. Automatic delivery is not an exactly-once or guaranteed eventual opening mechanism.

## Shared transaction authority

`openScheduled` retains existence, SCHEDULED status, server time >= stored opensAt, storefront equality, composition readiness, active Product checks, Drop/Product revision guards and the 100-action bound. It writes only Drop META and condition-checks the pointer and active referenced Products, with unique item targets. Inventory and reusable Products are not modified. Only the first valid concurrent automatic/manual attempt can commit. Manual opening before scheduled delivery leaves the automatic attempt benignly terminal.

## IAM and infrastructure

New Scheduler execution role trusts only `scheduler.amazonaws.com`, conditioned on the current AWS account and exact schedule-group ARN. Its sole permission is `lambda:InvokeFunction` on the exact application function ARN, without qualifier wildcard. It has no DynamoDB or other service access.

Application execution-role additions:

- `scheduler:CreateSchedule` and `scheduler:GetSchedule` only on `arn:<partition>:scheduler:<region>:<account>:schedule/batch-and-batter-dev-openings/open-*`.
- `iam:PassRole` only on the dedicated Scheduler role, conditioned on `iam:PassedToService = scheduler.amazonaws.com`.

Existing scoped log writes and the five existing CatalogTable actions remain unchanged. No Scheduler Update/Delete/List, wildcard service actions, new DynamoDB access, Cognito, S3 or SQS permissions are added.

CloudFormation additions: one schedule group, execution role/policy, Lambda EventInvokeConfig, and the admin reconciliation route/integration/route-scoped invocation permission. Existing Lambda code/environment and execution-role policy change. Target ARN is constructed from the existing fixed function name to avoid a role/function dependency cycle. Existing logical resource identities and table/Cognito/queue/bucket configuration are preserved.

## Observability

Automatic records use `event: automatic_open.completed`, `operation: autoOpenDrop`, safe Lambda request ID when supplied, source marker, result and optional controlled domain code. No raw event, Drop ID, SDK exception payload, token, credentials or HTTP body is logged. Retry exceptions contain only a controlled code. Malformed/readiness failures and retryable outcomes use error-level logs. Manual opening retains `openDrop`; reconciliation uses `reconcileOpening` in existing safe HTTP completion logs.

## AWS references

- [Scheduler Lambda targets use asynchronous invocation](https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html)
- [Lambda async error handling](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html)
- [One-time schedules and 60-second precision](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)
- [Automatic schedule deletion](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-delete.html)
- [Scheduler confused-deputy protections](https://docs.aws.amazon.com/scheduler/latest/UserGuide/cross-service-confused-deputy-prevention.html)

## Validation

Validated locally on 2026-09-24 on `feature/phase-4b2b2b2-auto-open`, based on main `d57a35ac4b9f08764b81773599ad05f61c0a0d0e`:

- Backend: `npm ci`, typecheck and build passed; 313 functional tests and 5 artifact tests passed. Audit: zero vulnerabilities.
- Infra: `npm ci`, typecheck and build passed; 18 tests passed; `cdk synth --lookups=false` passed. Audit: zero vulnerabilities.
- All changed/new files passed Prettier checking; `git diff --check` passed.
- Read-only `cdk diff batch-and-batter-dev --profile batch-and-batter-dev --no-change-set --lookups=false` passed against the development stack. Seven resources are added (group, role, policy, async invocation config, reconciliation integration/permission/route). Existing application policy and Lambda code/environment change exactly as described above.
- No resource replacements or deletions; no DynamoDB, Cognito, S3, SQS or unrelated infrastructure changes. Existing Catalog permissions are unchanged.

Offline coverage includes deterministic schedules, exact target/retry/cleanup configuration, conflicting schedules, ambiguous accepted creation, committed publication failure/recovery, early/equal/late opening, concurrent delivery, Product revision conflict, terminal lifecycle states, HTTP/internal-event isolation, sanitized logs and exact IAM/trust/configuration assertions. Existing manual, public and publish DTO tests remain intact.

No deployment, live schedule creation, data mutation, commit or push was performed. Live automatic-opening acceptance remains pending separate deployment approval.
