# Authoritative checkout quote — 1N-Z

Local source change only. No deployment, payment admission, live Stripe mode,
production pricing approval or hosted acceptance is established by this milestone.

## Contract

The existing capability-protected `GET /carts/{cartId}/payment?quote=1` returns
`{ quote }` for an ACTIVE, unexpired cart assigned to an OPEN Drop. It performs
only strongly consistent reads. The existing Catalog Query permission is reused;
no route, table, index or IAM change is introduced. Pickup reads are bounded to
32 evaluated records and fail closed on continuation or more than 31 entries.

The version-1 quote carries cart ID/revision, Drop ID/revision, the immutable
reserved item prices/quantities, subtotal/tax/fee/total in integer cents,
currency, policy ID/version, reservation expiry, and active pickup dates/windows,
timezones, location and instructions. Items and pickup dates have stable ordering.
Its ID is SHA-256 of the canonical server-constructed snapshot. This is a content
identity, not a credential or signed bearer quote. Possession grants no access.
The server never accepts a client quote body or client monetary amount.

The SSR checkout reads that quote over the existing fixed upstream path, checks
its cart identity/revision and arithmetic, and forwards its amounts and pickup
terms for display. The old independent DEV summary calculator is removed.
The browser submits only `quoteId` in addition to existing start fields. It checks
that its freshly read quote still matches the displayed quote before creating a
confirmation token. A changed identity requires another explicit customer action,
even when totals have not changed. No automatic payment retry is introduced.

For a new start, the backend reconstructs the quote from the authorized cart and
current policy/terms, rejects a missing or mismatched identity with HTTP 409
`QUOTE_STALE`, and uses **that same quote's amount object** for the Order, Attempt
and execution parameters. It does not recalculate amounts after provider token
retrieval. Existing transaction guards still condition on cart revision/expiry,
Drop revision, assignment, selected pickup terms and inventory. A concurrent
mutation can reject the transaction; it cannot partially create financial records.
The quote does not extend the eight-minute reservation or four-minute payment
window. Unselected pickup changes after validation do not change the selected
order's terms; the selected pickup and Drop are checked atomically.

## Recovery and compatibility

Existing receipt lookup remains before admission, policy, cart and quote checks.
New fingerprints include `quoteId`; historical requests omit it and retain their
original fingerprint. The input field is optional solely for historical receipt
replay: a NEW request without it always fails closed. The SSR forwards this form
so the backend can distinguish replay from new admission.

Order and Attempt storage schemas are unchanged. No backfill, mutation of old
amounts, or quote table is needed. Settlement and provider execution continue to
use frozen amounts. Payment recovery reads do not request a fresh quote or display
current cart pricing as if it were the historical order amount. The existing
canonical payment-status presentation remains; a full frozen receipt UI is not
added here.

A future release must coordinate API and frontend compatibility with admission
closed. Old frontend/new API cannot start new payments without a quote. New
frontend/old API fails closed when it cannot obtain a quote. Do not treat this
local change as authorization to replace pinned financial artifacts.

## Policy boundary

The only installed policy remains `DEVELOPMENT_ONLY_ZERO_TAX_ZERO_FEE`, USD,
version `1`. Existing explicitly injected DEV fixture callers default that same
fixture's version to `1`; there is no production policy default. Version is a
bounded nonempty identifier. Tests inject another version of the same fixture
and prove that the old quote is rejected even with the same amount. Missing or
unsupported frontend pricing mode/currency remains unavailable; invalid backend
fixture/version/currency cannot produce a quote. No production configuration or
new environment setting is enabled.

Policy identity must change with any future rule change. Runtime policy is
process configuration, not a globally synchronized policy registry. A future
policy rollout must prevent mixed effective policies accepting requests during
a transition (for example, keep admission closed until the intended release is
uniform). This change does not introduce a distributed policy activation service.

Synthetic nonzero taxes/fees are deliberately not implemented: the existing
payment calculator only supports zero-tax/fee fixtures. Generalizing it requires
the separately approved production calculation contract. No exemption, rate or
fee policy is inferred from these tests. Owner decisions remain: tax applicability
and jurisdiction, taxable basis, inclusive/exclusive treatment, rounding rules,
fees and their tax treatment, effective version, and customer disclosures.

## Validation scope

Focused mocked tests exercise quote reads, reserved-price consistency, single and
multiple items, stale policy/cart/pickup/expiry, malformed/missing authority,
zero writes on stale rejection, equal Order/Attempt/provider amounts, receipt
replay under changed/invalid policy and disabled admission, historical formats,
truncation, protected/no-store HTTP reads, and browser stale handling without
retries. Existing targeted execution/settlement tests cover frozen recovery and
inventory behavior. No AWS, Stripe or managed-database tests are performed.

Remaining gates: focused financial code review and owner acceptance, separately
authorized PR/release work, production pricing decisions and implementation, and
hosted duplicate-activation acceptance (**NOT PASSED**). No deployment is
recommended before the local financial-contract change is reviewed and accepted.

## Recorded local checkpoint — October 21, 2026

- 396 targeted backend tests passed (payment domain/API, execution, settlement,
  admission/runtime guards, routing and transport). The 75-test payment subset
  passed again after tightening invalid policy-version handling.
- 127 focused checkout/frontend tests passed.
- Backend and frontend TypeScript checks, frontend zero-warning lint, formatting
  and diff checks passed. Next production build and isolated API artifact build
  passed locally. No candidate was published.
- Focused diff review covered quote authority, receipt ordering, stale rejection,
  transaction snapshot reuse, policy-change handling, and privacy boundaries.
- No managed-DynamoDB concurrency, hosted payment, production-policy or nonzero
  tax/fee acceptance is claimed. The existing isolated Orders local script was
  updated to acquire a quote, but its broader acceptance suite was not rerun.
