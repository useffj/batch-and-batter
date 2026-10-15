# Weekly Drop Management — Milestone 1C

The administrator's Weekly Drops page lists saved Drops and supports creating,
reloading, editing and previewing drafts. It selects existing active Products;
prices remain integer cents on Drop–Product associations. Product records,
pricing architecture, carts and payment behavior are unchanged.

Opening defaults to the next Sunday at noon in America/Denver. Explicit Denver
input is converted with daylight-saving round-trip validation; missing or
ambiguous times are rejected. Pickup defaults to the following Thursday–Saturday,
16:00–19:00, with configurable 2–3-hour windows and no capacity limit. The existing
12-cookie default and eight-minute reservation contracts remain unchanged.

## Persistence and protection

`GET /admin/drops` returns bounded summaries with a continuation cursor.
`PUT /admin/drops/{dropId}/draft` validates the complete draft and saves its
metadata, associations, planned inventory and pickup dates atomically. The
transaction checks the loaded revision, DRAFT status, catalog readiness and
active Product existence. Existing cookie-unit values are preserved. Reserved
or sold inventory prevents the save, and inventory writes independently check
zero balances. Stale changes fail without partial persistence.

The editor supports up to 24 cookies to bound transaction size. Replacing a large
existing selection can exceed DynamoDB's 100-action limit; such a save fails
closed. Remove and save a smaller subset before adding the replacements. This
is an editor limit, not a Product schema change or customer order limit.

Existing Cognito administrator authorization, encrypted HttpOnly sessions and
same-origin write protections apply. Browser storage holds no credentials or
Drop drafts. The preview launcher is loopback-only, uses a separately created
DynamoDB Local table and refuses production mode; it is not a hosted bypass.

## Publication and limitations

Publication, open, pause, resume and close reuse existing lifecycle endpoints.
Unsaved edits must be saved or reloaded before status changes. Publication
validates the saved composition, including positive prices and planned stock.
Non-DRAFT editing is disabled. Existing scheduler behavior is not redesigned:
a scheduling failure can leave a Drop SCHEDULED; reload reconciles its actual
state. No operational hosted scheduling or publication acceptance is claimed.

Unsaved edits do not survive reload (a browser warning is provided). An ambiguous
initial create response requires inspecting the saved list before another create;
Drop creation has no new server-side idempotency contract. Lists use bounded
scans, are not sorted or snapshot-consistent across pages, and can have empty
pages with continuation. Existing malformed catalog data still requires operator
repair. Pickup changes for existing orders and the day-before 3 PM deadline are
outside this milestone.

## Local acceptance and release gates

A synthetic three-cookie Drop was saved, navigated away from, reloaded, edited
and previewed using the actual backend against an isolated DynamoDB Local table.
Different cent prices, quantities, and Thursday–Saturday pickup hours persisted.
Negative prices and publication with a zero price were rejected. Unsaved edits
blocked publication. Mobile layout and keyboard interaction were checked.
Targeted tests cover authorization, same-origin relaying, stale and concurrent
saves, catalog readiness, inactive Products, reservations and sales.

DynamoDB Local is not complete managed-DynamoDB concurrency evidence. Deployment,
real Drop writes, catalog migration/readiness activation, media uploads and
payment admission remain separately gated. The two new API routes, API artifact
and frontend require a separately reviewed narrow deployment; ordinary full-stack
deployment remains blocked. Accepted Lambda artifacts must remain unchanged.
Hosted duplicate-activation acceptance remains **NOT PASSED**.
