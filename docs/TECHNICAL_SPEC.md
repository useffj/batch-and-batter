# Batch & Batter Cookie Co.
## Weekly Cookie Drop Platform — Technical Specification

**Version:** 1.1
**Status:** APPROVED
**Source of truth:** Approved PRD v1.1
**Business:** Batch & Batter Cookie Co.

---

## 1. Technical Objective

Build a low-cost, serverless AWS application that safely handles limited cookie inventory, concentrated weekly Drop traffic, short-lived reservations, Stripe payments, local pickup, automated communications, and administrator operations.

The architecture should favor:

- Correctness
- Simplicity
- Low idle cost
- Explainability
- Security
- Recoverability
- Testability
- Gradual scaling

The application should not introduce infrastructure complexity solely to look sophisticated.

---

## 2. Architecture Summary

Recommended architecture:

```text
CUSTOMER / ADMIN
       │
       ▼
Next.js Web Application
AWS Amplify Hosting
       │
       ▼
Amazon API Gateway HTTP API
       │
       ▼
Application Lambda
       │
       ├────────► DynamoDB
       ├────────► Stripe
       ├────────► Amazon SQS
       ├────────► EventBridge Scheduler
       └────────► Notification Queue

Stripe Webhooks
       │
       ▼
Stripe Webhook Lambda
       │
       ├────────► DynamoDB
       ├────────► Stripe Capture/Refund
       └────────► Notification Queue

Reservation Queue (SQS)
       │
       ▼
Reservation Worker Lambda
       │
       └────────► DynamoDB / Stripe reconciliation

Notification Queue (SQS)
       │
       ▼
Notification Worker Lambda
       │
       ├────────► Amazon SES
       └────────► SMS Provider
```

---

## 3. Primary Technology Stack

### Frontend

**Next.js 15.x + TypeScript**

Use the latest supported patched Next.js 15.x maintenance release compatible with AWS Amplify Hosting at implementation time.

Responsibilities:

- Storefront
- Cart presentation
- Reservation countdown
- Checkout UI
- Order management
- Waitlist
- Admin dashboard

### Hosting

**AWS Amplify Hosting**

Used initially for the customer/admin web application.

### Backend

**AWS Lambda + TypeScript**

Use a small domain-oriented set of functions rather than dozens of tiny functions:

- Application API Lambda
- Stripe Webhook Lambda
- Reservation Worker Lambda
- Notification Worker Lambda

### API

**Amazon API Gateway HTTP API**

Use HTTP API rather than REST API unless a future requirement justifies the more feature-heavy REST API.

### Database

**Amazon DynamoDB**

Start with On-Demand capacity.

### Authentication

**Amazon Cognito**

Used for administrators only in the MVP.

Customers use guest checkout and secure order-management links.

### Payments

**Stripe**

Use Payment Intents + Payment Element + Express Checkout Element for card, Apple Pay, and Google Pay where supported.

### Email

**Amazon SES**

### SMS

Provider abstraction with:

- AWS End User Messaging
- Twilio

Final production provider chosen based on realistic total cost and operational fit.

### Short Delay Scheduling

**Amazon SQS Standard queues**

Use per-message delays for:

- 8-minute reservation expiry
- 4-minute payment deadline

### Scheduled Business Events

**Amazon EventBridge Scheduler**

Use one-time schedules for:

- Drop opening
- Pickup-date reminder jobs

### Media

**Amazon S3**

### Observability

**Amazon CloudWatch**

### Infrastructure as Code

**AWS CDK v2 + TypeScript**

### Source Control

**GitHub**

---

## 4. Architecture Philosophy

Use managed serverless services so Batch & Batter can focus on the cookie business rather than infrastructure operations.

Avoid:

- Kubernetes
- ECS for the MVP
- Always-running servers
- Redis unless later justified
- Microservices for every domain
- Search clusters
- Enterprise networking without a requirement

---

## 5. Repository/Environment Strategy

Use:

- Development
- Staging
- Production

Production should never be the primary testing environment.

Infrastructure should use environment-aware naming such as:

```text
batch-and-batter-dev-...
batch-and-batter-staging-...
batch-and-batter-prod-...
```

Do not hard-code AWS account IDs.

---

## 6. DynamoDB Approach

Use three primary tables.

### CatalogTable

Stores:

- Products
- Drops
- Drop products
- Inventory
- Pickup configuration

### CommerceTable

Stores:

- Carts
- Cart items
- Payment attempts
- Orders
- Order items
- Waitlist entries
- Lookup records

### OperationsTable

Stores:

- External event IDs
- Idempotency records
- Audit records
- Operational/reconciliation state

A separate Customer table is not required for the MVP because customers use guest checkout.

---

## 7. DynamoDB Key Model

All core tables use:

```text
PK (String)
SK (String)
```

Representative patterns:

```text
PRODUCT#<productId> / META
DROP#<dropId> / META
DROP#<dropId> / PRODUCT#<productId>
DROP#<dropId> / INVENTORY#<productId>
DROP#<dropId> / PICKUP#<date>
CART#<cartId> / META
CART#<cartId> / ITEM#<productId>
ORDER#<orderId> / META
ORDER#<orderId> / ITEM#<productId>
WAITLIST#<dropId>#<productId> / <joinedAt>#<waitlistId>
```

Internal IDs should be collision-resistant and sortable, such as ULID.

Public order numbers remain separate.

---

## 8. Required DynamoDB Indexes

CommerceTable should support at least:

### Orders by Pickup Date

Conceptual:

```text
GSI1PK = PICKUP#2026-10-09
GSI1SK = ORDER#<createdAt>#<orderId>
```

Supports:

> Show all orders scheduled for Friday.

### Orders by Drop

Conceptual:

```text
GSI2PK = DROP#<dropId>
GSI2SK = ORDER#<createdAt>#<orderId>
```

Supports:

> Show all orders for this Drop.

### Reconciliation/Expiration Access Pattern

Maintain a queryable expiration/state access pattern for stale carts/payment attempts so the recovery process does not rely on full table scans.

---

## 9. Current/Upcoming Drop Lookup

Maintain a small store configuration record that identifies the current and/or next relevant Drop.

Do not rely on scanning all Drops to determine what the storefront should display.

---

## 10. Inventory Record

Conceptual record:

```text
dropId
productId
total
reserved
sold
updatedAt
```

Derived:

```text
available = total - reserved - sold
```

Invariant:

```text
reserved >= 0
sold >= 0
reserved + sold <= total
```

Protect the invariant with DynamoDB conditions and transactions.

---

## 11. Atomic Inventory Reservation

Adding inventory to a cart must use a DynamoDB transaction.

Conceptually:

1. Verify cart is active and not expired.
2. Verify requested product has sufficient availability.
3. Increase reserved quantity.
4. Update/create cart item.
5. Update cart metadata if needed.

All operations succeed together or fail together.

---

## 12. Shopping Reservation

When the first item is successfully reserved:

```text
shoppingExpiresAt = serverNow + 8 minutes
```

The backend creates the timestamp.

The browser receives it only for display.

Adding items does not alter it.

Removing items immediately releases corresponding reserved inventory.

---

## 13. Reservation Expiration Architecture

Use two layers.

### Layer 1 — Synchronous Enforcement

Every relevant backend operation checks:

```text
currentTime < shoppingExpiresAt
```

Expired carts cannot continue even if cleanup has not run.

### Layer 2 — Delayed SQS Wake-Up

When the first reservation is created, send a Standard SQS message with:

```text
DelaySeconds = 480
```

The Reservation Worker re-reads the cart after the delay.

If still expired and releasable, it atomically releases inventory.

If state has already changed, the stale message does nothing.

---

## 14. SQS Requirements

Use **Standard queues**, not FIFO, because individual message timers are required.

Create:

- ReservationQueue
- ReservationDeadLetterQueue
- NotificationQueue
- NotificationDeadLetterQueue

Use sensible redrive settings such as:

```text
maxReceiveCount = 5
```

All consumers must be idempotent because SQS Standard delivery is at-least-once.

---

## 15. Recovery Sweep

Add a lightweight periodic reconciliation process, approximately every 15 minutes, that queries for stuck/stale reservation and payment states.

This is a safety net for:

- Worker failures
- DLQ scenarios
- Unexpected transient errors

It is not the primary reservation timer.

---

## 16. DynamoDB TTL

TTL may be used for eventual cleanup of obsolete temporary records such as:

- Expired carts
- Old idempotency records
- Temporary operational records

TTL never determines whether a customer currently owns inventory.

---

## 17. Cart State

Cart/reservation states:

```text
ACTIVE
PAYMENT_PENDING
PAYMENT_COMMITTING
CONVERTED
EXPIRED
CANCELLED
```

State transitions must use conditional updates so competing processes cannot both win.

---

## 18. Stripe Integration Strategy

Use:

**Stripe Payment Intents + Payment Element + Express Checkout Element**

Initially enable:

- Card
- Apple Pay where supported
- Google Pay where supported

Do not initially enable slower settlement methods that conflict with short-lived inventory reservations.

Do not let Stripe-hosted Checkout control inventory timing.

Batch & Batter owns inventory timing.

Stripe owns payment processing.

---

## 19. Payment Start

When the customer presses Pay:

Backend validates:

```text
cart.status == ACTIVE
currentTime < shoppingExpiresAt
paymentGraceUsed == false
```

Then atomically transitions:

```text
status = PAYMENT_PENDING
paymentGraceUsed = true
paymentStartedAt = now
paymentDeadline = now + 4 minutes
```

A second request cannot create another grace period.

---

## 20. Payment Deadline Wake-Up

When payment begins, send:

```text
PaymentDeadlineMessage
DelaySeconds = 240
```

to the Reservation Queue.

The worker later reconciles the current cart/payment state.

---

## 21. Stripe Capture Strategy

Use **manual capture** for supported card-based payments.

Intended sequence:

```text
Customer submits payment
        ↓
Stripe authorization/authentication
        ↓
Payment becomes capturable
        ↓
Batch & Batter claims PAYMENT_COMMITTING
        ↓
Stripe capture
        ↓
RESERVED inventory → SOLD
        ↓
Order → PAID
```

This reduces the chance of charging before confirming that the reservation can safely commit.

---

## 22. Payment-in-Flight Handling

The customer-facing payment window remains 4 minutes.

At the 4-minute deadline:

### If Stripe still requires customer action

Expire/cancel the attempt when appropriate and release inventory.

### If Stripe has already reached a legitimate authorized/capturable state

Transition to:

```text
PAYMENT_COMMITTING
```

and continue finalization.

The customer cannot restart or exploit this state.

---

## 23. Backend-Only Hard Stop

After entering PAYMENT_COMMITTING, allow a short bounded technical reconciliation period.

Default:

**2 additional backend-only minutes**

This is not visible to the customer and does not extend shopping/payment interaction.

If Stripe remains genuinely ambiguous at the hard stop:

- Safely cancel/void/refund as appropriate.
- Reconcile inventory.
- Record the incident.
- Surface it to administrators.

Never guess.

---

## 24. Payment State Machine

Payment-attempt states:

```text
CREATED
AUTHENTICATING
AUTHORIZED
CAPTURE_IN_PROGRESS
CAPTURED
FAILED
CANCELLED
EXPIRED
```

These remain distinct from cart/order states.

---

## 25. Payment Race Protection

Before Stripe capture, atomically transition:

```text
PAYMENT_PENDING → PAYMENT_COMMITTING
```

Only one path may win.

After PAYMENT_COMMITTING:

- Expiration workers cannot release inventory.
- Customer cannot initiate another payment.
- System completes or safely rolls back the attempt.

---

## 26. Stripe Idempotency

Use deterministic Stripe idempotency keys for important POST requests.

Examples:

```text
payment-create:<paymentAttemptId>
payment-capture:<paymentAttemptId>
refund:<refundId>
```

Application-level idempotency remains required.

---

## 27. Stripe Webhooks

Dedicated webhook Lambda must:

1. Preserve raw request body.
2. Verify Stripe signature.
3. Reject invalid requests.
4. Check whether the external event was already processed.
5. Apply changes idempotently.
6. Record the event ID.
7. Return promptly.

Do not depend on webhook event ordering.

---

## 28. External Event Deduplication

OperationsTable pattern:

```text
PK: EXTERNAL_EVENT#STRIPE#<eventId>
SK: META
```

Conditional insert determines whether an event is new.

Duplicate events do not repeat business effects.

---

## 29. Successful Payment Finalization

After confirmed capture, perform an idempotent DynamoDB transaction:

```text
inventory.reserved -= quantity
inventory.sold += quantity
cart.status = CONVERTED
order.status = PAID
payment.status = CAPTURED
```

Then queue confirmation notifications.

---

## 30. Order Model

Order includes:

```text
orderId
displayOrderNumber
dropId
status
paymentStatus
customer
pickup
subtotal
tax
total
stripePaymentIntentId
createdAt
updatedAt
```

Order items snapshot transaction-time product information.

Catalog changes must never rewrite historical orders.

---

## 31. Guest Checkout Security

Generate a cryptographically random management token after payment.

Store only a secure hash.

Customer receives a URL such as:

```text
https://batchandbatter.com/order/manage/<token>
```

Order-management pages should additionally use:

- noindex
- strict Referrer-Policy
- minimal/no third-party scripts
- rate limiting
- token expiration after a reasonable post-order period

Knowing an order number alone must not grant access.

---

## 32. Pickup Configuration

Each pickup date stores:

```text
date
startTime
endTime
timezone
active
```

Business timezone:

```text
America/Denver
```

Store absolute timestamps in UTC where appropriate while retaining the business timezone for scheduling/display logic.

---

## 33. Pickup-Date Change

Backend validates:

- Secure token
- Eligible order status
- Current time before cutoff
- Requested date belongs to same Drop
- Requested date is active

On success:

- Update order.
- Record history/audit event.
- Future cancellation and reminder calculations use the new date.

---

## 34. Cancellation

Eligibility:

```text
pickupWindowStart - 24 hours
```

Eligible customer cancellation:

1. Validate secure order token.
2. Validate order state.
3. Validate deadline.
4. Transition to CANCELLATION_PENDING.
5. Initiate Stripe refund.
6. Confirm refund.
7. Transition to REFUNDED/CANCELLED.
8. Restock when appropriate.
9. Queue confirmation.

Duplicate refunds must be impossible.

---

## 35. Restock Disposition

Refund/admin flow should explicitly support:

```text
RESTOCK
DO_NOT_RESTOCK
```

Not every refund should return physical inventory to sale.

---

## 36. Missed Pickup

After the pickup window ends, an eligible uncollected order may become:

```text
MISSED_PICKUP
```

This does not automatically:

- Refund
- Restock
- Remake

The order enters an administrator attention queue.

---

## 37. Pickup Reminder Architecture

Use one EventBridge schedule per pickup date rather than one schedule per order.

Example:

Friday pickup date:

```text
Thursday 10:00 AM America/Denver
```

The scheduled job queries all eligible Friday orders and queues reminder notifications.

This greatly reduces schedule-management complexity when customers change pickup dates.

---

## 38. Drop Opening Automation

Each Drop may optionally have a scheduled opening date/time.

Create a one-time scheduled operation for that specific Drop.

Important:

- Drop creation is never automatic.
- No recurring Sunday Drop is assumed.
- If no Drop exists for a week, nothing opens.
- Admin may change/cancel a scheduled opening.
- Admin may open manually.

Every purchase API also independently validates Drop status and `opensAt`.

---

## 39. Email Architecture

Use Amazon SES for transactional email.

Email types include:

- Order confirmation
- Pickup reminder
- Pickup change
- Cancellation
- Refund
- Waitlist availability
- Business-initiated changes

Email sending must be asynchronous via NotificationQueue.

Checkout success must not depend on SES availability.

---

## 40. SMS Architecture

Use an abstraction:

```text
SmsProvider.send(...)
```

Implementations:

```text
AwsSmsProvider
TwilioSmsProvider
MockSmsProvider
```

Business logic must not depend directly on provider-specific responses.

Final provider is selected pre-launch based on:

- Number rental
- Registration
- Campaign fees
- Carrier fees
- Per-segment pricing
- Reliability
- Delivery reporting
- Operational effort

---

## 41. SMS Consent

Store:

```text
phone
smsTransactionalConsent
consentedAt
consentSource
optOutAt
```

Transactional consent must not silently become marketing consent.

---

## 42. Waitlist

Waitlist entries never reserve inventory.

When inventory returns:

1. Update inventory.
2. Create restock availability event.
3. Queue eligible notifications.
4. Deduplicate repeated notifications.

Message must state that inventory is available but not reserved.

---

## 43. Admin Authentication

Use Amazon Cognito.

MVP role:

```text
ADMIN
```

Future roles may include:

```text
OWNER
MANAGER
BAKER
PICKUP_STAFF
```

Backend authorization is mandatory.

Frontend hiding alone is not security.

---

## 44. API Design

Use REST-style HTTPS endpoints.

Representative customer routes:

```text
GET    /drops/current
GET    /drops/{dropId}
POST   /carts
GET    /carts/{cartId}
POST   /carts/{cartId}/items
PATCH  /carts/{cartId}/items/{productId}
DELETE /carts/{cartId}/items/{productId}
POST   /carts/{cartId}/payment/start
GET    /orders/manage/{token}
PATCH  /orders/manage/{token}/pickup
POST   /orders/manage/{token}/cancel
POST   /waitlists
```

Webhook:

```text
POST /webhooks/stripe
```

Admin routes:

```text
/admin/drops
/admin/products
/admin/inventory
/admin/orders
/admin/waitlists
/admin/notifications
```

Exact route shapes may be refined without changing the domain model.

---

## 45. API Validation

Every mutation validates server-side:

- Quantity
- Product/Drop relationship
- Drop status
- Reservation validity
- Inventory
- Pickup date
- Cancellation deadline
- Authorization

Use a TypeScript schema-validation library such as Zod.

---

## 46. Error Contract

Return consistent errors:

```json
{
  "code": "RESERVATION_EXPIRED",
  "message": "Your cookie reservation has expired.",
  "requestId": "..."
}
```

Expected codes include:

```text
DROP_NOT_OPEN
PRODUCT_SOLD_OUT
INSUFFICIENT_INVENTORY
QUANTITY_LIMIT_EXCEEDED
RESERVATION_EXPIRED
PAYMENT_ALREADY_STARTED
PAYMENT_FAILED
INVALID_PICKUP_DATE
PICKUP_CHANGE_DEADLINE_PASSED
CANCELLATION_DEADLINE_PASSED
ORDER_NOT_FOUND
UNAUTHORIZED
CONFLICT
```

---

## 47. API Request Idempotency

Important mutations should accept an application idempotency key.

Examples:

- Add/change cart quantity
- Start payment
- Cancel order

Network retries must not repeat the business operation.

---

## 48. Admin Inventory Adjustment

Admin adjustments must be atomic.

Record:

```text
product
drop
previousInventory
newInventory
reason
admin
timestamp
```

Reject changes that would create impossible states such as:

```text
totalInventory < reservedInventory + soldInventory
```

unless a later explicit corrective workflow is designed.

---

## 49. Taxes

Order model separates:

```text
subtotal
tax
total
```

Do not hard-code tax rates.

Final tax strategy is a pre-launch business/legal configuration item.

---

## 50. Audit Logging

Append-only operational audit events should cover:

- Inventory adjustments
- Refunds
- Cancellations
- Pickup overrides
- Drop publication
- Drop pause
- Business-initiated changes

---

## 51. Logging and Monitoring

Use structured CloudWatch logs with correlation/request IDs.

Useful identifiers:

```text
cartId
orderId
dropId
paymentAttemptId
stripeEventId
```

Do not log sensitive payment data or unnecessary PII.

Monitor:

- API 5xx spikes
- Lambda failures
- Reservation worker failures
- DLQ messages
- Webhook failures
- Capture failures
- Refund failures
- Notification worker failures
- Reminder failures

---

## 52. Operational Attention Queue

Admin dashboard should surface:

- Refund failed
- Payment inconsistency
- Repeated notification failure
- Missed pickup
- Inventory reconciliation issue
- Business-initiated customer issue

Do not force operators to inspect CloudWatch for ordinary exceptions.

---

## 53. Media

Store product media in S3.

Do not store image/video bytes in DynamoDB.

Deliver optimized media through appropriate CDN/image optimization.

Do not serve huge originals directly to customers.

---

## 54. Security

MVP controls:

- HTTPS
- Cognito admin authentication
- Backend authorization
- Input validation
- Stripe signature verification
- Secure order tokens
- API throttling
- Least-privilege IAM
- Secure configuration
- Restricted CORS
- Secure headers
- Audit logs
- No raw card storage

Do not place Lambdas in a VPC unless a real requirement appears.

Do not add WAF initially unless abuse justifies it.

---

## 55. Secrets and Configuration

Do not store secrets in Git.

Use AWS Systems Manager Parameter Store/SecureString initially for straightforward application secrets/configuration.

Examples:

- Stripe secret key
- Stripe webhook secret
- SMS credentials

Use more specialized secret-management capabilities later if requirements justify them.

---

## 56. Infrastructure as Code

Use AWS CDK v2 with TypeScript.

Infrastructure includes:

- DynamoDB
- Lambda
- API Gateway HTTP API
- SQS + DLQs
- EventBridge Scheduler permissions
- Cognito
- SES references/configuration
- S3
- IAM
- CloudWatch alarms

AWS Console may be used for inspection, not as the only source of truth.

---

## 57. CI/CD

Recommended flow:

```text
feature branch
      ↓
automated tests
      ↓
review
      ↓
merge
      ↓
staging deployment
      ↓
smoke/E2E verification
      ↓
production release
```

Frontend may use Amplify Git integration.

Backend/infrastructure should be reproducible through CDK.

Use short-lived AWS CI authentication where practical rather than permanent admin keys.

---

## 58. Dependency Security

Known dependency risks must be documented and reviewed rather than force-fixed.

Do not use:

```text
npm audit fix --force
```

without explicit review.

The current Next.js 15.x/PostCSS transitive risk is tracked in `docs/DEPENDENCY_RISKS.md`.

Reassess before production deployment and whenever a newer supported Next.js 15.x release becomes available.

---

## 59. Testing Strategy

### Unit

Test business rules such as:

```text
reservationHasExpired()
canChangePickup()
canCancelForRefund()
availableInventory()
canBeginPayment()
```

### Integration

Test:

- DynamoDB transactions
- Conditional writes
- Reservation creation/removal
- Expiration
- Refund/restock
- Event deduplication

### Concurrency

Mandatory scenario:

```text
100 cookies available
20 simultaneous customers request 10
```

Expected:

```text
Exactly 10 requests may succeed.
Maximum reserved inventory = 100.
Never 110+.
```

### Stripe

Test:

- Success
- Decline
- 3DS/authentication
- Abandonment
- Near-deadline authorization
- Manual capture
- Duplicate webhook
- Out-of-order webhook
- Delayed webhook
- Duplicate capture
- Refund
- Duplicate refund
- Expiration/payment race

### Pickup

Test:

- Valid date
- Invalid date
- Cutoff before/after
- Admin override
- Reminder query
- Cancellation recalculation
- Missed pickup

### Accessibility

Test:

- Keyboard navigation
- Focus
- Forms
- Timer behavior
- Reduced motion
- Mobile layouts

---

## 60. Cost Strategy

Favor low idle cost.

Initial guidance:

- Serverless services
- DynamoDB On-Demand
- No VPC for Lambdas unless needed
- No dedicated SES IPs initially
- No WAF unless justified
- Finite CloudWatch log retention
- AWS budgets and cost alerts
- No expensive always-running infrastructure

---

## 61. Messaging Launch Prerequisites

Before production:

### Email

Configure:

- Real domain
- SPF
- DKIM
- DMARC
- SES production sending

### SMS

Complete selected provider's:

- Sender registration
- Number setup
- A2P/toll-free/other required registration
- Consent/opt-out configuration

Messaging setup is a production readiness requirement, not an afterthought.

---

## 62. Development Workflow With Codex

For every phase:

```text
PLAN
↓
IMPLEMENT
↓
EXPLAIN
↓
TEST
↓
REVIEW
↓
COMMIT
```

Codex may not silently change:

- Inventory model
- Reservation timing
- DynamoDB key design
- Payment architecture
- Stripe manual-capture approach
- Order lifecycle
- Pickup cutoff
- Cancellation policy
- Guest-token strategy
- SMS consent model

---

## 63. Architectural Guardrails

Explicit review is required before changing:

- Inventory invariants
- DynamoDB keys/indexes
- 8-minute reservation
- 4-minute payment grace
- 2-minute backend reconciliation hard stop
- Standard SQS delayed message strategy
- Stripe manual capture
- Webhook idempotency
- Cancellation/refund model
- Pickup rules
- Order management token design
- Messaging consent

---

## 64. Definition of Technical Success

Technical success means:

- Two customers cannot buy the same last cookie.
- An expired timer cannot be hacked in the browser.
- A stale SQS message cannot release inventory twice.
- A payment cannot repeatedly extend reservation time.
- A legitimately authorized payment cannot lose inventory because an expiry worker fires milliseconds later.
- A duplicate Stripe webhook cannot create a duplicate order.
- A failed SMS cannot cancel a purchase.
- A missed pickup can be handled without database surgery.
- The owner can operate weekly Drops without touching DynamoDB.
- The architecture remains understandable enough to explain why each major service exists.

---

## 65. Technical North Star

Batch & Batter does not need the most elaborate ecommerce architecture.

It needs the smallest architecture that can reliably guarantee:

**the right customer gets the right cookies, pays the right amount, knows when to pick them up, and cannot accidentally be promised inventory that does not exist.**
