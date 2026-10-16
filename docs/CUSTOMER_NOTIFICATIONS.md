# Customer notifications — Milestone 1G

Source implementation only. No customer messages, AWS deployment, schedules, provider activation, or accepted artifact publication are authorized by this milestone. Mock delivery is not customer acceptance. Hosted duplicate-activation acceptance remains **NOT PASSED**.

## Financial event and compatibility

The existing authoritative PAID finalization transaction still owns inventory conversion and the Order/payment settlement. It additionally creates a Commerce `ORDER#id / REFUND_DISPOSITION` record with `NONE` and the exact settlement identifier, plus an Operations `NOTIFICATION_EVENTS#shard / orderId` durable work record. The original PAID event and financial conditions are preserved. No provider call occurs in settlement. A failed delivery cannot reverse financial settlement. Transaction rollback tests cover both new actions and maximum twelve-item transactions.

Historical Orders without authoritative refund evidence are UNKNOWN, even when PAID/CAPTURED. No historical records are migrated or assigned NONE. Future refund/cancellation writers must atomically maintain NONE/PENDING/PARTIAL/FULL/UNKNOWN with financial authority; refund initiation must set PENDING before external refund execution. **Live reminders remain blocked until all refund writers, applicable Stripe event handling, and readers are compatible and verified.** Actual refunds are outside this milestone.

Payment start also atomically records a separate SMS consent snapshot: phone, explicit transactional boolean, server-generated consentedAt (null when false), fixed server consentSource CHECKOUT_V1, and optOutAt. Existing strict Order and Product schemas are unchanged. Historical boolean-only consent is not upgraded.

Current phone-wide suppression lives separately in Operations at `SMS_SUPPRESSION#sha256(phone) / META`, with phoneHash, revision, verifiedAt, and optOutAt. Missing, malformed, future-dated, or older-than-24-hours verification suppresses SMS. Any recorded opt-out suppresses messages for older Orders too. The model intentionally has no public writer or automatic opt-in migration. A trusted provider ingestion process must keep current evidence authoritative, use monotonic revision/conditional updates, preserve opt-outs, and reconcile opt-in only from a separately approved contract. **Live SMS is blocked until consent capture and current opt-out ingestion are verified.** Consent never authorizes marketing.

## Durable processing

Notifications consumes the existing PAID event only when it matches the authoritative Order's settlement, cart, attempt, and Drop. A deterministic confirmation email operation and durable due record are created transactionally. Duplicate events cannot create another operation. Confirmation contains the customer-facing reference when recorded, cookie quantities, frozen historical total, pickup details and deployment-supplied approved policy text. No secure order-management link is fabricated: an approved secure-link issuer remains a launch requirement if that link is desired. SMS confirmation is optional and not configured.

One EventBridge Scheduler operation per pickup date uses a calendar expression for 10:00 AM America/Denver on the preceding date, configurable through the constructor's reminderTime. It uses the named timezone across DST, not a fixed UTC offset. Existing schedule conflicts are read and must exactly match; they are never overwritten. A late payment confirmed after that day's reminder time queues an idempotent pickup-date trigger. Past pickup dates are not scheduled.

The reminder worker queries the existing pickup-date Order index in bounded pages of 20 and enqueues continuation messages. It consistently rereads authoritative Orders, refund disposition and fulfillment. It requires PAID/CAPTURED, matching PAID evidence and NONE refund disposition, and suppresses picked-up/missed orders. It checks again after claiming the delivery and immediately before the external send. Changes after the last check remain possible; this does not promise immunity to a concurrent refund or opt-out.

Operations and due work contain IDs and sanitized status/reason codes, not recipients, credentials or message bodies. The poller checks sixteen deterministic event/due partitions, at most twenty records per partition per invocation. Queue messages contain IDs/date/cursor only. Queue consumers report partial failures. Poll invocation, queue mappings and worker packaging remain deployment gates; accepted Lambda artifacts are untouched.

Delivery uses a conditional revision/status claim before invoking a provider. Positive acknowledgement records SENT (provider acceptance, not customer receipt). Definite provider rejection allows at most three attempts. Unknown outcomes become UNCERTAIN and cannot automatically resend. A worker abandoned after the claim becomes UNCERTAIN after five minutes; it is never reclaimed for an external send. A failed write after provider acceptance leaves the durable claim intact. No manual resend feature is exposed.

The SES adapter accepts a server-only injected SDK client configured with **maxAttempts: 1**; no hidden SDK delivery retry is permitted. Generic errors are uncertain. MockEmailProvider and MockSmsProvider are functional local substitutes. A live SMS adapter is deliberately absent. No production handler, schedule or provider wiring is activated in this change.

## Administrator experience and privacy

Orders detail (also reused by customer history) offers View message status / Refresh message status. It shows confirmation email, reminder email/SMS, explicit unconfigured confirmation SMS, suppression reasons, failures/uncertainty and Denver-local provider-acceptance timestamps. Missing records do not imply delivery. Responses are capped at fifty operations and disclose truncation. Status inspection is read-only; no recipient data is copied into notification records.

The new backend status route uses existing Cognito administrator enforcement and a JWT-protected API Gateway route. The SSR relay preserves encrypted HttpOnly sessions, fixed upstream paths, no-store responses and same-origin fetch protections. Existing authenticated payment paths do not change. The only additional source infrastructure permission is Operations Query for the existing API role. No infrastructure was deployed.

## Validation and release gates

Local acceptance uses only disposable loopback DynamoDB tables, synthetic Orders, mock providers and test clients. `node backend/scripts/test-notifications-local.mjs` exercises durable duplicate/concurrent delivery, refund states and changes, consent/opt-outs, bounded retries, uncertain outcomes, cancellation, schedule deduplication, and financial-record preservation. Unit tests cover SES acknowledgement/rejection, schedule conflicts/DST, queue failures, administrator authorization and SSR rejection.

Before release, separately approve and verify: compatible payment writers and refund/Stripe handling; consent capture/current suppression ingestion; SES sender/domain, policy wording and provider configuration; SMS provider integration; exact worker packaging, least-privilege IAM and queue/poller/schedule wiring; alarm/DLQ handling and uncertain-delivery reconciliation; managed-DynamoDB concurrency; actual deployment artifacts; real administrator and customer notification acceptance. No exception or live acceptance is granted. No cloud resources, live data, payment admission, or original testing workspace are changed here.

## Recorded local checkpoint

- Frontend: 546 tests passed; type checking, lint and production build passed.
- Backend: 1,084 tests passed, plus ten legacy artifact checks and one isolated API artifact check. Dependency audit: zero findings.
- Infrastructure: 133 tests passed; offline CDK synthesis without lookups passed.
- DynamoDB Local: ten notification acceptance groups passed, including provider-success/persistence-failure ambiguity and independent SMS failure; existing Order/payment-start local acceptance passed.
- Browser: keyboard search/history/status/refresh passed against a synthetic local API and isolated DynamoDB table; 375 px viewport had no horizontal overflow. No live provider was called.
- Focused review covered payment event identity, atomic companion records, refund eligibility, consent/opt-out enforcement, conditional delivery claims, ambiguous outcomes, authorization/privacy, and financial isolation. A stale rejection reason on successful retry was corrected. No remaining verified source defect was identified in that review.
- Read-only deployment-safety verification passed before source publication. GitHub workflows remain validation-only; Amplify automatic builds, branch creation and PR previews remain disabled; public hosting remains Job 9 and restricted Admin DEV remains Job 1. Accepted artifact references and the original testing-workspace diff are unchanged.
