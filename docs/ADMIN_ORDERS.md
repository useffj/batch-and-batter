# Administrator Orders — Milestone 1D

Read-only `/admin/orders` lists orders within a selected Drop, newest first, with
pickup-date and persisted-status filters, exact public-reference search, bounded
pagination, refresh and details. Default selection uses the current storefront
Drop; without one it selects the latest opening in the first bounded Drop page.
More Drops can be loaded explicitly. This is not a global recent-order feed.

## Access patterns and privacy

Commerce GSI1 uses `PICKUP#<date>` / `ORDER#<createdAt>#<orderId>`; GSI2 uses
`DROP#<dropId>` / the same sort key. Only orderId, status and dropId are projected
in addition to keys. Each request evaluates at most 20 index rows; it does not
scan Commerce or loop through additional pages. Status and optional Drop filters
can yield an empty page with continuation. Cursors bind to the original filters.
GSI visibility is eventual, and pagination is not a snapshot. Each returned row
is refreshed with a strongly consistent primary-key read and filters rechecked;
recent transitions may still be absent until the index catches up.

Both GET routes (`/admin/orders`, `/admin/orders/{orderId}`) require Cognito access
tokens and administrator-group enforcement. The web page/relay reuse encrypted
HttpOnly sessions, no-store output and fixed upstream routes. Cross-site relay
reads are rejected. DTOs allowlist fulfillment data; cart IDs, payment-attempt
IDs, settlement evidence, tokens, consent flags and provider credentials are not
returned. Lists omit customer email/phone; authenticated details include them.
No browser persistence of customer records is introduced. Existing log conventions
omit query strings and customer payloads.

Details use only persisted order snapshots for names, quantities, unit prices,
subtotal, tax, fees, totals and pickup information. No current Product lookup is
performed. Fulfillment displays “Not recorded”; pending/unpaid orders are never
labelled ready for pickup. Only actual persisted order/payment statuses appear.
The feature exposes no cancellation, capture, refund, inventory or fulfillment
write operations.

## Public references and payment integrity

New orders get `BB-` plus 12 cryptographically random characters from
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`. The original order-creation transaction adds
a conditional `ORDER_REFERENCE#<reference> / META` lookup containing only orderId.
A collision aborts the whole transaction; no partial Order, attempt or reference
is committed. The existing payment idempotency receipt/replay remains authoritative,
and retries never change a committed reference. The transaction now contains 12
actions (including the lookup), independent of the maximum 12 item snapshots.
Existing cancellation-reason positions are preserved by appending the lookup.

Order transitions preserve the optional reference/index attributes and frozen
snapshots. Capture logic, inventory conversion, payment admission and Stripe
configuration are unchanged. Local tests cover collision rollback, replay and
paid settlement preservation; DynamoDB Local also executes the real payment-start
transaction and verifies replay and unchanged reserved inventory.

## Compatibility and release gates — no deployment authorized

Legacy records without reference/index attributes remain readable by known ID,
with “Reference not recorded”. They are **not fully discoverable** through these
indexes or reference search before a separately approved backfill. No runtime
read invents a reference or repairs a record.

A future backfill must inventory existing records under an approved bounded
migration plan, validate snapshots/identities, preserve existing valid references,
resolve conflicting mappings with the owner, and atomically condition on each
order's current revision while adding missing keys/reference plus a create-only
lookup. Retries must reread instead of overwriting a concurrent transition. Verify
complete lookup/index coverage, reconcile orphan/mismatched lookups and allow
index propagation before enabling the list for historical acceptance. No such
migration runs in this milestone.

**Mixed-version release gate:** older deployed payment artifacts use strict order
schemas and may reject these additional attributes. Do not enable the new writer
or backfill while incompatible readers/workers can process those records. A
separately approved compatibility rollout must cover all order-reading and
order-writing API/payment components before emitting enriched orders. Accepted
Lambda artifacts remain unchanged now. This is not an API-only deployable release.

The two GSIs and two protected routes are source-only infrastructure changes.
Future deployment also needs narrowly scoped Query permission on exactly these
two index ARNs, API/frontend releases, dependency/artifact review and compatibility
acceptance. Ordinary full-stack deployment remains blocked. No AWS GSI activation,
IAM change, artifact publication, live business-data write, payment admission,
media activation or catalog migration is authorized by this merge.

Hosted duplicate-activation acceptance remains **NOT PASSED**.
