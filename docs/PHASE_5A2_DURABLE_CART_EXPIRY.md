# Phase 5A2 — durable Cart expiry and automatic inventory release

Implementation only; deployment and live acceptance require separate approval.
Branch: `feature/phase-5a2-durable-cart-expiry`.
Baseline main: `8383d7dd8e733ae23bbda68f00950dfa84aaa49e`.

## Ownership and durable work

ACTIVE Carts own all embedded line quantities, including after their shopping
deadline. CANCELLED and EXPIRED own zero; their embedded lines are history.
Passing time, GET, a queue send, or DLQ delivery never changes ownership.
The only release transition is an atomic transaction returning Inventory,
terminalizing the exact ACTIVE Cart revision, and deleting matching expiry work.

OperationsTable work:

```text
PK = CART_EXPIRY#V1#<shard>
SK = <canonical-shoppingExpiresAt>#SHOPPING#<cartId>
schemaVersion = 1
cartId = canonical ULID
deadlineType = SHOPPING
deadline = Cart.shoppingExpiresAt (canonical UTC ISO, millisecond precision)
createdAt = Cart.createdAt
```

Shard = low four bits of the first SHA-256 byte of canonical cartId, uppercase
hexadecimal padded to two digits, `00` through `0F`. This versioned derivation
must not change without a migration plan. Work contains no capability, capability
hash, idempotency key, quantities, or customer information. Its continued
existence means outstanding evidence, never merely “not yet sent.”

## Create and dispatch

The existing create transaction preserves ordering: Drop ConditionCheck,
storefront ConditionCheck, sorted reusable Product checks, sorted Inventory Puts,
Cart Put, idempotency receipt Put, then expiry-work Put. Work uses
`attribute_not_exists(PK)`. Deadline and work are constructed from the same
successful attempt. Any work collision cancels every ownership/receipt write.

For N products: `5 + 2N`, maximum 29 for 12 lines. PUT remains unchanged:
maximum acquisition/substitution 40, reduction 14. ACTIVE DELETE is `H + 3`,
maximum 15. Automatic expiry is `H + 2`, maximum 14. Cleanup is two actions.
Every transaction targets distinct table/PK/SK identities.

After commit, the application makes a bounded SQS dispatch attempt. It verifies
that current Cart is ACTIVE and matching work still exists, including on receipt
replay. Each dispatch-path read/send is capped at 400 ms and the Lambda remaining
time minus a 200 ms response margin. Dispatch failure leaves the committed
response unchanged and emits only a safe failure metric. Receipt replay preserves
its historical response; it never recreates work or reclaims inventory.
Recovery does not depend on replay.

```json
{
  "schemaVersion": 1,
  "source": "batch-and-batter.cart-expiry",
  "operation": "expireCart",
  "cartId": "<canonical ULID>",
  "deadlineType": "SHOPPING",
  "deadline": "<canonical UTC ISO timestamp>"
}
```

Bodies strictly reject unknown fields, invalid IDs/times, and other deadline
kinds. Delay is `min(900, max(0, ceil((deadline - serverNow) / 1000)))`.
No timezone conversion changes the instant. Early worker delivery requeues with
at least one second remaining delay; acknowledgment requires successful send.

## Worker and exact release transaction

Dedicated `expiry-worker-handler.handler`, no route or function URL. It accepts
one SQS record, exact configured reservation queue ARN, `eventSource=aws:sqs`,
and the strict body. HTTP envelopes are rejected. Envelope validation is not a
cryptographic source proof: deployed invocation/IAM boundaries authorize SQS;
a principal separately permitted direct Lambda invocation remains privileged.

Every wake-up consistently reads authoritative Cart. Missing/malformed/future
states fail closed with evidence retained. Matching ACTIVE before deadline
requeues; matching ACTIVE at/after deadline reads every current Inventory item
consistently. No Drop, storefront, Product, or DropProduct guard is required to
return inventory.

For H lines, sorted by product ID:

1. Indexes 0..H-1: Catalog Inventory Puts, exact Phase 5A1 snapshot predicate:
   `attribute_exists(PK) AND #total = :total AND #reserved = :reserved AND #sold = :sold AND #updated = :expected`.
   Names map to total/reserved/sold/updatedAt; values are the exact read snapshot.
   New reserved is old reserved minus that Cart's current line quantity. Validate
   safe integer, nonnegative reserved/sold and reserved + sold <= total; preserve
   total/sold. Inventory updatedAt strictly advances.
2. Index H: Commerce Cart Put ACTIVE -> EXPIRED:
   `attribute_exists(PK) AND #status = :active AND #updated = :updated AND #expires = :expires AND #expires <= :now`.
   Names are status/updatedAt/shoppingExpiresAt. Values are ACTIVE, exact Cart
   revision, expected message deadline, and freshly sampled server UTC time.
   Preserve embedded lines as history and strictly advance Cart updatedAt.
3. Index H+1: Operations work Delete at the exact derived shard/key:
   `attribute_not_exists(PK) OR (#cart = :cart AND #type = :type AND #deadline = :deadline AND #version = :version)`.
   Names are cartId/deadlineType/deadline/schemaVersion. Values are exact cartId,
   SHOPPING, expected deadline, 1. Absence is safe; conflicting work is not.

Work conditional failure becomes INVALID_WORK and retains everything. Invalid
persisted data becomes INVALID_STATE; missing Cart MISSING_CART. Other service,
ambiguous response, or transactional failures retry from fresh authoritative
reads at most six attempts, full jitter caps 25/50/100/200/250 ms, five-second
business budget, one-second Lambda safety margin. Exhaustion is RETRY_EXHAUSTED.
No raw AWS cancellation data is logged. Ambiguous success safely rereads terminal
state. Customer stale PUT is never silently rebased; worker retries may rebase.

## Terminal/obsolete cleanup refinement

CANCELLED/EXPIRED or an ACTIVE Cart with a different deadline cannot be released
by this message. Cleanup uses **ConditionCheck + work Delete**, never an unchanged
Cart Put. ConditionCheck:

`attribute_exists(PK) AND #status = :status AND #updated = :updated AND #expires = :expires`

It checks the exact Cart status, revision, and current shopping deadline read.
The work Delete uses the old message's exact key and guarded identity above.
No Cart revision or ETag changes. Worker Commerce ConditionCheckItem IAM is
intentional. Future unsupported Cart states fail validation instead of entering
this cleanup until their ownership protocol is deliberately implemented.

## DELETE, PUT and lifecycle races

Customer DELETE includes matching work deletion in the transaction with Inventory,
Cart and receipt. At/after deadline it persists EXPIRED; before it CANCELLED.
Already-terminal DELETE does not decrement inventory. Exactly one ACTIVE revision
can win release. Losing worker rereads; losing customer mutation preserves the
existing CART_CONFLICT/idempotency semantics. Repeated DELETE cannot double release.

Pre-deadline PUT that commits before worker invalidates worker snapshots. Worker
rereads new quantities and releases those. Worker winning first invalidates PUT's
ACTIVE/revision guard. Shopping deadline remains immutable; post-deadline PUT
validation rejects. As in Phase 5A1, time is sampled by the application, not by a
DynamoDB clock: an in-flight pre-deadline validated PUT may commit later if its
revision still wins, after which expiry releases the new authoritative quantities.
PAUSED/CLOSED, missing storefront, and deactivated Products do not block release.
No lifecycle changes or persisted SOLD_OUT; available is derived from inventory.

## SQS and durable recovery

Reuse Standard `batch-and-batter-dev-reservation` and its DLQ, SQS-managed encryption,
4-day source/14-day DLQ retention, redrive after five receives. Change source
visibility only: 30 -> 60 seconds. Worker timeout 10 seconds, memory 256 MiB,
reserved concurrency 5, event source maximum concurrency 5, batch one, window zero,
ReportBatchItemFailures. The 60-second visibility follows AWS's six-times-timeout
[guidance](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html).

Per-record failures return batchItemFailures, not a false successful acknowledgment.
Malformed envelopes throw safely. Repeated failures eventually reach DLQ. DLQ is
forensic evidence, not the recovery authority: outstanding work survives retention,
so reconciliation creates fresh wakeups even if the original message was lost or
DLQed. No automatic DLQ consumer/redrive is needed for business recovery.

## Reconciliation and pagination

Dedicated `expiry-reconciler-handler.handler`: 30-second timeout, 256 MiB, reserved
concurrency one, approximately 25-second processing budget and 1.5-second margin.
Dedicated schedule group `batch-and-batter-dev-cart-expiry-recovery`, recurring
`rate(1 minute)`, flexible window OFF, enabled. Templated Lambda target, internal
strict version/source/operation payload. Scheduler retries twice, event age 120s,
exact existing reservation DLQ for delivery failure. Reconciler $LATEST async config
also retries twice, max age 120s, OnFailure reservation DLQ, no OnSuccess. Existing
application EventInvokeConfig and Drop-opening schedule resources are unchanged.

Visit the 16 known shard partitions, rotating first shard by UTC epoch minute mod
16 so a time budget does not always privilege the same prefix. Each invocation
examines at most 25 work records per shard (400 overall), subject to time budget.
Queries are consistent, ascending, use no FilterExpression or Scan:

`PK = :pk AND SK <= :upper`, upper = `<roundCutoff>#~`.

Cursor Operations key `CART_EXPIRY_RECONCILE#V1 / SHARD#<shard>` stores fixed
roundCutoff, nullable lastProcessedKey, and random UUID revision. Cursor Put uses
revision equality or attribute_not_exists(PK) for first creation. Within a round,
respect LastEvaluatedKey and one-MB pagination while keeping cutoff fixed.
Persist only the last examined key if interrupted inside a page; after complete
round store null and start next round from the beginning with a fresh cutoff.

Send valid work with DelaySeconds zero. Send never deletes or marks work complete.
Malformed/failed records advance cursor for fairness but remain discoverable next
round. Insertions behind the cursor are found next round. Failed cursor checkpoint
or crash repeats sends safely. Failed shards do not stop attempts on other shards;
aggregate failures throw a safe error for async retry. No age cutoff or historical
lookback can lose work older than SQS/DLQ retention. There is no claimed atomic
count of a changing backlog: examined records are a bounded lower-bound signal.
An independent first-due-item query per visited shard measures oldest overdue age
regardless of cursor position. Permanent corrupt cursors/items require operator
attention; they are retained, never guessed or silently discarded.

## Metrics, alarms and safe logging

Fixed operations dispatchCartExpiry, expireCart, reconcileCartExpiry. Safe
correlation: validated cartId/deadline, message ID, receive count, Lambda request ID;
metrics include attempts, lateness, bounded examined/sent/visited/failure counts.
No capabilities, hashes, idempotency keys, PII, raw bodies, raw AWS errors or full
Cart objects. Embedded metrics namespace BatchAndBatter/CartExpiry, Service dimension
batch-and-batter-dev. No runtime PutMetricData permission.

Fourteen alarms, no external notification actions:

| Alarm                                  | Threshold / periods (one minute) |
| -------------------------------------- | -------------------------------- |
| WorkerErrors                           | >=1 / 1                          |
| WorkerThrottles                        | >=1 / 1                          |
| WorkerBatchFailures                    | >=1 / 1                          |
| Dlq visible messages                   | >=1 / 1                          |
| Overdue oldest work milliseconds       | >=300000 / 3                     |
| ReconcilerErrors                       | >=1 / 1                          |
| ReconcilerThrottles                    | >=1 / 1                          |
| Heartbeat                              | <1 / 3, missing breaches         |
| Backlog examined lower bound           | >=400 / 5                        |
| InvalidWork                            | >=1 / 1                          |
| QueueAge seconds                       | >=900 / 3                        |
| Scheduler TargetErrorCount             | >=1 / 1                          |
| Scheduler InvocationDroppedCount       | >=1 / 1                          |
| Reconciler DestinationDeliveryFailures | >=1 / 1                          |

Other alarms treat missing data as not breaching. Age and heartbeat cover work
which is not visible to the bounded count; alarm thresholds require operational
review at production volume. Scheduler metrics use the approved group's
[ScheduleGroup dimension](https://docs.aws.amazon.com/scheduler/latest/UserGuide/monitoring-cloudwatch.html).
Read-only SNS list-topics in dev/us-east-2 on 2026-09-27 returned no topics.
No topic, email or SMS subscription is invented.

**External alarm notification destination is a production deployment gate.**

## Exact new IAM

All resource ARNs are exact table/queue/function/group identities, except log
stream coverage within each function's own log group. No managed broad policies.

| Principal                    | Resource                | Actions                                                                        |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Application (additions only) | OperationsTable         | dynamodb:DeleteItem                                                            |
| Application (additions only) | Reservation queue       | sqs:SendMessage                                                                |
| Worker                       | CatalogTable            | dynamodb:GetItem, dynamodb:PutItem                                             |
| Worker                       | CommerceTable           | dynamodb:GetItem, dynamodb:PutItem, dynamodb:ConditionCheckItem                |
| Worker                       | OperationsTable         | dynamodb:GetItem, dynamodb:DeleteItem                                          |
| Worker                       | Reservation queue       | sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes, sqs:SendMessage |
| Reconciler                   | OperationsTable         | dynamodb:GetItem, dynamodb:Query, dynamodb:PutItem                             |
| Reconciler                   | Reservation queue       | sqs:SendMessage                                                                |
| Reconciler                   | Reservation DLQ         | sqs:SendMessage (async failure destination)                                    |
| Recovery Scheduler role      | Exact reconciler Lambda | lambda:InvokeFunction                                                          |
| Recovery Scheduler role      | Reservation DLQ         | sqs:SendMessage                                                                |
| Each new Lambda              | Its own log group       | logs:CreateLogStream, logs:PutLogEvents                                        |

Lambda role trust lambda.amazonaws.com. Recovery role trust scheduler.amazonaws.com
with aws:SourceAccount and aws:SourceArn equal to the new recovery group ARN.
No new runtime PassRole, scheduler permissions, wildcards, UpdateItem or Scan.
No Catalog IAM changes for the application. Worker Operations GetItem is reserved
within the approved read/delete scope; current settlement uses guarded Delete.

## Rollout, TTL, payment boundary and failure assumptions

**Pre-deploy gate:** at eventual deployment review, an operator may perform the
separately permitted one-time READ-ONLY dev CommerceTable Scan/inspection to prove
no legacy ACTIVE Cart remains. Phase 5A1 acceptance released all its known carts,
but this does not prove the absence of other carts. This implementation has not
performed the rollout scan and does not fabricate work for unknown legacy Carts.
If any legacy ACTIVE Cart exists, STOP for a separately approved settlement/backfill
plan. No runtime Scan IAM or table index is added.

No TTL, GSI, Streams or table schema changes. Never TTL-delete ACTIVE ownership or
outstanding work. Completed work is transactionally removed; terminal Cart and
receipt retention remain unchanged.

Only SHOPPING is implemented. Future Phase 5B ACTIVE -> PAYMENT_PENDING must
atomically remove SHOPPING work, establish payment state/deadline, and create PAYMENT
work. Old shopping wakeups must not release payment-owned states. PAYMENT_COMMITTING,
grace, processor hard stop, Stripe, conversion and order flows remain future work.

Liveness assumes valid persisted ownership, restored AWS access/capacity, enabled
worker/reconciliation resources and eventual service availability. Permanent
corruption, disabled processing or permanent permission failure raises evidence/
alarms and needs operator repair; it is never solved by guessing inventory.
Queue and Lambda execution are at-least-once; Cart revision plus exact Inventory
snapshots ensure release is at-most-once. Local model tests establish the protocol,
not a claim of live expiry acceptance. No deployment or live data mutation occurred.

## Validation

Deterministic tests cover deadline equality/early requeue, duplicate/stale/malformed
messages, terminal cleanup ConditionCheck, DELETE/PUT winners, lifecycle independence,
multiple products, snapshot contention, post-commit dispatch and lost response,
never-sent/DLQed work and long outage recovery, cursor pagination/interruption/CAS,
behind-cursor insertion, poison fairness, safety margin, no secret logging, and 100
concurrently expiring owners. The model asserts reserved equals ACTIVE ownership
after every committed mutation. Infrastructure tests compare all prior resources
to a captured Phase 5A1 synthesis and assert exact new IAM and configuration.
Local validation on 2026-09-27:

- Backend typecheck/build passed; 443 functional tests and 6 artifact tests passed.
- Infrastructure typecheck/build passed; 19 tests passed.
- Backend and infrastructure npm audits: zero vulnerabilities each.
- Repository formatting and git diff --check passed.
- CDK synth --lookups=false passed.
- Read-only CDK diff against batch-and-batter-dev with --no-change-set
  --lookups=false passed and matched scope: 28 additions (14 alarms and 14
  worker/recovery resources), 3 modifications (reservation visibility, application
  policy, application code/environment), no replacements/deletions.
- No table/API/Cognito/S3/notification queue/existing Drop-opening Scheduler or
  existing application EventInvokeConfig changes.
- CDK emitted its feature-flag advisory; no feature flags were changed.

Diff evidence: `/tmp/phase5a2-cdk-diff.txt`. Test logs:
`/tmp/phase5a2-backend-tests.log`, `/tmp/phase5a2-infra-tests.log`.
Synth output: `/tmp/phase5a2-synth.yaml`. These are local review artifacts and
are not deployed or committed.

Suggested commit (not executed): `feat: add durable cart expiry recovery`.
