'use client';
/* Full navigation rereads the current storefront and Cart. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useRef, useState } from 'react';
import {
  Elements,
  ExpressCheckoutElement,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import {
  normalizeUSPhone,
  phoneEntry,
  PHONE_HELP,
} from '../../lib/checkout/phone';
import { LOCK } from '../../lib/cart/client';
import {
  CheckoutClient,
  CheckoutFailure,
  elementsOptions,
  expressOptions,
} from '../../lib/checkout/client';
import {
  EMAIL,
  paymentMessages,
  pickupAllowed,
  recoveryMessage,
  terminal,
  type CheckoutSnapshot,
  type Customer,
} from '../../lib/checkout/contract';
const money = (n: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    n / 100,
  );
export function CheckoutSummary({
  snapshot,
  pickup,
}: {
  snapshot: CheckoutSnapshot;
  pickup: string;
}) {
  const { cart, summary, drop } = snapshot;
  if (!cart) return null;
  const chosen = drop?.pickupDates.find((p) => p.date === pickup);
  return (
    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading">Your cookies</h2>
      <ul className="checkout-lines">
        {cart.items.map((line, i) => (
          <li key={line.productId}>
            <span>
              {drop?.products.find((p) => p.id === line.productId)?.name ??
                `Reserved cookie ${i + 1}`}{' '}
              × {line.quantity}
            </span>
            {summary && (
              <strong>
                {money(line.priceCents * line.quantity, summary.currency)}
              </strong>
            )}
          </li>
        ))}
      </ul>
      {summary && (
        <dl className="checkout-totals">
          {(
            [
              ['Subtotal', summary.subtotal],
              ['Tax', summary.tax],
              ['Fees', summary.fees],
              ['Total', summary.total],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{money(value, summary.currency)}</dd>
            </div>
          ))}
        </dl>
      )}
      {chosen && (
        <p>
          Pickup: {chosen.date}, {chosen.startTime}–{chosen.endTime} (
          {chosen.timezone})<br />
          {drop?.pickupLocation}
        </p>
      )}
      {chosen && <p className="instructions">{drop?.pickupInstructions}</p>}
    </section>
  );
}
const promises = new Map<string, Promise<Stripe | null>>();
function stripePromise(key: string) {
  if (!promises.has(key))
    promises.set(
      key,
      loadStripe(key).catch(() => null),
    );
  return promises.get(key)!;
}
export function Checkout({
  publishableKey,
}: {
  publishableKey: string | null;
}) {
  const [snapshot, setSnapshot] = useState<CheckoutSnapshot | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [refreshing, setRefreshing] = useState(true),
    [error, setError] = useState(''),
    [seconds, setSeconds] = useState(0);
  const client = useRef<CheckoutClient | null>(null),
    flight = useRef<Promise<boolean> | null>(null),
    actionPending = useRef(false),
    current = useRef<CheckoutSnapshot | null>(null),
    sampled = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null),
    check = useRef<() => void>(() => undefined);
  function accept(value: CheckoutSnapshot) {
    current.current = value;
    sampled.current = performance.now();
    setSnapshot(value);
    tick();
  }
  function tick() {
    const value = current.current;
    const deadline =
      value?.payment?.paymentDeadline ?? value?.cart?.shoppingExpiresAt;
    setSeconds(
      deadline && value
        ? Math.max(
            0,
            Math.ceil(
              (Date.parse(deadline) -
                value.serverNow -
                (performance.now() - sampled.current)) /
                1000,
            ),
          )
        : 0,
    );
  }
  function run(work: () => Promise<CheckoutSnapshot>, focus = false) {
    if (flight.current) return flight.current;
    if (!focus) setRefreshing(true);
    setError('');
    const result = (async () => {
      try {
        accept(await work());
        return true;
      } catch (e) {
        setError(e instanceof CheckoutFailure ? e.message : recoveryMessage);
        // Disable stale payable state whenever the current result is unknown.
        if (current.current) accept({ ...current.current, available: false });
        try {
          if (client.current) accept(await client.current.restore());
        } catch {
          /* explicit status check remains */
        }
        return false;
      } finally {
        flight.current = null;
        if (!focus) setRefreshing(false);
        if (focus) heading.current?.focus();
      }
    })();
    flight.current = result;
    return result;
  }
  async function interact(work: () => Promise<CheckoutSnapshot>) {
    if (actionPending.current) return false;
    actionPending.current = true;
    setInteracting(true);
    try {
      // Finish the current read before acting. submit/authenticate still perform
      // their own authoritative rereads; a captured snapshot cannot admit payment.
      if (flight.current) await flight.current;
      return await run(work, true);
    } finally {
      actionPending.current = false;
      setInteracting(false);
    }
  }
  check.current = () => {
    if (client.current && !actionPending.current)
      void run(() => client.current!.restore());
  };
  useEffect(() => {
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      /* fail closed for payment */
    }
    client.current = new CheckoutClient(
      navigator.locks
        ? async (work) => await navigator.locks.request(LOCK, work)
        : null,
      store,
    );
    check.current();
    const resume = () => {
      if (document.visibilityState === 'visible') check.current();
    };
    const interval = setInterval(() => {
      tick();
    }, 1000);
    const poll = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        !current.current?.payment?.status.match(
          /^(paid|failed|expired|cancelled)$/,
        )
      )
        check.current();
    }, 5000);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(LOCK)
        : null;
    if (channel) channel.onmessage = resume;
    return () => {
      clearInterval(interval);
      clearInterval(poll);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', resume);
      channel?.close();
    };
  }, []);
  const p = snapshot?.payment;
  const canPay = !!publishableKey && !!snapshot?.available && seconds > 0;
  const status =
    interacting && !p
      ? 'Submitting your payment. Please wait.'
      : p
        ? paymentMessages[p.status]
        : snapshot
          ? snapshot.paymentSubmissionAllowed !== true && !p
            ? 'Payments are temporarily unavailable.'
            : canPay
              ? 'Review your information before paying.'
              : 'Checkout is currently unavailable. If you submitted a payment, check its status before trying anything else.'
          : error
            ? 'Checkout is currently unavailable.'
            : 'Checking your Cart…';
  return (
    <main className="checkout">
      <header>
        <h1>Batch &amp; Batter</h1>
        <p>Cookie Co.</p>
      </header>
      <h2 ref={heading} tabIndex={-1}>
        Checkout
      </h2>
      <p role="status">{status}</p>
      {error && (
        <p role="alert" className="checkout-error">
          {error}
        </p>
      )}
      {snapshot?.cart && !p && (
        <p aria-live="off">
          Shopping reservation:{' '}
          {seconds > 0
            ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`
            : 'Checking reservation status.'}
        </p>
      )}
      {p && !terminal(p) && (
        <>
          <p aria-live="off">
            Payment interaction window:{' '}
            {seconds > 0
              ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`
              : 'Window closed. Checking the final payment result.'}
          </p>
          <p>
            The payment deadline does not change when you refresh. A closed
            window does not mean processing has finished or cookies have been
            released.
          </p>
        </>
      )}
      {snapshot &&
      (canPay || p?.status === 'action_required') &&
      publishableKey &&
      (snapshot.summary || p?.status === 'action_required') ? (
        <Elements
          stripe={stripePromise(publishableKey)}
          options={
            snapshot.summary ? elementsOptions(snapshot.summary) : undefined
          }
          key={snapshot.cart?.cartId}
        >
          <PaymentForm
            snapshot={snapshot}
            refreshing={refreshing}
            submitting={interacting}
            canPay={canPay}
            canAct={seconds > 0}
            onSubmit={(contact, pickup, stripe, elements) =>
              interact(() =>
                client.current!.submit(
                  snapshot,
                  contact,
                  pickup,
                  stripe,
                  elements,
                ),
              )
            }
            onAction={(stripe) =>
              interact(() => client.current!.authenticate(stripe))
            }
          />
        </Elements>
      ) : (
        snapshot && !p && <CheckoutSummary snapshot={snapshot} pickup="" />
      )}
      {p?.status === 'paid' && (
        <p>
          Your payment is confirmed by our ordering system. Keep this browser
          available to check this payment’s status.
        </p>
      )}
      <div className="checkout-actions">
        <button
          type="button"
          disabled={interacting}
          aria-busy={refreshing}
          onClick={() => check.current()}
        >
          Check payment status
        </button>
        <a href="/">Return to the store</a>
      </div>
    </main>
  );
}
interface FormProps {
  snapshot: CheckoutSnapshot;
  refreshing: boolean;
  submitting?: boolean;
  canPay: boolean;
  canAct: boolean;
  onSubmit: (
    customer: Customer,
    pickup: string,
    stripe: Stripe,
    elements: NonNullable<ReturnType<typeof useElements>>,
  ) => Promise<boolean>;
  onAction: (stripe: Stripe) => Promise<boolean>;
}
export function PaymentForm({
  snapshot,
  refreshing,
  canPay,
  submitting = false,
  canAct,
  onSubmit,
  onAction,
}: FormProps) {
  const stripe = useStripe(),
    elements = useElements(),
    form = useRef<HTMLFormElement>(null);
  const [contact, setContact] = useState<Customer>({
    name: '',
    email: '',
    phone: '',
    smsTransactionalConsent: false,
  });
  const [pickup, setPickup] = useState(''),
    [ready, setReady] = useState(false),
    [loadError, setLoadError] = useState(false),
    [phoneError, setPhoneError] = useState('');
  useEffect(() => {
    if (stripe) {
      setLoadError(false);
      return;
    }
    const timeout = setTimeout(() => setLoadError(true), 10000);
    return () => clearTimeout(timeout);
  }, [stripe]);
  const updatePhone = (input: HTMLInputElement, value: string) => {
    try {
      const national = phoneEntry(value);
      input.value = national;
      setContact({ ...contact, phone: national });
      let message = '';
      try {
        normalizeUSPhone(national);
      } catch (error) {
        message = (error as Error).message;
      }
      input.setCustomValidity(message);
      setPhoneError(message);
    } catch (error) {
      // Rejected edits/pastes never become accepted phone content.
      input.value = contact.phone;
      const message = (error as Error).message;
      input.setCustomValidity(message);
      setPhoneError(message);
    }
  };
  const submissionAllowed = snapshot.paymentSubmissionAllowed === true;
  const sending = useRef(false);
  const valid = () => !!form.current?.reportValidity();
  const send = async () => {
    if (
      !submissionAllowed ||
      sending.current ||
      submitting ||
      !canPay ||
      !stripe ||
      !elements ||
      !ready ||
      loadError ||
      !valid()
    )
      return false;
    sending.current = true;
    try {
      return await onSubmit(contact, pickup, stripe, elements);
    } finally {
      sending.current = false;
    }
  };
  if (snapshot.payment)
    return (
      <>
        {loadError && (
          <p role="alert">
            Bank authentication could not load. Check your connection and
            refresh to recover this payment.
          </p>
        )}
        <button
          disabled={submitting || !stripe || !canAct}
          onClick={() => {
            if (stripe) void onAction(stripe);
          }}
        >
          Continue bank authentication
        </button>
      </>
    );
  return (
    <div className="checkout-grid">
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        aria-label="Customer checkout"
      >
        {/* Background status reads must not remove keyboard focus from fields. */}
        <fieldset disabled={submitting}>
          <legend>Contact and pickup</legend>
          <label htmlFor="checkout-name">Name</label>
          <input
            id="checkout-name"
            autoComplete="name"
            required
            maxLength={200}
            value={contact.name}
            onChange={(e) => setContact({ ...contact, name: e.target.value })}
            pattern=".*\S.*"
          />
          <label htmlFor="checkout-email">Email</label>
          <input
            id="checkout-email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={contact.email}
            onChange={(e) => {
              e.target.setCustomValidity(
                EMAIL.test(e.target.value)
                  ? ''
                  : 'Enter a valid email address.',
              );
              setContact({ ...contact, email: e.target.value });
            }}
          />
          <label htmlFor="checkout-phone">
            Mobile phone — United States (+1)
          </label>
          <div className="checkout-phone-entry">
            <span aria-hidden="true">+1</span>
            <input
              id="checkout-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              required
              pattern="[2-9][0-9]{2}[2-9][0-9]{6}"
              aria-describedby="phone-help"
              aria-invalid={phoneError ? true : undefined}
              value={contact.phone}
              onChange={(e) =>
                updatePhone(e.currentTarget, e.currentTarget.value)
              }
              onPaste={(e) => {
                e.preventDefault();
                const input = e.currentTarget;
                const pasted = e.clipboardData.getData('text');
                const value = /^\d+$/.test(pasted)
                  ? input.value.slice(0, input.selectionStart ?? 0) +
                    pasted +
                    input.value.slice(input.selectionEnd ?? input.value.length)
                  : pasted;
                updatePhone(input, value);
              }}
            />
          </div>
          <p id="phone-help" aria-live="polite">
            {phoneError || PHONE_HELP}
          </p>
          <label htmlFor="checkout-pickup">Pickup date</label>
          <select
            id="checkout-pickup"
            required
            value={pickup}
            onChange={(e) => setPickup(e.target.value)}
          >
            <option value="">Choose a pickup date</option>
            {snapshot.drop?.pickupDates
              .filter((p) => pickupAllowed(p, snapshot.serverNow))
              .map((p) => (
                <option key={p.date} value={p.date}>
                  {p.date}
                </option>
              ))}
          </select>
          {snapshot.drop?.pickupDates
            .filter((p) => p.date === pickup)
            .map((p) => (
              <p key={p.date}>
                {p.startTime}–{p.endTime} ({p.timezone})<br />
                {snapshot.drop?.pickupLocation}
              </p>
            ))}
          <label className="checkout-consent">
            <input
              type="checkbox"
              checked={contact.smsTransactionalConsent}
              onChange={(e) =>
                setContact({
                  ...contact,
                  smsTransactionalConsent: e.target.checked,
                })
              }
            />
            I agree to receive transactional text messages about this order.
            Optional.
          </label>
        </fieldset>
        <h3>Payment</h3>
        {loadError && (
          <p role="alert">
            The secure payment form could not load. Payment is unavailable;
            check your connection and refresh.
          </p>
        )}
        <div className="checkout-elements" aria-busy={refreshing || submitting}>
          {submissionAllowed && (
            <ExpressCheckoutElement
              options={expressOptions}
              onClick={(e) => {
                if (
                  !submitting &&
                  canPay &&
                  stripe &&
                  elements &&
                  ready &&
                  !loadError &&
                  valid()
                )
                  e.resolve();
              }}
              onConfirm={async (e) => {
                if (!(await send())) e.paymentFailed({ reason: 'fail' });
              }}
              onLoadError={() => setLoadError(true)}
            />
          )}
          <PaymentElement
            options={{
              layout: 'tabs',
              wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
            }}
            onReady={() => setReady(true)}
            onLoadError={() => setLoadError(true)}
          />
        </div>
        <button
          className="checkout-pay"
          disabled={
            !submissionAllowed ||
            submitting ||
            !stripe ||
            !elements ||
            !ready ||
            loadError ||
            !canPay
          }
          aria-describedby={
            !submissionAllowed ? 'checkout-payment-unavailable' : undefined
          }
          type="submit"
        >
          {!submissionAllowed
            ? `Pay ${money(snapshot.summary!.total, snapshot.summary!.currency)}`
            : submitting
              ? 'Checking payment…'
              : `Pay ${money(snapshot.summary!.total, snapshot.summary!.currency)}`}
        </button>
        {!submissionAllowed && (
          <p id="checkout-payment-unavailable">
            Payments are temporarily unavailable.
          </p>
        )}
        <p>Payment details are entered securely with Stripe.</p>
      </form>
      <CheckoutSummary snapshot={snapshot} pickup={pickup} />
    </div>
  );
}
