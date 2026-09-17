# Batch & Batter Cookie Co.
## Weekly Cookie Drop Platform — Implementation Plan

**Version:** 1.0
**Status:** READY FOR IMPLEMENTATION
**Source Documents:** PRD v1.1 — APPROVED; Technical Specification v1.1 — APPROVED

---

## 1. Purpose

This implementation plan converts the approved Batch & Batter product and technical architecture into small, testable development milestones.

The project will not be given to an AI coding agent as one large instruction.

Each phase must have:

1. A defined objective.
2. Limited scope.
3. Explicit requirements.
4. Automated tests where appropriate.
5. Manual acceptance checks.
6. An explanation of what was built.
7. A Git commit before moving forward.

Workflow:

**PLAN → BUILD → EXPLAIN → TEST → REVIEW → COMMIT → CONTINUE**

---

## 2. Completion Rule

A phase is complete when:

- Required functionality exists.
- Automated tests pass.
- Manual acceptance criteria pass.
- No known critical errors remain.
- Important implementation decisions are understandable.
- The code has been reviewed.
- The work has been committed.

---

## 3. Codex Guardrails

Codex may:

- Create files.
- Modify code.
- Run tests.
- Run development commands.
- Explain implementation choices.
- Diagnose failures.
- Recommend improvements.

Codex may not silently change:

- PRD requirements.
- Inventory rules.
- Reservation timing.
- Payment architecture.
- DynamoDB key strategy.
- Order lifecycle.
- Pickup rules.
- Cancellation/refund rules.
- Security architecture.
- AWS service choices.

If Codex believes one of those should change, it must explain why before implementation.

---

## 4. Environments

Use:

- Development
- Staging
- Production

Production must never be the primary testing environment.

---

## 5. Version Strategy

Do not blindly install newest versions.

At implementation time:

- Verify supported runtime versions.
- Use supported stable/LTS versions.
- Pin important dependencies.
- Commit lockfiles.
- Review dependency security advisories.

For AWS Amplify Hosting, remain on a supported Next.js 15.x maintenance line until Amplify officially supports a newer major version.

---

## 6. Git Strategy

Branches:

```text
main
development
feature/*
```

Early solo development may remain lightweight, but changes should still be small and reviewable.

---

# PHASE 0 — Project Workspace

## Objective

Create organized project workspace.

## Deliverables

```text
batch-and-batter/
├── docs/
│   ├── PRD.md
│   ├── TECHNICAL_SPEC.md
│   ├── IMPLEMENTATION_PLAN.md
│   └── DEPENDENCY_RISKS.md
├── README.md
└── .gitignore
```

Initialize Git on `main`.

## Gate

- Repo exists.
- Approved docs are present.
- Initial commit created.

---

# PHASE 1 — Application Foundation

## Objective

Create clean application foundation.

## Deliverables

- Next.js 15.x
- TypeScript
- App Router
- Strict TypeScript
- ESLint
- Prettier
- Vitest
- Environment validation
- Minimal page:

```text
Batch & Batter
Cookie Co.
Coming Soon
```

## Gate

- Build passes.
- Typecheck passes.
- Lint passes.
- Tests pass.

---

# PHASE 2 — Continuous Integration

## Objective

Automatically validate code changes.

## CI checks

- Dependency install
- Typecheck
- Lint
- Unit tests
- Production build

## Gate

A deliberately failing test must fail CI; fixing it must restore green CI.

---

# PHASE 3A — AWS Infrastructure Definition and Local Validation

## Objective

Define the AWS development infrastructure locally with AWS CDK without deploying anything.

## Deliverables

CDK TypeScript application representing:

- CatalogTable
- CommerceTable
- OperationsTable
- API Gateway HTTP API
- Minimal health Lambda
- Reservation SQS + DLQ
- Notification SQS + DLQ
- Cognito admin user pool
- S3 media bucket
- CloudWatch logging

Use:

- Node 24 Lambda runtime
- DynamoDB On-Demand
- Standard SQS queues
- 14-day development log retention
- least-privilege IAM
- environment-aware naming

No AWS deployment occurs.

## Tests

CDK assertions verify:

- Three tables
- PAY_PER_REQUEST
- Node 24 Lambda
- HTTP API
- `GET /health`
- Reservation queue DLQ
- Notification queue DLQ
- Cognito self-signup disabled
- S3 public access blocked

## Gate

- Infra typecheck/build passes.
- Infra tests pass.
- `npx cdk synth` passes without deployment.
- CI validates both web and infra.
- No credentials or AWS account IDs are committed.

---

# PHASE 3B — AWS Account Connection and First Dev Deployment

## Objective

Safely connect the AWS account and deploy the development infrastructure.

## Steps

- Confirm AWS account and region.
- Configure secure local AWS authentication.
- Review CDK bootstrap requirements.
- Run `cdk bootstrap`.
- Review `cdk diff`.
- Deploy development stack.
- Verify `/health`.
- Verify created dev resources.
- Configure cost budget/alerts.

## Gate

- No unexpected resources.
- `/health` succeeds.
- Budget guardrails exist.
- Dev stack can be cleanly updated/destroyed where appropriate.

---

# PHASE 4 — Products, Drops, and Pickup Data

## Objective

Learn DynamoDB through real business data.

## Implement

- Product
- Drop
- DropProduct
- Inventory
- Pickup configuration
- Current/upcoming Drop lookup
- Admin create/edit

## Gate

Create an entire fake Drop through the application without manually editing DynamoDB.

---

# PHASE 5 — Customer Storefront

## Objective

Show current/upcoming Drop.

## Implement

- Drop state
- Products
- Price
- Availability
- Pickup information
- Upcoming opening time

## Scheduled Opening

Each specific Drop may optionally have a one-time scheduled opening.

No Drop is automatically created.

Administrators may:

- Skip weeks.
- Change schedule.
- Open manually.
- Leave in draft.
- Cancel scheduled opening.

---

# PHASE 6 — Cart Foundation

## Implement

- Create cart
- Add/change/remove item
- Quantity limit
- Server-side pricing

No reservation timing yet.

---

# PHASE 7 — Inventory Reservation Engine

## Implement

- 8-minute reservation
- First-item timer start
- No reset on additional items
- Item removal releases inventory
- Standard SQS delayed expiry message
- Idempotent expiry worker
- Authoritative server timestamp

## Gate

All reservation tests pass.

---

# PHASE 8 — Concurrency Testing

Mandatory scenario:

```text
100 cookies
20 simultaneous customers
10 cookies requested each
```

Maximum successful reserved quantity:

```text
100
```

Never 110+.

Stripe work does not begin until this passes.

---

# PHASE 9 — Stripe Foundation

## Implement

- Payment Intents
- Payment Element
- Express Checkout Element
- Card
- Apple Pay where supported
- Google Pay where supported
- Manual capture

Test mode only.

---

# PHASE 10 — Four-Minute Payment Protection

## Implement

- One-time 4-minute grace
- Payment deadline SQS message
- PAYMENT_PENDING
- PAYMENT_COMMITTING
- 2-minute backend-only reconciliation hard stop
- Payment/expiration race tests

## Gate

Expiration and payment cannot both win.

---

# PHASE 11 — Stripe Webhooks and Idempotency

## Implement

- Signature verification
- External event dedupe
- Stripe idempotency keys
- Safe retries

## Gate

Same Stripe webhook delivered 10 times still results in:

- 1 order
- 1 inventory conversion
- 1 financial outcome

---

# PHASE 12 — Paid Orders

Implement:

- Internal order ID
- Customer-friendly order number
- Item snapshots
- Tax fields
- Payment reference
- Pickup
- Status

Historical values remain immutable.

---

# PHASE 13 — Guest Order Management

Implement:

- Secure management token
- Store only token hash
- View order
- View pickup
- Change eligible pickup
- Cancel when eligible
- noindex
- strict Referrer-Policy
- rate limiting

---

# PHASE 14 — Pickup Management

Implement:

- Pickup-date selection
- 3:00 PM day-before change cutoff
- Admin grouped pickup view
- READY_FOR_PICKUP
- PICKED_UP
- MISSED_PICKUP

---

# PHASE 15 — Email Notifications

Implement:

- Amazon SES
- Notification SQS
- Confirmation
- Pickup change
- Cancellation
- Refund
- Business change

Email failure must not invalidate a paid order.

---

# PHASE 16 — Automated Pickup Reminders

Use:

- EventBridge Scheduler
- one schedule per pickup date

Default:

```text
Day before pickup
10:00 AM
America/Denver
```

Scheduled job queries all eligible orders for that pickup date and queues reminders.

---

# PHASE 17 — SMS

Start with:

```text
MockSmsProvider
```

Then choose:

```text
AwsSmsProvider
```

or:

```text
TwilioSmsProvider
```

based on actual launch economics.

Implement:

- Transactional consent
- Consent timestamp/source
- Opt-out handling
- Delivery status
- Failure logging

---

# PHASE 18 — Cancellation and Refunds

Implement:

- 24-hour deadline
- Stripe refund
- duplicate-refund protection
- RESTOCK / DO_NOT_RESTOCK
- admin exceptions
- business-initiated cancellation

---

# PHASE 19 — Missed Pickup

Implement:

```text
MISSED_PICKUP
```

Admin may:

- Confirm late pickup
- Arrange alternative pickup
- Make refund exception
- Resolve/close case

No automatic refund or restock.

---

# PHASE 20 — Waitlist

Implement:

- Product/Drop waitlist
- Email
- Optional SMS with consent
- Restock availability event
- Notification dedupe

Waitlist does not reserve inventory.

---

# PHASE 21 — Admin Dashboard Completion

Show:

- Drop status
- Revenue
- Orders
- Sold
- Available
- Reserved
- Pickup totals
- Missed pickups
- Waitlist demand
- Notification failures
- Operational issues

---

# PHASE 22 — Audit and Recovery

Implement:

- Inventory adjustment audit
- Refund audit
- Cancellation audit
- Pickup override audit
- Drop publication/pause audit
- business change audit
- periodic reconciliation sweep for stuck states

---

# PHASE 23 — Analytics

Track:

```text
DROP_VIEWED
PRODUCT_ADDED
CART_CREATED
RESERVATION_EXPIRED
PAYMENT_STARTED
PURCHASE_COMPLETED
WAITLIST_JOINED
PICKUP_CHANGED
ORDER_CANCELLED
MISSED_PICKUP
```

Analytics must never block checkout.

---

# PHASE 24 — Batch & Batter Visual Design

Only after business workflows are proven:

- Wordmark treatment
- Cookie Co. descriptor
- Typography
- Hero
- Photography/video
- Product cards
- Motion
- Mobile polish
- Cart/checkout styling

---

# PHASE 25 — Accessibility and Mobile Polish

Test:

- Keyboard
- Screen reader
- Focus
- Forms
- Contrast
- Timer
- Reduced motion
- Phone/tablet/desktop

---

# PHASE 26 — Load and Failure Testing

Test:

- Drop-opening spike
- Concurrent reservations
- Lambda errors
- SQS retries
- notification outage
- webhook delay
- repeated API calls
- payment near deadline
- duplicate events

---

# PHASE 27 — Production Readiness

Complete:

- Production AWS
- Production Stripe
- SES domain setup
- SPF
- DKIM
- DMARC
- SMS registration
- Domain/HTTPS
- CloudWatch alarms
- budgets
- DynamoDB recovery
- log retention
- security review
- tax configuration
- cancellation policy
- missed-pickup policy
- privacy/terms where appropriate

---

# PHASE 28 — Soft Launch

Use limited real inventory and real payments.

Monitor:

- Reservations
- Payments
- Email
- SMS
- Pickup
- Admin operations

Document friction.

---

# PHASE 29 — Production Launch

Before every launch verify:

- Products
- Pricing
- Inventory
- Opening schedule
- Pickup dates/hours
- Quantity limit
- Cancellation rule
- Pickup-change cutoff
- Stripe health
- Email/SMS health
- Admin access

Then publish the Drop.

---

## Stop-the-Line Conditions

Pause development if:

- Inventory oversells.
- Reservation extends incorrectly.
- Payment/expiration race corrupts state.
- Duplicate webhook duplicates an order.
- Duplicate refund creates financial inconsistency.
- Secrets appear in the repo.
- Unauthorized admin action succeeds.
- Critical tests fail.

---

## What We Intentionally Do Not Build Yet

Avoid:

- Kubernetes
- ECS
- dedicated servers
- Redis
- GraphQL without a business requirement
- OpenSearch
- customer accounts
- loyalty
- subscriptions
- delivery routing
- multiple locations
- AI recommendations
- native mobile apps

---

## Definition of MVP Complete

Customer:

```text
Visit
→ View Drop
→ Select cookies
→ Receive 8-minute reservation
→ Pay safely
→ Choose pickup
→ Receive confirmation
→ Receive reminder
→ Pick up cookies
```

Owner:

```text
Create Drop
→ Configure products/inventory
→ Schedule/open Drop
→ Monitor orders
→ Prepare pickup
→ Manage exceptions
→ Complete Drop
```

without modifying code or directly editing DynamoDB.

---

## Project North Star

At every implementation decision, ask:

> Does this make Batch & Batter easier to operate, safer for customers, or more reliable?

If not, the technology probably does not belong in the MVP.
