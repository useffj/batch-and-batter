'use client';
import { GuestAccess } from './guest-access';
import { NotificationStatus } from './notification-status';
import { useEffect, useState } from 'react';
import { AdminNavigation } from './navigation';
import './weekly-drops.css';
import './orders.css';
export const statuses = [
  'PAYMENT_PENDING',
  'PAID',
  'EXPIRED',
  'FAILED',
  'CANCELLED',
];
export const human = (s: string) =>
  s
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (x) => x.toUpperCase());
export function money(n: number, currency: string) {
  if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid stored amount');
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .formatToParts(BigInt(Math.floor(n / 100)))
    .map((p) =>
      p.type === 'fraction' ? String(n % 100).padStart(2, '0') : p.value,
    )
    .join('');
}
export const timestamp = (s: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(s));
type Drop = { dropId: string; name: string; opensAt: string; status: string };
export type Order = {
  orderId: string;
  displayOrderNumber: string | null;
  status: string;
  paymentStatus: string;
  customerName: string;
  totalCents: number;
  currency: string;
  pickupDate: string;
  createdAt: string;
  updatedAt: string;
  fulfillmentStatus: string | null;
  customer?: { name: string; email: string; phone: string };
  items?: {
    name: string;
    quantity: number;
    unitPriceCents: number;
    cookieUnits: number;
  }[];
  subtotalCents?: number;
  taxCents?: number;
  feeCents?: number;
  pickup?: {
    date: string;
    startTime: string;
    endTime: string;
    timezone: string;
    location: string;
    instructions: string;
  };
};
async function request(path: string) {
  const r = await fetch('/api/admin/' + path, { cache: 'no-store' });
  if (r.status === 401 || r.status === 403) {
    window.location.replace('/admin/login?reason=expired');
    throw Error('Sign in again.');
  }
  const data = await r.json();
  if (!r.ok)
    throw Error(
      r.status === 404
        ? 'Order not found.'
        : 'Unable to load orders. Refresh to try again.',
    );
  return data;
}
export function OrderDetails({ order: o }: { order: Order }) {
  return (
    <section aria-label="Order details">
      <h2>{o.displayOrderNumber ?? 'Reference not recorded'}</h2>
      <p>
        {human(o.status)} · Payment: {human(o.paymentStatus)}
      </p>
      <p>
        Fulfillment:{' '}
        {o.fulfillmentStatus ? human(o.fulfillmentStatus) : 'Not recorded'}
      </p>
      <h3>Customer</h3>
      <p>
        {o.customer?.name}
        <br />
        {o.customer?.email}
        <br />
        {o.customer?.phone}
      </p>
      <h3>Cookies · historical prices</h3>
      {o.items?.map((i, n) => (
        <p key={n}>
          {i.name} · {i.quantity} × {money(i.unitPriceCents, o.currency)}
        </p>
      ))}
      <dl>
        <dt>Subtotal</dt>
        <dd>{money(o.subtotalCents!, o.currency)}</dd>
        <dt>Tax</dt>
        <dd>{money(o.taxCents!, o.currency)}</dd>
        <dt>Fees</dt>
        <dd>{money(o.feeCents!, o.currency)}</dd>
        <dt>Total</dt>
        <dd>{money(o.totalCents, o.currency)}</dd>
      </dl>
      <h3>Pickup</h3>
      <p>
        {o.pickup?.date} · {o.pickup?.startTime}–{o.pickup?.endTime} (
        {o.pickup?.timezone})
      </p>
      <p>{o.pickup?.location}</p>
      <p>{o.pickup?.instructions || 'No pickup instructions recorded.'}</p>
      <p>
        Created {timestamp(o.createdAt)} Denver
        <br />
        Updated {timestamp(o.updatedAt)} Denver
      </p>
      <NotificationStatus key={o.orderId} orderId={o.orderId} />
      <GuestAccess key={'access-' + o.orderId} orderId={o.orderId} />
    </section>
  );
}
export function Orders({ expiresAt }: { expiresAt: number }) {
  const [drops, setDrops] = useState<Drop[]>([]),
    [dropCursor, setDropCursor] = useState<string | null>(null),
    [dropId, setDropId] = useState(''),
    [pickup, setPickup] = useState(''),
    [status, setStatus] = useState(''),
    [reference, setReference] = useState(''),
    [rows, setRows] = useState<Order[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [detail, setDetail] = useState<Order | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [scope, setScope] = useState('Select a Drop');
  useEffect(() => {
    const expire = () => {
      if (Date.now() >= expiresAt)
        window.location.replace('/admin/login?reason=expired');
    };
    const timer = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    window.addEventListener('focus', expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', expire);
    };
  }, [expiresAt]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [d, dashboard] = await Promise.all([
          request('drops'),
          request('dashboard'),
        ]);
        if (!active) return;
        const assigned = dashboard.overview?.drop;
        const choices =
          assigned && !d.drops.some((x: Drop) => x.dropId === assigned.dropId)
            ? [assigned, ...d.drops]
            : d.drops;
        setDrops(choices);
        setDropCursor(d.nextCursor);
        const latest =
          assigned ??
          [...d.drops].sort((a: Drop, b: Drop) =>
            b.opensAt.localeCompare(a.opensAt),
          )[0];
        if (latest) {
          setDropId(latest.dropId);
          const q = new URLSearchParams({ dropId: latest.dropId }).toString();
          const result = await request('orders?' + q);
          if (!active) return;
          setQuery(q);
          setScope(latest.name);
          setRows(result.orders);
          setCursor(result.nextCursor);
        }
      } catch {
        if (active) setError('Unable to load orders. Refresh to try again.');
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load orders.');
    } finally {
      setBusy(false);
    }
  }
  async function search() {
    const p = new URLSearchParams();
    if (reference.trim()) {
      p.set('reference', reference.trim().toUpperCase());
    } else {
      if (!dropId) throw Error('Select a Drop.');
      p.set('dropId', dropId);
      if (pickup) p.set('pickupDate', pickup);
      if (status) p.set('status', status);
    }
    const q = p.toString();
    const r = await request('orders?' + q);
    setQuery(q);
    setScope(
      reference.trim()
        ? 'Exact reference search'
        : (drops.find((d) => d.dropId === dropId)?.name ?? 'Selected Drop'),
    );
    setRows(r.orders);
    setCursor(r.nextCursor);
    setDetail(null);
  }
  return (
    <div className="admin-shell">
      <AdminNavigation current="orders" />
      <main className="admin-main weekly-drops admin-orders">
        <h1>Orders</h1>
        <p>
          Read-only order records. Dates and timestamps use Denver time. Manage
          pickups in Fulfillment.
        </p>
        <p role="status">{busy ? 'Loading…' : error}</p>
        {detail ? (
          <>
            <button onClick={() => setDetail(null)}>Back to orders</button>
            <OrderDetails order={detail} />
          </>
        ) : (
          <>
            <section aria-label="Order filters">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(search);
                }}
              >
                <fieldset disabled={busy}>
                  <label>
                    Drop
                    <select
                      aria-label="Drop"
                      value={dropId}
                      onChange={(e) => setDropId(e.target.value)}
                    >
                      <option value="">Select a Drop</option>
                      {drops.map((d) => (
                        <option key={d.dropId} value={d.dropId}>
                          {d.name} · {d.status}
                        </option>
                      ))}
                    </select>
                  </label>
                  {dropCursor && (
                    <button
                      type="button"
                      onClick={() =>
                        void action(async () => {
                          const d = await request('drops?cursor=' + dropCursor);
                          setDrops((old) => [...old, ...d.drops]);
                          setDropCursor(d.nextCursor);
                        })
                      }
                    >
                      Load more Drops
                    </button>
                  )}
                  <label>
                    Pickup date
                    <input
                      type="date"
                      value={pickup}
                      onChange={(e) => setPickup(e.target.value)}
                    />
                  </label>
                  <label>
                    Order status
                    <select
                      aria-label="Order status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="">All recorded statuses</option>
                      {statuses.map((s) => (
                        <option key={s} value={s}>
                          {human(s)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Order reference
                    <input
                      placeholder="BB-XXXXXXXXXXXX"
                      value={reference}
                      maxLength={15}
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </label>
                  <p>
                    Exact reference search overrides the Drop, date and status
                    filters.
                  </p>
                  <button type="submit">Apply filters / search</button>
                </fieldset>
              </form>
            </section>
            <section aria-label="Order results">
              <h2>{scope}</h2>
              <p>
                Newest first within the selected Drop. The initial selection
                uses the storefront Drop, or the latest opening in the loaded
                Drop page; load more Drops when needed. Index visibility can
                lag; historical orders require backfill.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (!query) {
                      const d = await request('drops');
                      setDrops(d.drops);
                      setDropCursor(d.nextCursor);
                      if (dropId) await search();
                      else setError('Choose a Drop, then apply filters.');
                      return;
                    }
                    const r = await request('orders?' + query);
                    setRows(r.orders);
                    setCursor(r.nextCursor);
                  })
                }
              >
                Refresh
              </button>
              {!busy && !rows.length && (
                <p>
                  No matching orders on this page.
                  {cursor
                    ? ' More records can be checked on the next page.'
                    : ''}
                </p>
              )}
              <div className="order-cards">
                {rows.map((o) => (
                  <article key={o.orderId}>
                    <h3>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            setDetail(
                              (await request('orders/' + o.orderId)).order,
                            );
                          })
                        }
                      >
                        {o.displayOrderNumber ?? 'Reference not recorded'}
                      </button>
                    </h3>
                    <p>
                      {o.customerName} · {money(o.totalCents, o.currency)}
                    </p>
                    <p>
                      {human(o.status)} · Payment: {human(o.paymentStatus)}
                    </p>
                    <p>
                      Pickup {o.pickupDate} · Fulfillment:{' '}
                      {o.fulfillmentStatus
                        ? human(o.fulfillmentStatus)
                        : 'Not recorded'}
                    </p>
                    <p>Created {timestamp(o.createdAt)} Denver</p>
                  </article>
                ))}
              </div>
              {cursor && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const r = await request(
                        'orders?' + query + '&cursor=' + cursor,
                      );
                      setRows(r.orders);
                      setCursor(r.nextCursor);
                    })
                  }
                >
                  Next page
                </button>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
