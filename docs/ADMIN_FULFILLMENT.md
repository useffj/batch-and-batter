# Administrator fulfillment — Milestone 1E

Local source implementation only. No deployment or live business writes are authorized.

The pickup-date queue uses the existing Commerce GSI1, bounded to 20 evaluated orders per request, then re-reads authoritative Orders and fulfillment records. Only PAID/CAPTURED orders appear. Counts describe the retrieved page, never daily totals. Continuation can include empty pages. Index lag and historical backfill limitations remain; pages are not a snapshot.

`GET /admin/fulfillment?pickupDate=YYYY-MM-DD&cursor=...` returns detail DTOs, recorded fulfillment, and a server-computed pickup-window-ended flag. `POST /admin/orders/{orderId}/fulfillment` accepts requestId (UUID), expected integer revision, target status, and an optional reason up to 500 characters. Both use existing Cognito administrator authorization; browser relays retain encrypted HttpOnly sessions, same-origin writes, fixed upstream routes, bounded JSON, and no-store responses.

Commerce companion key `ORDER#<orderId> / FULFILLMENT` stores revision, current status, and append-only operational history. Missing means Not recorded. Each event records request identity, Cognito subject, server ISO timestamp, status, and reason. Allowed paths: Not recorded → Ready or Missed; Ready → Collected or Missed; Missed → Collected with a nonblank reason. Collected is terminal. Missed requires the current server time to reach the saved pickup-window end in America/Denver. No automatic missed classification occurs.

Every transition atomically checks the Order remains PAID/CAPTURED with its loaded updatedAt, conditionally replaces only the fulfillment companion at the expected revision, and creates a durable `FULFILLMENT_EVENT#<requestId>` receipt. Receipts bind administrator and normalized request to the original result; replay does not append another event. A lost response can be retried with the same request. Full browser reload discards an unconfirmed request identity, so the operator must inspect persisted state before choosing another action. Later payment changes do not erase historical fulfillment events. Existing payment contracts have no refund state; any future refund writer/contract must explicitly preserve the eligibility check. Unknown states fail schema validation.

Fulfillment never updates Order META, prices, totals, payment status, inventory, Drops, Stripe, or notifications. The operation cannot refund, restock, cancel, or remake an order. The state is operational history, not a financial ledger.

## Local validation and release gates

`node backend/scripts/test-fulfillment-local.mjs` exercises disposable loopback DynamoDB fixtures: listing, persisted readiness/collection, missed and reasoned late collection, unpaid/cancelled rejection, invalid transitions, replay identity, concurrent transitions, stale revision, audit identity/time, and concurrent cancellation. Existing Orders local acceptance remains applicable. `node web/scripts/preview-fulfillment.mjs` serves the actual UI and repository only on loopback with synthetic identity and an explicitly labelled October 25 clock; choose October 22 fixtures. It is not part of production routes or authentication.

Deployment still requires separately approved order-index rollout, historical backfill, compatible payment workers, the two JWT API routes, and Commerce ConditionCheckItem permission for the API role. Accepted Lambda artifact references are unchanged. Full-stack deployment remains blocked. Local validation does not establish managed DynamoDB or hosted acceptance. No media activation, catalog readiness, artifact publication, live order writes or payment admission is authorized. Hosted duplicate-activation acceptance remains NOT PASSED.
