# Batch & Batter Cookie Co.
## Weekly Cookie Drop Platform — Product Requirements Document

**Version:** 1.1
**Status:** APPROVED
**Business:** Batch & Batter Cookie Co.
**Customer-facing wordmark:** Batch & Batter
**Descriptor:** Cookie Co.

---

## 1. Product Summary

Batch & Batter Cookie Co. will operate a direct-to-consumer ecommerce platform for limited weekly cookie drops.

The standard Drop opens Sunday at 12:00 PM and remains available until applicable inventory sells out.

Customers will:

1. Browse the current Drop.
2. Select cookies.
3. Receive a temporary inventory reservation.
4. Complete payment online.
5. Select a pickup date.
6. Receive confirmation and pickup reminders.
7. Pick up during the published pickup window.

The system should create excitement around limited weekly batches without creating an unnecessarily stressful checkout experience.

---

## 2. Product Vision

Create a premium digital storefront that makes purchasing a limited weekly cookie Drop feel:

**Beautiful. Fast. Fair. Easy. Delicious.**

The cookie is the visual star of the experience.

Technology should largely disappear behind a simple customer journey while giving the business owner strong operational control.

---

## 3. Product Goals

The platform must:

- Support configurable weekly and special Drops.
- Prevent overselling.
- Prevent indefinite inventory holds.
- Give legitimate customers reasonable time to pay.
- Support secure online payments.
- Support Apple Pay, Google Pay, and card payments where available.
- Allow pickup-date selection without appointment scheduling.
- Automate confirmations and reminders.
- Support sold-out-product waitlists.
- Allow appropriate customer self-service.
- Provide comprehensive administrator controls.
- Remain inexpensive to operate at small-business scale.
- Scale without requiring a complete redesign.
- Work particularly well on mobile devices.

---

## 4. MVP Sales Model

The MVP is optimized for selling individual cookies as configurable products.

Each sellable product has a cookie-unit value.

The initial default is:

**1 sellable unit = 1 cookie**

This allows the system to support fixed boxes or packs in the future without redesigning inventory rules.

Default maximum quantity:

**12 cookie units per order**

The quantity limit must be configurable by Drop.

---

## 5. The Drop

A **Drop** is the central commercial event within Batch & Batter.

A Drop contains configurable information including:

- Name
- Description
- Status
- Opening date/time
- Optional closing date/time
- Products
- Prices
- Inventory
- Quantity limit
- Pickup dates
- Pickup hours
- Pickup location
- Pickup instructions
- Pickup-change cutoff
- Cancellation/refund configuration
- Reminder configuration
- Product media

The standard weekly defaults are:

**Opens:** Sunday at 12:00 PM
**Ordering closes:** When sold out
**Pickup:** Thursday–Saturday
**Maximum:** 12 cookie units per order

These must remain configurable rather than hard-coded.

A Drop may be skipped entirely for any week. The system must never assume that a Drop exists simply because it is Sunday.

---

## 6. Drop States

A Drop should support:

- DRAFT
- SCHEDULED
- OPEN
- PAUSED
- SOLD_OUT
- CLOSED
- COMPLETED

Administrators can pause or close a Drop without modifying application code.

Existing paid orders remain valid when ordering is paused or closed.

Each individual Drop may optionally be scheduled to open automatically at its configured opening time. Drop creation itself is never automatic.

Administrators may:

- Skip weeks.
- Change a scheduled opening time before the Drop opens.
- Leave a Drop in DRAFT indefinitely.
- Cancel/unpublish a scheduled Drop.
- Open a Drop manually.
- Pause or close an active Drop.

Sunday at 12:00 PM is a default, not a permanent system rule.

---

## 7. Products

Each product should support:

- Name
- Description
- Price
- Cookie-unit value
- Images
- Optional video
- Ingredients
- Allergen information
- Availability
- Inventory
- Display order
- Active/inactive status

Products may be reused across multiple Drops while allowing different pricing and inventory for each Drop.

---

## 8. Inventory States

Inventory conceptually exists as:

**AVAILABLE → RESERVED → SOLD**

or:

**AVAILABLE → RESERVED → AVAILABLE**

when a reservation expires or items are removed.

At all times:

**Available + Reserved + Sold = Allocated Drop Inventory**

The platform must never sell or reserve more inventory than exists.

---

## 9. Eight-Minute Shopping Reservation

When the first item is successfully added to an empty cart, inventory is reserved and an:

**8-minute shopping reservation**

begins.

The timer begins at the first successful inventory reservation, not when checkout begins.

Adding more products does not reset the timer.

Removing products immediately returns those quantities to available inventory.

The backend/database owns the authoritative expiration time.

The customer-facing countdown is only a representation of that authoritative timestamp.

---

## 10. Reservation Expiration

If payment has not legitimately begun before the shopping reservation expires:

**RESERVED → AVAILABLE**

The customer should receive a clear message explaining that the reservation expired and inventory has returned to availability.

The system must revalidate availability before allowing the customer to create another reservation.

---

## 11. Payment Grace Period

If the customer initiates payment while the shopping reservation is still valid, the reservation may transition into a:

**One-time 4-minute payment grace period**

The grace period:

- May occur only once.
- Cannot be manually restarted.
- Cannot be reset by refreshing.
- Cannot be reset using another browser tab.
- Does not begin merely because the checkout page was opened.
- Begins when the customer actually submits a valid payment attempt.

During this period the inventory remains protected.

---

## 12. Payment-in-Flight Clarification

The four-minute grace period defines the customer's opportunity to complete the payment interaction.

A customer cannot continue extending the reservation after four minutes.

However, if the customer validly completed the required payment interaction before the deadline and the payment processor is already performing an authorization or final processing step, the system may temporarily preserve the reservation while that specific payment attempt reaches a definitive result.

This technical processing period:

- Is not customer-controlled.
- Cannot be restarted.
- Cannot be used to continue shopping.
- Cannot be used to initiate additional payment attempts.
- Must have a bounded technical timeout.
- Must resolve to SOLD or AVAILABLE.

This prevents inventory from being released underneath a legitimate payment already being processed while preserving the fairness of the customer-facing four-minute rule.

---

## 13. Checkout

Checkout should collect only information necessary to process and fulfill the order.

Expected information:

- Name
- Email
- Mobile phone number
- Pickup date
- Required acknowledgements/consents
- Payment information through Stripe

Before payment, the customer must see:

- Products
- Quantities
- Subtotal
- Applicable taxes/fees
- Final total
- Pickup date
- Pickup hours
- Pickup location
- Reservation status

---

## 14. Payment Methods

Stripe will process payments.

MVP payment methods:

- Credit/debit card
- Apple Pay where supported
- Google Pay where supported

The MVP intentionally excludes payment methods whose settlement behavior conflicts with Batch & Batter's short-lived inventory reservation model.

The application will not store raw card details.

---

## 15. Payment Authority

A successful-looking browser page is not sufficient evidence that an order has been paid.

Payment status must be verified through trusted server-side Stripe information.

Duplicate or retried payment events must not:

- Create duplicate orders.
- Deduct inventory twice.
- Send duplicate refunds.
- Fulfill an order twice.

---

## 16. Pickup Model

Customers choose a **pickup date**, not an appointment slot.

Each date has predetermined pickup hours.

Example:

**Thursday — 4:00 PM–7:00 PM**
**Friday — 4:00 PM–7:00 PM**
**Saturday — 12:00 PM–3:00 PM**

There is no appointment capacity within those windows.

Pickup dates and hours are configurable for every Drop.

---

## 17. Pickup-Date Changes

Customers may change their pickup date until:

**3:00 PM the day before their currently scheduled pickup**

The time is configurable, with 3:00 PM as the default.

Customers may choose another active pickup date offered for the same Drop.

After the cutoff, self-service changes are disabled and the customer is directed to contact Batch & Batter.

If a customer legitimately changes pickup dates, applicable future cancellation and reminder calculations use the newly confirmed pickup date.

---

## 18. Cancellation and Refund Policy

A customer may cancel a paid order for a full refund until:

**24 hours before the beginning of the scheduled pickup window**

Example:

Friday pickup: 4:00 PM–7:00 PM
Guaranteed full-refund deadline: Thursday at 4:00 PM

The default 24-hour period should eventually be configurable.

After the deadline, refunds are not guaranteed.

Batch & Batter may provide full or partial refunds at administrator discretion for exceptional circumstances.

---

## 19. Eligible Cancellation Workflow

When an eligible cancellation succeeds:

- The order is cancelled.
- The appropriate Stripe refund is initiated.
- Inventory is returned to availability when appropriate.
- Returned inventory may trigger waitlist notifications.
- The customer receives confirmation.
- The action is recorded for audit purposes.

Refund handling must be safe against duplicate requests.

---

## 20. Missed Pickup Policy

Customers must collect orders during their selected pickup date and published pickup hours.

If an order has not been collected by the end of the pickup window, it may be marked:

**MISSED_PICKUP**

Missed pickups are not automatically eligible for refunds.

The customer may contact Batch & Batter for assistance.

When operationally possible, Batch & Batter may arrange an alternative pickup at its discretion.

Alternative pickup, remake, replacement, and refund are not guaranteed.

Batch & Batter is not required to hold missed orders indefinitely.

The administrator should retain discretion to resolve individual circumstances appropriately.

---

## 21. Business-Initiated Changes

If Batch & Batter materially changes:

- Pickup date
- Pickup hours
- Pickup location
- Order availability

affected customers should receive appropriate email and SMS communication.

If Batch & Batter cannot fulfill a paid order, the customer receives a full refund.

If a material business-initiated pickup change creates a genuine conflict for the customer, administrators should have the ability to cancel and fully refund the order even if the normal customer cancellation deadline has passed.

---

## 22. Order States

The system should support an order lifecycle including:

- PAYMENT_PENDING
- PAID
- READY_FOR_PICKUP
- PICKED_UP
- MISSED_PICKUP
- CANCELLATION_PENDING
- CANCELLED
- REFUND_PENDING
- REFUNDED
- PARTIALLY_REFUNDED
- PAYMENT_FAILED

Cart/reservation states are maintained separately from paid-order states.

---

## 23. Guest Checkout

Customer accounts are not required for the MVP.

Customers should be able to complete a purchase through guest checkout.

After purchase, customers receive a secure order-management link.

The link may provide eligible self-service functions such as:

- Viewing order details
- Viewing pickup information
- Changing pickup date before cutoff
- Cancelling before the refund deadline

Optional customer accounts may be introduced later.

---

## 24. Order Confirmation

After confirmed payment, the customer receives an email confirmation.

Confirmation should include:

- Name
- Order number
- Items
- Quantities
- Amount
- Pickup date
- Pickup hours
- Pickup location
- Pickup instructions
- Secure order-management link
- Relevant cancellation policy
- Relevant missed-pickup policy or link to policy

SMS confirmation may also be enabled when appropriate and consented.

---

## 25. Pickup Reminder

The customer receives:

**Email + SMS**

on the day before scheduled pickup.

Default send time:

**10:00 AM in the business's local timezone**

The reminder includes:

- Customer name
- Order number
- Pickup date
- Pickup hours
- Pickup location
- Pickup instructions
- Order-management link when appropriate

Reminder timing must be configurable.

---

## 26. Notification Failure

Failure to deliver an email or SMS does not invalidate an otherwise valid paid order.

Important notification failures should be visible to administrators so manual intervention is possible when appropriate.

Email and SMS delivery status should be tracked independently.

---

## 27. Waitlist

A sold-out product may display:

**Join Waitlist**

Waitlists are specific to a product within a Drop.

Joining a waitlist:

- Does not reserve inventory.
- Does not guarantee inventory.
- Does not charge the customer.
- Does not automatically create an order.

When inventory becomes available again, eligible waitlisted customers may receive a notification clearly stating that purchasing remains first-come, first-served.

Repeated notifications should be controlled to prevent unnecessary duplicate messaging.

---

## 28. Inventory Returned to Availability

Inventory may return because of:

- Cart item removal
- Reservation expiration
- Eligible cancellation
- Administrator adjustment
- Other approved operational action

Returned inventory should become purchasable again when it remains suitable for sale.

A cancellation or adjustment must allow the business to indicate whether inventory should actually be restocked.

---

## 29. Admin Dashboard

The authenticated admin dashboard is the operating center for Batch & Batter.

At a glance, administrators should see:

- Current Drop
- Drop status
- Revenue
- Orders
- Cookies sold
- Available inventory
- Reserved inventory
- Upcoming pickup dates
- Missed pickups
- Waitlist activity
- Orders requiring attention
- Important notification failures

---

## 30. Drop Administration

Administrators must be able to:

- Create/edit Drops
- Duplicate a prior Drop
- Set opening date/time
- Add/remove products
- Configure prices
- Configure inventory
- Configure quantity limits
- Configure pickup dates
- Configure pickup hours
- Configure pickup location/instructions
- Configure pickup-change deadline
- Configure reminder time
- Preview a Drop
- Publish a Drop
- Pause/resume ordering
- Close a Drop

---

## 31. Inventory Administration

Administrators should see:

| Product | Total | Reserved | Sold | Available |
|---|---:|---:|---:|---:|
| Brown Butter Chocolate Chip | 100 | 8 | 62 | 30 |

Inventory adjustments should record:

- Administrator
- Timestamp
- Previous quantity
- New quantity
- Reason when appropriate

The system must reject changes that would produce impossible inventory states.

---

## 32. Order Administration

Administrators must be able to:

- Search orders
- Search customers
- Filter by pickup date
- View payment status
- View pickup information
- Change pickup when appropriate
- Mark ready
- Mark picked up
- Mark missed pickup
- Resolve missed pickups
- Cancel
- Refund
- Resend confirmation
- Send/resend pickup information
- Export orders

---

## 33. Waitlist Administration

Administrators should be able to:

- View waitlist entries
- View product association
- View notification status
- Trigger appropriate availability notifications
- Prevent accidental duplicate notification campaigns

---

## 34. Visual Direction

Detailed UI work remains a separate design phase.

The customer experience should feel:

- Premium
- Minimal
- Warm
- Modern
- Spacious
- Food-focused
- Mobile-first

**Batch & Batter** should be the prominent wordmark.

**Cookie Co.** should function as the supporting descriptor.

The visual experience should emphasize high-quality cookie photography and video.

---

## 35. Homepage Direction

The homepage should immediately create desire for the current Drop.

Potential hero media includes:

- Cookie close-ups
- Breaking a cookie open
- Melted chocolate
- Brown butter
- Flaky salt
- Dough preparation
- Ingredient movement
- Finished-cookie texture

Media should communicate:

**freshness + indulgence + craftsmanship + limited availability**

without making the site feel cluttered.

---

## 36. Accessibility

The storefront and admin experience should support modern accessibility practices including:

- Keyboard navigation
- Semantic HTML
- Accessible labels
- Visible focus states
- Accessible form errors
- Appropriate color contrast
- Alternative text
- Reduced-motion support
- Screen-reader-friendly timer behavior

---

## 37. Mobile Experience

All major customer functions must work comfortably on mobile:

- Browse Drop
- Select quantities
- See availability
- Understand timer
- Checkout
- Use supported mobile wallets
- Select pickup
- Manage order
- Join waitlist

---

## 38. Analytics

The MVP should allow the business to understand:

- Orders
- Revenue
- Units sold
- Product performance
- Remaining inventory
- Reservation expirations
- Cart-to-purchase conversion
- Waitlist demand
- Pickup-date distribution
- Pickup-date changes
- Missed pickups
- Refunds/cancellations

Advanced analytics are a future enhancement.

---

## 39. Taxes and Fees

Checkout must show:

- Subtotal
- Applicable tax
- Applicable fees
- Final total

Tax rates must not be permanently hard-coded.

The production tax strategy must be confirmed before launch based on Batch & Batter's actual business, product, and jurisdictional requirements.

---

## 40. Security Requirements

The application requires:

- HTTPS
- Secure administrator authentication
- Server-side authorization
- Server-side validation
- Secure secret storage
- Verified Stripe events
- Payment idempotency
- Inventory concurrency protection
- Rate limiting where appropriate
- Audit records for sensitive administrator actions
- Minimal collection of customer information

Raw card details must not be stored.

---

## 41. Critical Edge Cases

Production readiness requires explicit handling of:

- Simultaneous attempts to purchase the final inventory
- Reservation expiration
- Payment beginning immediately before expiration
- Payment authentication near the four-minute boundary
- Payment processor delay
- Customer abandoning payment
- Card decline
- Duplicate payment events
- Delayed payment events
- Browser refresh
- Multiple tabs
- Quantity-limit violations
- Admin inventory change while inventory is reserved
- Cancellation and restocking
- Failed refund request
- Pickup change before/after cutoff
- Business-initiated pickup change
- Reminder delivery failure
- Drop pause with active carts
- Waitlist notification following restock
- Missed pickup
- Duplicate customer requests caused by retrying a network request

---

## 42. Core Acceptance Criteria

The MVP is not production-ready unless:

- Inventory cannot be oversold.
- The 8-minute reservation starts correctly.
- Additional items do not reset it.
- Removed items release inventory.
- Expired inventory becomes available.
- The four-minute grace may be used only once.
- Customers cannot artificially extend reservations.
- Legitimate in-flight payment processing is handled safely.
- Payment success commits inventory exactly once.
- Duplicate payment events cannot duplicate an order.
- Quantity limits are enforced server-side.
- Pickup dates/hours are configurable.
- The 3:00 PM pickup-change rule works.
- The 24-hour refund rule works.
- Missed pickups can be handled cleanly.
- The 10:00 AM day-before reminder works.
- Notification failure does not invalidate an order.
- Waitlists do not falsely reserve inventory.
- Administrators can run Drops without modifying code.
- Critical flows work on mobile.

---

## 43. MVP Customer Scope

MVP includes:

- Current/upcoming Drop
- Product browsing
- Availability
- Individual-cookie ordering
- Configurable quantity limit
- Cart
- 8-minute reservation
- One-time 4-minute payment grace
- Card
- Apple Pay where supported
- Google Pay where supported
- Pickup-date selection
- Confirmation
- Secure order management
- Pickup-date changes
- Cancellation/refund before deadline
- Email reminder
- SMS reminder
- Waitlist
- Missed-pickup policy

---

## 44. MVP Admin Scope

MVP includes:

- Admin login
- Dashboard
- Drop management
- Product management
- Inventory
- Pricing
- Quantity limits
- Pickup configuration
- Cancellation/refund management
- Missed-pickup management
- Orders
- Customer lookup
- Waitlists
- Notifications
- Export
- Drop preview
- Pause/close controls
- Audit information

---

## 45. Future Opportunities

Future releases may include:

- Customer accounts
- Loyalty/rewards
- Promo codes
- Gift cards
- Subscriptions
- Saved favorites
- Multiple pickup locations
- Delivery
- Shipping
- Advanced analytics
- Production forecasting
- Ingredient forecasting
- Customer segmentation
- Automated marketing
- Multiple administrative roles
- AI-assisted Drop planning

---

## 46. Product Success Definition

The customer should be able to:

**Discover → Desire → Reserve → Pay → Select Pickup → Receive Reminder → Pick Up**

The business owner should be able to:

**Configure → Sell → Prepare → Communicate → Fulfill → Reconcile**

without manually manipulating a database or changing source code.

The technology should remain largely invisible when everything is working correctly.
