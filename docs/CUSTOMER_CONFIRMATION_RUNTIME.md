# Customer confirmation runtime — 1N-AB

Local source only. No email, AWS change, deployment, payment activation or hosted
acceptance is authorized. Production pricing remains unresolved. Hosted
duplicate-activation acceptance remains **NOT PASSED**.

## Integration

`confirmation-runtime.handler` composes the existing Notifications service,
SesEmailProvider and GuestOrders. It accepts only `{ "poll": true }`. Existing
settlement already atomically persists the PAID event and notification work with
the paid Order. No financial persistence code changes are necessary.

The runtime polls existing sharded event/due records directly, without introducing
a queue or scheduler. It checks canonical PAID/CAPTURED state and matching
settlement/event identity, then creates the existing unique CONFIRMATION#email
operation. Conditional dispatch claims protect concurrent/duplicate polls.
Restricted polling follows continuation keys so unrelated due work cannot hide
later confirmations. Unrelated reminder, SMS, waitlist, pickup and refund work is
not consumed. Authorized existing ACCESS reissue operations may also be delivered
to recover a failed confirmation link; this runtime never creates reissue requests.

Messages use frozen Order items, total, reference, pickup date/window/timezone,
location and instructions. The configured approved pickup location must exactly
match the frozen location; missing instructions/reference or unsupported timezone
suppresses delivery visibly. It never replaces an Order's location from today's
configuration. Policy text must be supplied by the owner; no policy or address is
invented. This initial runtime supports one approved location and America/Denver.

GuestOrders issues the unchanged random capability in the `/order/manage#...`
fragment, stores its hash and conditional issuance receipt, and enforces its
existing expiry, revocation and per-order authorization. Reopening a valid link is
allowed; duplicate issuance for one operation is not. Bare order IDs grant no
access. SDK exceptions, message bodies and capabilities are not logged here.

## Outcomes and recovery

SENT means SES accepted the message, **not** confirmed inbox delivery. No delivery,
bounce or complaint feedback consumer is introduced. Existing admin notification
status exposes sanitized operation status/reason and attempts.

A definite SES rejection with an issued link becomes FAILED. An ambiguous provider
outcome becomes UNCERTAIN; it is never automatically resent. A lost acknowledgement
after acceptance leaves DISPATCHED, which becomes UNCERTAIN after five minutes.
Issuance ambiguity also requires reconciliation. Financial records are untouched.

An operator must inspect the outcome, correct delivery/configuration problems,
and use the existing authorized guest-link revoke/reissue flow when appropriate.
The established active-link limit and original expiry still apply. Do not blindly
reset notification rows or retry an uncertain send. Suppressed confirmations need
operator investigation; they do not silently become successful. Required hosted
admin reissue routes must be available before relying on that recovery process.

## Future activation dependencies — not implemented

- A separately approved worker artifact/compute invocation for this source-only
  entrypoint, with periodic polling and failure monitoring. It is deliberately
  absent from the accepted API/financial Lambda build entrypoints. Existing hosted
  financial artifacts are not sufficient to activate it.
- Verify the hosted settlement artifact writes the exact PAID event/work contract
  before activation; source compatibility alone is not hosted evidence.
- SES verified sending identity in the selected region, approved sender/domain,
  and sandbox recipient restrictions resolved as appropriate. No SES change made.
- Nonsecret required configuration: CUSTOMER_CONFIRMATION_MODE=confirmation-email,
  COMMERCE_TABLE_NAME, OPERATIONS_TABLE_NAME, CATALOG_TABLE_NAME,
  CONFIRMATION_FROM_EMAIL, CUSTOMER_ORDER_ORIGIN (exact HTTPS customer origin),
  CONFIRMATION_APPROVED_PICKUP_LOCATION, CONFIRMATION_CUSTOMER_POLICY_TEXT.
  Missing/invalid configuration fails before client creation in the handler.
- A least-privilege execution role: SES SendEmail restricted to the approved
  identity/from address; DynamoDB GetItem/Query and the conditional PutItem,
  DeleteItem and ConditionCheckItem operations required by existing notification
  and guest-access transactions on the existing Commerce/Operations tables.
  Scope permissions to the existing table ARNs and relevant key families. The
  runtime never writes financial Order/Attempt records. Guest-access records share
  an ORDER partition with financial metadata, so partition-key IAM conditions
  alone cannot isolate their sort keys; review that permission boundary before
  activation rather than claiming item-level separation. No new tables/indexes required.
  Catalog table name is required by GuestOrders configuration; this worker's
  issuance path does not query Catalog. Guest HTTP reads have their own permissions.
- HTTPS customer `/order/manage` page and existing capability-protected guest API
  routes must be deployed compatibly and reachable by the intended customer.
  A restricted administrator-only origin is not a customer launch origin.

No SQS, Scheduler, SMS or reminder permissions are needed by this runtime. No IAM,
resource creation or deployment was performed. Provider clients use maxAttempts: 1.

## Local validation

Focused in-memory tests use mocked DynamoDB commands and a mocked SES client; no
network email or payment operations. Tests cover frozen amounts and pickup details,
canonical payment authority, duplicate/concurrent polls, missing configuration,
unsupported events, unapproved pickup details, guest authorization/expiry/revocation,
provider rejection and ambiguous acceptance, explicit reissue recovery and pagination.
Mocks do not establish managed-DynamoDB or SES delivery acceptance.

Recorded validation: 35 focused tests passed; backend TypeScript compilation,
frontend zero-warning lint, formatting and diff checks passed. The standalone
Node 24 confirmation bundle built locally. The isolated API build retained SHA-256
`424902583e83eba7205258fff473d6a54bc9cfc53a8093a97e67785330543b7c`.
No candidate was published and no accepted build entrypoint was changed.
