# Customer cancellation and refund requests — Milestone 1I

This milestone implements request intake and administrator review only. It does
not execute refunds, cancel paid Orders, change refund disposition, restock,
release inventory, send real messages or authorize deployment.

## Policy and customer experience

The guaranteed deadline is the current confirmed Denver pickup **start instant
minus 24 elapsed hours**, configurable through `GUEST_CANCELLATION_HOURS`
(`GuestCancellationHours`, default 24, integer 1–168). DST transitions use actual
elapsed hours, not the previous day's wall time. Ambiguous/nonexistent pickup
start times and missing/contradictory evidence fail closed. At the deadline,
guaranteed intake closes and reasoned discretionary assistance is available.

A valid unexpired/unrevoked guest link, PAID/CAPTURED Order with matching paid
settlement amount, matching refund disposition NONE, and no collection are
required. UNKNOWN, PENDING, PARTIAL and FULL refund dispositions are ineligible.
Pickup changes recalculate the deadline before submission. A recorded request
blocks further self-service pickup changes, avoiding conflicting entitlements.
A pre-deadline MISSED_PICKUP record is contradictory and fails closed.

The private customer page displays the exact Mountain Time deadline, policy,
explicit confirmation, receipt and request status. Pending request processing is
not a Stripe refund status. Historical financial values and actual Order status
remain visible and unchanged. Late requests require a reason and promise no
refund. User input is escaped; guest tokens remain memory-only and existing
no-store, noindex, no-referrer and same-origin protections are preserved.

## Persistence and concurrency

Commerce companion `ORDER#id / CANCELLATION_REQUEST` stores one durable request
per Order: stable UUID, type, reason, timestamps, revision, status and the intake
eligibility snapshot (deadline/policy, pickup, settlement, fulfillment, full Order
amount/currency). It does not modify the Order or REFUND_DISPOSITION records.
A conditional transaction checks Order/pickup/settlement, refund, fulfillment and
guest-access revisions and creates the request, immutable receipt/audit and
notification operation together. Competing submissions cannot create two requests.
Exact retries recover their original result, including a lost acknowledgement.
An expired or revoked bearer cannot replay a request.

Operations records:

- `CANCELLATION_RECEIPT#id / requestUUID`: immutable submission fingerprint.
- `CANCELLATION_REVIEW#id / requestUUID`: immutable administrator review receipt.
- `CANCELLATION_AUDIT#id / timestamp#requestUUID`: append-only customer/reviewer
  actions; guest grant ID or authenticated administrator identity, reasons/notes.

Customer DTOs exclude reviewer identities and private notes. Administrator history
queries return the newest 25 actions with explicit truncation; all earlier records
remain durable. Existing bounded Orders queries perform keyed companion reads and
show request badges, without Commerce scans or a new index/database/service.

The MVP intentionally permits one request per Order, including after an exception
is declined. Further assistance uses the bakery's existing contact channel;
reopening and repeat financial requests need an explicit later contract.

## Administrator decisions and notifications

Timely guaranteed requests remain `RECEIVED_PENDING_PROCESSING`: administrators
can record notes, but cannot decline the entitlement. Exceptions begin
`EXCEPTION_REQUESTED` and support one conditional approve-for-processing or decline
decision plus later notes. Approval rechecks current Order/refund/fulfillment
conditions atomically. Approval records intent only; it authorizes no Stripe call,
refund amount or inventory change. Revision guards and durable review receipts
protect competing decisions and uncertain responses. No Issue Refund button exists.

`REQUEST#requestUUID#email` operations reuse notification delivery idempotency and
uncertainty handling. Message wording confirms receipt only. Timely accepted
requests suppress future pickup reminders at eligibility checks; exceptions do
not suppress unrelated notifications, even after review. Provider submission and
request persistence are not one transaction: a reminder already in flight can
still arrive. Real refund confirmation requires future authoritative completion.

## Validation and release gates

Synthetic DynamoDB Local acceptance covers timely/late intake, duplicates, races,
lost acknowledgements, cancelled/refunded/UNKNOWN states, expired/revoked tokens,
changed pickup dates, bounded admin display/audit, protected guaranteed entitlement,
concurrent review, notification compatibility, unchanged financial snapshots and
hash-only token persistence. Existing guest and notification suites remain applicable.
The existing local preview supports `/review` and `--late`, rejects production,
binds loopback, uses disposable synthetic tables/mock delivery and prints no token.
Mobile 375px and keyboard customer submission and administrator review are checked.

No AWS deployment, live customer writes, messages, Stripe operations, IAM/SSM/S3
changes, artifact publication, catalog activation or payment admission changes.
Accepted Lambda artifacts remain pinned; full-stack deployment remains blocked.
Deployment requires separate authorization for the three routes and nonsecret
policy configuration and the previously documented notification runtime gates.
Local DynamoDB evidence is not complete managed-service concurrency validation.

The next financial-execution milestone must implement explicit full/partial refund
authorization, Stripe idempotency, reconciliation, duplicate-refund protection,
RESTOCK/DO_NOT_RESTOCK, authoritative Order/refund transitions and completion
notifications. It must consume the preserved timely entitlement and coordinate
fulfillment safely. None of those capabilities is claimed here.

Hosted duplicate-activation acceptance remains NOT PASSED.

Validation completed: 555 frontend tests; 1,096 backend tests; 10 legacy artifact
checks plus one isolated API ZIP check; 133 infrastructure tests; 11 cancellation
DynamoDB Local groups; 14 guest-access and 10 notification compatibility groups.
Type checking, lint, production build, offline CDK synthesis and formatting passed.
The focused review added current-evidence checks on exception approval, preserved
intake deadlines across later policy changes, and excluded settlement IDs from
customer responses. Bounded administrator responses allow the worst-case encoded
25-row audit history. No known blocking defect remained after these corrections.
