# Milestone 1K — read-only refund reconciliation worklist

The Orders administration link opens a display-only worklist. It never installs
or calls the refund execution coordinator or a provider. No authorization,
reconciliation, inventory adjustment, notification dispatch or database write
occurs while loading, refreshing, filtering, or reading details.

## Discovery and continuation

Choose exactly one Drop, pickup date, or exact customer-facing Order reference.
Discovery reuses Commerce GSI2 (Drop), GSI1 (pickup), and existing reference
records. There are no scans, new indexes, companion writes or backfills.
Historical Orders missing index attributes or references are not comprehensively
discoverable. Missing display references are labeled honestly. Index visibility
may lag; pages are not a cross-page snapshot or a global/all-time worklist.

Each request evaluates at most one indexed Order and ten refund operations. A
cursor binds the selected scope, financial-status filter and attention filter,
and preserves both the evaluated Order position and the refund-operation key.
Unread operation pages finish before another Order is evaluated. Empty filtered
pages retain continuation; no page count is presented as a complete count and
no page claims an all-clear result. Key shapes, partition, IDs, timestamps,
filter bindings and continuation progress are validated. A terminal Order may
require one final empty index read after its operation continuation completes.

Details query ten audit records per request using the selected operation prefix.
Audit cursors bind both Order and operation. Historical transitions remain
available beyond the first 25 records. Responses are capped at 128 KiB; oversize
or inconsistent evidence fails closed instead of silently truncating. Worklist
requests use at most seven DynamoDB read commands; details use eight. Reads
refresh Order and ledger evidence before returning, and details also recheck the
operation. Concurrent completion or contradictory settlement evidence requires
refresh. Operation-only updates are recorded observations, not a claim of global
snapshot consistency.

## Financial truth and attention

All seven financial statuses remain unchanged. Attention is a separate operational
indicator. RECONCILIATION_REQUIRED and FAILED are immediate indicators. A blocked
ledger always gets its own notice on the Order's first operation page, even with
zero reserved amount and regardless of status filters. Successful and canceled
operations are available by clearing attention-only and selecting their status.

The adjustable `attentionAge` constants flag AUTHORIZED and DISPATCHED after 60
minutes, and PENDING after 24 hours, using injected server time and the durable
operation creation timestamp. Polling updates cannot postpone triage. These are
review thresholds, not Stripe guarantees or financial failures. `nextCheckAt` is
never treated as a completion deadline.

Original Order total, captured amount, operation amount, confirmed cumulative
refunds, reserved funds and available captured balance are separately labeled
integer cents. Available to refund does not mean money owed. Missing ledger
amounts are not fabricated. Ledger totals are current recorded evidence, not
recomputed from a partial operation page. Returned quantities are labeled as
cumulative for the Order, distinct from the selected operation's restock request.

The display-only details show recorded provider reference, check count, timestamps,
restock decision and audit transitions. Detailed failure reasons and complete
provider attempt history are not stored and display **Not recorded**. Existing
Orders refund execution components are not rendered in the worklist or details.

## Security, validation and release

The dedicated GET `/admin/refund-worklist` contract uses existing Cognito
administrator-group enforcement. SSR retains encrypted HttpOnly sessions,
expiration, same-origin browser checks, no-store responses and bounded requests.
The route definition is local source only; no AWS resources are changed. Existing
payment/refund writer paths and accepted Lambda artifact references are unchanged.

The established loopback-only disposable Orders/DynamoDB fixtures supply synthetic
records. `test-refund-worklist-local.mjs` enforces Get/Query-only commands and
exercises 37 operations, 31 audit transitions, all seven statuses, exact amounts,
empty pages, filter-bound cursors, missing references, blocked zero-reservation
ledgers and concurrent completion. No provider exists in this read repository.
Fixture creation/fault injection writes are isolated setup, never worklist actions.
The existing Orders preview supports `--refund-worklist` for mobile and keyboard
acceptance; it rejects production mode and binds only 127.0.0.1.

Global discovery, historical backfill, automatic retry, real financial execution,
managed-DynamoDB acceptance and deployment remain outside this milestone. Live
release still requires separately approved compatible artifacts, route deployment,
financial safeguards and acceptance. No security exception is granted. Public
hosting Job 9, restricted Admin DEV Job 1 and payment admission disabled must be
preserved. Hosted duplicate-activation acceptance remains **NOT PASSED**.
