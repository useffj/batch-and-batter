'use client';
import { refundLabels } from '../../lib/refunds';
import { CancellationRequest } from './cancellation-request';
import { type CancellationView } from '../../lib/order-requests';
import { useEffect, useRef, useState } from 'react';
import './manage-order.css';
export type GuestView = {
  refund?: {
    status: string | null;
    refundedCents: number;
    currency: string;
  } | null;
  cancellation?: CancellationView;
  order: {
    reference: string | null;
    items: { name: string; quantity: number; unitPriceCents: number }[];
    subtotalCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
    currency: string;
    paymentStatus: string;
    status: string;
    pickup: {
      date: string;
      startTime: string;
      endTime: string;
      location: string;
      instructions: string;
    };
    fulfillmentStatus: string | null;
  };
  revision: number;
  cutoff: string;
  changeUnavailable: string | null;
  dates: { date: string; startTime: string; endTime: string }[];
  datesTruncated: boolean;
};
export const guestDate = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(date + 'T12:00:00Z'));
export const guestTime = (time: string) =>
  new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date('2000-01-01T' + time + ':00Z'));
const human = (s: string) => s.toLowerCase().replaceAll('_', ' ');
export function GuestOrderDetails({ data }: { data: GuestView }) {
  const o = data.order,
    money = (n: number) =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: o.currency,
      }).format(n / 100);
  return (
    <>
      {data.refund && (
        <section aria-label="Refund status">
          <h2>
            {refundLabels[data.refund.status ?? ''] ??
              'Refund status requires review'}
          </h2>
          <p>
            Confirmed refunds: {money(data.refund.refundedCents)}. Your bank may
            need additional time to post a completed refund.
          </p>
        </section>
      )}
      <h2>{o.reference ?? 'Your order'}</h2>
      <p className="guest-status">
        Payment: {human(o.paymentStatus)} · Order: {human(o.status)}
      </p>
      <p>
        Fulfillment:{' '}
        {o.fulfillmentStatus ? human(o.fulfillmentStatus) : 'Not recorded'}
      </p>
      <h3>Your cookies</h3>
      <ul className="guest-items">
        {o.items.map((i, n) => (
          <li key={n}>
            <span>
              {i.quantity} × {i.name}
            </span>
            <span>{money(i.unitPriceCents)} each</span>
          </li>
        ))}
      </ul>
      <dl className="guest-totals">
        {(
          [
            ['Subtotal', o.subtotalCents],
            ['Tax', o.taxCents],
            ['Fees', o.feeCents],
            ['Total', o.totalCents],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{money(value)}</dd>
          </div>
        ))}
      </dl>
      <section aria-label="Pickup details">
        <h3>Pickup details</h3>
        <p>
          <strong>{guestDate(o.pickup.date)}</strong>
          <br />
          {guestTime(o.pickup.startTime)}–{guestTime(o.pickup.endTime)} Mountain
          Time
        </p>
        <p>{o.pickup.location}</p>
        <p>
          {o.pickup.instructions ||
            'No additional pickup instructions recorded.'}
        </p>
      </section>
    </>
  );
}
export function ManageOrder() {
  const token = useRef(''),
    initialized = useRef(false),
    pending = useRef<{
      requestId: string;
      date: string;
      revision: number;
    } | null>(null);
  const [ready, setReady] = useState(false),
    [data, setData] = useState<GuestView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [date, setDate] = useState(''),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const raw = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/order/manage');
    if (/^[A-Za-z0-9_-]{43}$/.test(raw)) {
      token.current = raw;
      setReady(true);
    } else
      setError(
        'Open the complete private link from your order email. An order number alone cannot provide access.',
      );
    return () => {};
  }, []);
  async function request(action: string, body: object) {
    const r = await fetch('/api/order/manage/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.current, ...body }),
      cache: 'no-store',
      redirect: 'error',
    });
    const result = await r.json();
    if (!r.ok) {
      if (r.status === 403) setData(null);
      if ([400, 403, 404, 409].includes(r.status)) {
        pending.current = null;
        setUncertain(false);
      }
      throw Object.assign(
        Error(result.message ?? 'Unable to load your order.'),
        { status: r.status },
      );
    }
    return result;
  }
  async function view() {
    setBusy(true);
    setError('');
    try {
      setData(await request('view', {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load your order.');
    } finally {
      setBusy(false);
    }
  }
  async function change() {
    if (!data) return;
    setBusy(true);
    setError('');
    setNotice('');
    pending.current ??= {
      requestId: crypto.randomUUID(),
      date,
      revision: data.revision,
    };
    setUncertain(true);
    try {
      await request('pickup', pending.current);
      pending.current = null;
      setUncertain(false);
      setDate('');
      setNotice('Your pickup date has been updated.');
      setData(await request('view', {}));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The result is unknown. Retry the same request to check safely.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="guest-manage">
      {/* Full navigation intentionally discards the in-memory guest capability. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="guest-brand" href="/">
        Batch &amp; Batter<span>COOKIE CO.</span>
      </a>
      <header>
        <p className="guest-eyebrow">A little something to look forward to</p>
        <h1>Your order</h1>
        <p>View your cookies and pickup details, all in one place.</p>
      </header>
      {error && (
        <p role="alert" className="guest-alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {ready && (
        <button type="button" disabled={busy} onClick={view}>
          {busy ? 'Please wait…' : data ? 'Refresh order' : 'View order'}
        </button>
      )}
      {data && (
        <article>
          <GuestOrderDetails data={data} />
          {data.cancellation && (
            <CancellationRequest
              data={data.cancellation}
              send={request}
              refresh={view}
            />
          )}
          <section aria-label="Change pickup date">
            <h3>Change pickup date</h3>
            <p>
              Changes close at {guestTime(data.cutoff.slice(11))} Mountain Time
              on {guestDate(data.cutoff.slice(0, 10))}, the day before your
              currently scheduled pickup.
            </p>
            {data.changeUnavailable && !uncertain ? (
              <p>{data.changeUnavailable}</p>
            ) : (
              <>
                <label htmlFor="guest-pickup">Available pickup date</label>
                <select
                  id="guest-pickup"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  disabled={busy || uncertain}
                >
                  <option value="">Choose a date</option>
                  {data.dates.map((p) => (
                    <option key={p.date} value={p.date}>
                      {guestDate(p.date)} · {guestTime(p.startTime)}–
                      {guestTime(p.endTime)}
                    </option>
                  ))}
                </select>
                {!data.dates.length && (
                  <p>No other active pickup dates are available.</p>
                )}
                {data.datesTruncated && (
                  <p>For additional dates, contact the bakery.</p>
                )}
                <button
                  type="button"
                  disabled={busy || (!date && !uncertain)}
                  onClick={change}
                >
                  {uncertain
                    ? 'Retry the same change'
                    : 'Confirm pickup change'}
                </button>
              </>
            )}
          </section>
        </article>
      )}
      <footer>
        <h2>Need a hand?</h2>
        <p>
          Contact Batch &amp; Batter using the contact information in your
          purchase email for pickup help or questions about cancellation, refund
          and missed-pickup policies. Refund execution is not available on this
          page.
        </p>
        <p>
          This private link grants access to your order. Do not share it. After
          a full reload, reopen the link from your email.
        </p>
      </footer>
    </main>
  );
}
