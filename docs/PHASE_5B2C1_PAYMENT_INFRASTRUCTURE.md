# Phase 5B2C1 — payment infrastructure, admission disabled

**PAYMENT_START_ENABLED=false**

**NO STRIPE SECRET VALUES ARE PROVISIONED.**

**NO LIVE PAYMENT FLOW IS ENABLED.**

Local implementation and read-only diff only. No deployment is authorized by this phase.
AWS dev remains at its previously authorized Phase 5A2 deployment until a separate 5B2C2 gate.

## Admission and HTTP boundary

The production Application handler routes start/confirm/payment GET through the existing
capability/ETag/idempotency contracts. API Gateway authorization is NONE for these routes.
Only the literal string `true` enables NEW start; missing/malformed configuration is false.
The repository defaults admission false, checks an existing receipt first, and otherwise
returns 503 PAYMENTS_DISABLED/no-store before provider access, handoff, new identifiers or
queue dispatch. A matching committed receipt replays safely; mismatched reuse still conflicts.
Recovery, valid admitted continuation, customer GET, webhooks, deadline work and settlement
are never gated by admission. This is not a financial kill switch.

Application is intentionally increased to 15 seconds/256 MiB. Its provider interface has
read methods only; workflow command methods fail closed. Health/catalog/ordinary cart paths
never initialize or load Stripe credentials. Dev pricing remains the explicitly named
zero-tax/zero-fee fixture; this is not a production pricing policy.

## Resources and delivery

- Standard `batch-and-batter-dev-payment`: SSE-SQS, retention 4 days, visibility 180 seconds.
- Standard `batch-and-batter-dev-payment-dlq`: SSE-SQS, retention 14 days; redrive after 5 receives.
- Dedicated `batch-and-batter-dev-payment-worker`: Node 24, 256 MiB, 30 seconds, reserved concurrency 2.
- Mapping: enabled, batch 1, window 0, partial failures, maximum concurrency 2. Empty queue is safe
  during bootstrap; absent account/secret makes real messages fail closed and retry, not disappear.
- Dedicated `batch-and-batter-dev-stripe-webhook`: Node 24, 256 MiB, 10 seconds, reserved concurrency 2.
- Both functions have dedicated roles and 14-day log groups.
- POST /webhooks/stripe and the three customer payment routes have route-scoped API invocation permissions.

Worker accepts PAYMENT, WORKFLOW (the queue representation of PAYMENT_WORKFLOW), STRIPE_EVENT;
never SHOPPING. Application start dispatches workflow/deadline only after the 11-action transaction;
confirmation and worker transitions dispatch through their existing durable port. Send errors never
roll back accepted state. Messages contain pointers/revisions only and use bounded SQS delay.
Reconciler recovers missed sends; successful sends do not delete work. Existing 16-shard rotation,
fixed cutoff, cursor CAS, bounded pages, poison progress and interleaving remain.

Shopping worker IAM/configuration is unchanged. Built shopping/reconciler bundles are checked for
absence of Stripe SDK/provider, SSM and financial settlement code. No payment receive access is added
to shopping. Existing application asynchronous config and opening/expiry schedules are unchanged.

## Secrets, account and KMS

References only (no CloudFormation SSM parameter resources or plaintext dynamic references):

- /batch-and-batter/dev/stripe/payment-worker-key
- /batch-and-batter/dev/stripe/payment-read-key
- /batch-and-batter/dev/stripe/webhook-signing-secret

Runtime GetParameter uses WithDecryption, requires SecureString, caches success for 60 seconds,
and never caches failure. Missing webhook secret returns sanitized 503 without creating receipts;
subsequent invocations recover after provisioning. No fake values are required for deployment.

StripeSandboxAccountId is a NONSECRET CloudFormation parameter, default empty. Empty/invalid account
or environment prevents provider commands. Expected environment is dev, keys must be restricted test
keys, and canonical validation rejects live/non-manual/non-card Intents. Actual sandbox identity and
restricted-key grants remain provisioning verification gates; a key prefix is not proof of account.
Stripe remains 22.6.2 / 2026-08-26.dahlia, maxNetworkRetries=0. Webhook version is configured separately.

Symmetric CMK `alias/batch-and-batter-dev-stripe`: rotation enabled; key retained on deletion/replacement.
Standard CDK account-root administration delegates key management through IAM; runtime role policies
contain only exact-key Decrypt with BOTH StringEquals conditions:

- kms:ViaService = ssm.us-east-2.amazonaws.com (derived from stack region)
- kms:EncryptionContext:PARAMETER_ARN = role's exact SSM parameter ARN

The encryption-context key is documented by AWS:
https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html

No runtime role receives parameter-write or key-administration authority. Provisioner permissions
are separate and deferred; no provisioning role/credentials are invented by this phase.

## IAM boundaries

All business resources are exact table/queue ARNs; no indexes, runtime Scan, UpdateItem, broad SSM path
or broad business IAM. Own-log-group CreateLogStream/PutLogEvents only.

| Principal   | Payment permissions                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application | Preserve prior policies; Commerce ConditionCheckItem; payment SendMessage; read-key GetParameter and constrained Decrypt                                                    |
| Worker      | Catalog Get/Put; Commerce Get/Put/ConditionCheck; Operations Get/Put/Delete/ConditionCheck; payment Receive/Delete/GetQueueAttributes/Send; worker-key GetParameter/Decrypt |
| Webhook     | Operations Get/Put; payment SendMessage; signing-secret GetParameter/Decrypt                                                                                                |
| Reconciler  | Only payment SendMessage added; no secrets or Commerce reads                                                                                                                |
| Shopping    | No additions                                                                                                                                                                |

Webhook preserves raw bytes/base64 handling and 256 KiB decoded bound; SDK verifies signature with
explicit 300-second tolerance before processing. Environment/account checks and durable receipt+inbox
precede 200. It never issues financial provider commands. Signing secret belongs to the registered
sandbox endpoint; direct-account events need not carry event.account. No request/provider body logging.

## Monitoring projection and metrics

V3 financial workflow work gains OPTIONAL `monitoring`, preserving legacy V2/V3 validators:

- committingDeadline: authoritative Cart committingDeadline
- captureVerifiedAt: execution.captureEvidence.verifiedAt
- recoveryStartedAt: execution.recoveryStartedAt
- consecutiveReadFailures: execution counter, default zero
- unknownOutcome: execution.recoveryRequired, default false

Projection is generated in both workflow transition builders and written in the SAME transaction as
Attempt/Cart changes. It is diagnostic only, never authority for capture/release. Initial V2 work has
no financial claim/evidence and remains unchanged; the next transition supplies projection.
No PII, secrets, business IDs or extra table/index/TTL are introduced for monitoring.

Namespace BatchAndBatter/Payments; dimensions Environment=dev and bounded Component worker/webhook/reconciler.
EMF uses existing log permission, no PutMetricData wildcard permission.

The reconciler performs an independent first-page consistent Query (25 items maximum) per shard to
include future backoff work and records behind the dispatch cursor, plus observes routed work. If any
monitoring page is truncated, dispatch coverage incomplete, shard unvisited, invalid work found, or
operation fails, it emits heartbeat 0 and suppresses zero age gauges. Positive gauges remain useful
lower bounds. Thus a backlog cannot silently assert complete healthy coverage. This conservative dev
bound can cause a coverage alarm under load; increasing it requires performance review. Normal healthy
empty/fully covered sweeps emit zero gauges so resolved alarms clear. No Scan or Commerce read needed.

## Alarms and delivery

17 alarms, one-minute periods: worker Errors/Throttles/failed messages >=1; queue age >=60s;
visible+in-flight backlog >=20 for 3 periods; DLQ visible >=1; webhook Errors/durable acceptance failure >=1;
workflow overdue >=60000ms for 2 periods; unknown outcome >=1; committing overdue >=1;
captured/unfinalized >60000ms; consecutive reads failed >=3; recovery age >900000ms;
settlement invariant conflict >=1; financial routing failure >=1; heartbeat <1 for 3 periods.

Heartbeat missing data is BREACHING; other alarms are NOT_BREACHING and rely on independent heartbeat
coverage. Worker partial failures have their own metric because Lambda Errors alone cannot detect them.
Webhook missing-secret failures count as acceptance failures. Age gauges are maxima, event counters sums.
An SNS topic policy permits CloudWatch Publish only from this account and the dev payment alarm ARN prefix.
All 17 attach to `batch-and-batter-dev-payment-alerts`. NO subscription is created. Existing expiry alarm
actions remain unchanged; adding their delivery is a separate explicit operational decision.

PAYMENT ENABLEMENT IS BLOCKED UNTIL A REAL EMAIL SUBSCRIPTION IS CONFIRMED.
See PAYMENT_RECOVERY_RUNBOOK.md. Later test actual alarm receipt, not merely SNS resource existence.

## Compatibility and future legacy gate

New readers retain ACTIVE/terminal legacy carts, SHOPPING V1 work, Operations cursors and old queue
messages. Old shopping deliveries cannot release PAYMENT_PENDING/PAYMENT_COMMITTING/CONVERTED ownership.
Deploy capable readers/workers before writers; wait for successful updates and old invocation drain.
Shared asset changes on existing Lambdas are expected, not grants of financial authority.

Before 5B2C2, reserve dev exclusively and perform the approved operator-only read gate: ACTIVE carts,
unexpected payment states, SHOPPING versions/coverage/overdue work, reservation visible/in-flight/delayed,
DLQ, storefront, and inventory ownership consistency. Bounded paginated operator Scan may be used;
it is not an atomic snapshot, so eliminate concurrent acceptance activity. No runtime Scan permission.
STOP on unexplained ownership or responsibility mismatch. No manual repair.

## Rollout, rollback and blockers

5B2C2 requires separate authorization for compatible disabled deployment, keys/account provisioning,
actual restricted-key grants, SecureString creation under this CMK, endpoint registration and signing
secret, worker/reconciler checks, alarm recipient confirmation and delivery test, and legacy gate.
Webhook signature readiness must not manufacture orphan financial work. Genuine Stripe delivery is
proved with the first controlled admitted test after a separate 5B2C3 gate.

Before ANY payment accepted: keep false, prove no financial responsibility, then reviewed rollback is possible.
After ANY payment accepted: disable NEW admission if necessary; DO NOT roll back to Phase 5A2. Preserve
worker/reconciler/webhook/queues/secrets/alarms/compatible readers until no payment-owned carts, PAYMENT,
PAYMENT_WORKFLOW, STRIPE_EVENT responsibility or unknown outcome remains. Historical schemas still require
compatible readers after queues drain. Unknown never releases; verified capture remains processing until
atomic local SOLD/CONVERTED/PAID/CAPTURED settlement. No manual capture or inventory repair.

5B2C3 controlled acceptance and 5B2C4 fault injection remain separately reviewed work. Production still
requires tax/fee policy, production credentials/webhook, operators, security/domain review, notifications,
Order management, refund/restock and production acceptance. Do not deploy merely because code merges.

## Subsequent recovery infrastructure boundary

The local [Phase 5B2C2A separation](PHASE_5B2C2A_RECOVERY_INFRASTRUCTURE_DLQ.md)
adds a dedicated reconciler/Scheduler infrastructure-failure DLQ and an alarm using the
existing payment-alerts topic. This is a later, separately gated change; the C1 results
above remain historical. Payment admission remains disabled. The recurring
EventAgeExceeded root cause remains unresolved; destination separation is not a fix.
