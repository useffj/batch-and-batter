# Phase 5B2C3D1 — customer abandonment / payment deadline readiness

Local review and regression testing only. No live abandonment attempt has been performed. C3A, C3B and C3C acceptance remains closed and unchanged. This review does not authorize payment enablement, a new Cart, Stripe objects, deployment, or cleanup of live messages.

## Current implementation

`PaymentRepository.start` atomically moves ACTIVE to PAYMENT_PENDING while preserving reserved ownership, creates the Order/Attempt, and replaces SHOPPING responsibility with PAYMENT and PAYMENT_WORKFLOW responsibility. The one-time payment deadline is payment start plus 240000 ms. Replay returns the original identity/deadline; customer inactivity, polling, continuation, and recovery do not renew it.

`FinancialWorkflow.reconcile` retrieves canonical provider state and validates the Intent association, amount, currency and configuration. An ordinary incomplete `requires_action` Intent becomes AUTHENTICATING / WAIT_FOR_CUSTOMER_ACTION. Before deadline, capability-authorized customer status is action_required; only the authorized no-store response may carry the ephemeral action secret. At deadline equality, action/continuation admission closes and no action secret is returned. Processing is not proof of release or payment.

PAYMENT deadline work validates its exact Cart, start time and immutable deadline. Workflow recovery also detects elapsed deadlines. Durable work remains the authority; the reconciler can redeliver work independently of browser activity. Missing or stale work is acknowledged without resurrecting an Attempt.

For a canonically verified `requires_action` Intent with zero received/capturable amount at deadline, cancellation is selected with terminal reason EXPIRED. A durable CANCEL command is PREPARED, then DISPATCHED before the provider call. Redelivery retrieves the provider state first. A cancellation response alone is not release authority: the workflow retrieves canonical state again. Verified canceled state with zero received and zero capturable permits CANCELED release evidence and failure settlement.

The normal abandonment terminal convention is **Cart EXPIRED / Order EXPIRED / PaymentAttempt EXPIRED**, with customer status **expired**. A cancellation already observed before the deadline can instead retain the existing CANCELLED reason. An already selected FAILED/CANCELLED reason is not rewritten by a later clock tick. These are existing conventions, not new terminal states.

## Ownership and financial boundaries

Expiry settlement subtracts only the Cart's embedded owned quantities from each current Inventory.reserved value and leaves total/sold unchanged. Inventory Puts guard total, reserved, sold and updatedAt; business-record guards and deterministic settlement markers prevent duplicate release. Inventory updates, terminal Cart/Attempt/Order and exact deadline/workflow deletion commit atomically. Contention rereads aggregate inventory with bounded retries; unrelated reservations and historical sold units remain intact. A PAID outbox is written only by paid settlement.

For the planned isolated fixture, 20 total / 5 reserved / 0 sold / 15 available becomes 20 / 0 / 0 / 20 only after provider safety is proven. No authorization, capture command, capture, SOLD, PAID or PAID outbox is expected while the provider remains uncompleted requires_action.

**Browser abandonment is not proof of financial failure.** If canonical state advances to requires_capture near deadline, the existing authorization/capture authority and committing window take precedence. A regression proves that this can settle PAID rather than release inventory. Canonical succeeded requires valid capture authority/full-capture evidence; conflicting or unknown outcomes retain responsibility. Retrieval failures, uncertain dispatched mutations and unexpected financial state must not produce speculative release. Recovery retains reserved inventory, reports processing, and uses existing durable backoff.

## Races and regression coverage

Six focused backend cases supplement existing settlement, replay, webhook, HTTP-security and transport tests:

- Incomplete action through deadline: unchanged deadline, cancellation proof before release, EXPIRED states, secret-free customer result, no capture/outbox, exactly one release, duplicate deadline/stale workflow ACK.
- Provider already canceled just before deadline observation: canonical proof settles expiry without another provider cancellation.
- Cancellation webhook settles while expiry work is outstanding: duplicate webhook and stale workflow cannot release twice.
- Unrelated reservation arrives during inventory settlement, with prior SOLD units: retry preserves both unrelated quantities.
- Provider retrieval becomes unknown at cancellation: no release evidence, no release, both durable responsibilities retained, safe processing result and no raw exception log.
- Provider advances to requires_capture at deadline: financial authority wins; ownership stays reserved until legitimate paid settlement.

Existing tests additionally cover immutable replay/grace, deadline equality, out-of-order webhook responsibility transfer, hard-stop unknown capture, lost provider responses, rollback at transaction actions, and safe transport ACK/RETRY categories. No new telemetry design is introduced. Existing delivery logs expose safe MessageId, receiveCount, Lambda request ID, work kind/revision, business identifiers and disposition; raw bodies and provider exceptions are excluded.

## Local harness and future human procedure

The harness has a one-entry continuation guard and one accepted-start identity. It calls handleNextAction once and awaits the human-controlled challenge. While that promise is outstanding it does **not** poll the backend continuously and cannot report terminal expiry automatically. Leaving the challenge incomplete does not extend the backend deadline. A new mock holds the challenge pending across the deadline and proves no second start/token, authentication call or continuation; returning after deadline produces HARNESS_PAYMENT_DEADLINE_ELAPSED (sent=yes).

Existing HARNESS_PAYMENT_TERMINAL_FAILURE covers an authoritative expired/failed/cancelled response. HARNESS_PAYMENT_DEADLINE_ELAPSED only reports elapsed time, not settled expiry. HARNESS_AUTHENTICATION_FAILED may occur if the challenge returns an error; it likewise does not prove financial release. No new diagnostic or runtime change is required.

For a separately authorized live attempt, stage the current harness before creating timed state; use one Cart, one human Pay click and no automatic retry. Once requires_action / AUTHENTICATING / WAIT_FOR_CUSTOMER_ACTION is proven, deliberately leave authentication incomplete. Observe backend/provider state read-only through deadline and canonical cancellation, then verify exact expiry settlement, customer-safe terminal projection, work cleanup, queues and alarms. Preserve authorized capability access securely for the final customer GET; never expose it in evidence. Do not infer release from the browser, close/reload/retry to drive recovery, or manually cancel provider state. Relock admission explicitly on completion or stop. Any financial advancement or unknown state requires the existing financial-safety procedure and human review rather than a forced expiry.

## Security and scope

No runtime, infrastructure or dependency changes are made. New tests use synthetic fixtures only. Existing logs are allowlisted; canonical provider snapshots are reduced rather than raw payloads logged. The existing command ledger intentionally persists the accepted ConfirmationToken identifier and command idempotency identity for recovery; this review does not claim those fields are absent from authorized durable records. Cart capability is represented by its hash in storage. Customer business records retain their approved contact fields, not in diagnostic logs. Action secrets are transient through the authorized no-store path and excluded after terminal state. No new secret, card, capability or customer-data persistence is introduced.

## Validation

On 2026-10-01: 844 backend functional tests (six new abandonment cases), 7 backend artifact tests, 51 harness tests (one new incomplete-challenge case), 2 production-exclusion tests, 7 frontend tests, and 34 infrastructure tests passed. Backend/frontend/infrastructure typechecks and builds passed, as did frontend lint and repository formatting.

Backend audit: zero vulnerabilities. Frontend audit: one moderate and one high affected package (Next.js/PostCSS). Infrastructure audit: one high affected package (bundled brace-expansion). Every reported advisory URL matches the existing temporary development exceptions in [DEPENDENCY_RISKS.md](DEPENDENCY_RISKS.md); these are not clean frontend/infrastructure audits and remain pre-production follow-ups.

CDK synth passed, followed sequentially by a read-only diff with lookups disabled and no change set, using separate output directories and explicit authenticated DEV account / us-east-2. The diff reported no differences: no code-asset, IAM, queue, route, table, secret, admission, replacement or deletion changes. The read-only live Lambda environment check returned PAYMENT_START_ENABLED=false.

The local readiness gate passes under the documented dependency exceptions. One controlled live abandonment attempt is technically ready for separate human authorization and fresh safety checks. No live abandonment acceptance is claimed. No commit, push, deployment, AWS/Stripe mutation, payment object or payment enablement occurred.
