'use client';
import { useEffect, useState } from 'react';
import { AdminNavigation } from './navigation';
import { OrderDetails, human, timestamp, type Order } from './orders';
import './weekly-drops.css';
import './orders.css';
export const denverToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
type Event = {
  requestId: string;
  status: string;
  at: string;
  administrator: string;
  reason: string;
};
export type PickupOrder = Order & {
  pickupEnded: boolean;
  fulfillment: { revision: number; status: string | null; history: Event[] };
};
async function request(path: string, input?: unknown) {
  const r = await fetch('/api/admin/' + path, {
    method: input ? 'POST' : 'GET',
    cache: 'no-store',
    headers: input ? { 'Content-Type': 'application/json' } : undefined,
    body: input ? JSON.stringify(input) : undefined,
  });
  if (r.status === 401 || r.status === 403) {
    window.location.replace('/admin/login?reason=expired');
    throw Error('Sign in again.');
  }
  const data = await r.json();
  if (!r.ok)
    throw Error(
      data.message ??
        'Unable to confirm fulfillment. Refresh before another action.',
    );
  return data;
}
export function Fulfillment({ expiresAt }: { expiresAt: number }) {
  const [date, setDate] = useState(denverToday),
    [loadedDate, setLoadedDate] = useState(''),
    [rows, setRows] = useState<PickupOrder[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [detail, setDetail] = useState<PickupOrder | null>(null),
    [pending, setPending] = useState<{
      order: PickupOrder;
      status: string;
      requestId: string;
      reason: string;
    } | null>(null),
    [uncertain, setUncertain] = useState(false);
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
  async function load(day: string, after?: string) {
    const result = await request(
      'fulfillment?' +
        new URLSearchParams({
          pickupDate: day,
          ...(after ? { cursor: after } : {}),
        }),
    );
    setRows(result.orders);
    setCursor(result.nextCursor);
    setLoadedDate(day);
    setDetail(null);
  }
  useEffect(() => {
    let active = true;
    void request('fulfillment?pickupDate=' + denverToday())
      .then((r) => {
        if (active) {
          setRows(r.orders);
          setCursor(r.nextCursor);
          setLoadedDate(denverToday());
        }
      })
      .catch(() => {
        if (active) setError('Unable to load pickups. Refresh to try again.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
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
      setError(e instanceof Error ? e.message : 'Unable to confirm action.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!pending) return;
    const p = pending;
    try {
      await request('orders/' + p.order.orderId + '/fulfillment', {
        requestId: p.requestId,
        revision: p.order.fulfillment.revision,
        status: p.status,
        reason: p.reason,
      });
      setPending(null);
      setUncertain(false);
      await load(loadedDate);
    } catch (e) {
      setUncertain(true);
      throw e;
    }
  }
  return (
    <div className="admin-shell">
      <AdminNavigation current="fulfillment" />
      <main className="admin-main weekly-drops admin-orders">
        <h1>Fulfillment</h1>
        <p>
          Prepare cookies, record pickups and resolve missed collections. Denver
          business time.
        </p>
        <p role="status" aria-live="polite">
          {busy ? 'Loading…' : error}
        </p>
        {pending ? (
          <section aria-label="Confirm fulfillment">
            <h2>{human(pending.status)}?</h2>
            <p>
              {pending.order.displayOrderNumber ?? 'Reference not recorded'} ·{' '}
              {pending.order.customerName}
            </p>
            <p>
              This records an operational event only. No refund, restock or
              customer notification is sent.
            </p>
            {pending.status === 'PICKED_UP' &&
              pending.order.fulfillment.status === 'MISSED_PICKUP' && (
                <label>
                  Late collection reason
                  <textarea
                    maxLength={500}
                    required
                    disabled={busy || uncertain}
                    value={pending.reason}
                    onChange={(e) =>
                      setPending({ ...pending, reason: e.target.value })
                    }
                  />
                </label>
              )}
            {uncertain && (
              <p>
                The result could not be confirmed. Retry the same request
                safely, or refresh the persisted queue before choosing another
                action.
              </p>
            )}
            <button
              disabled={
                busy ||
                (pending.status === 'PICKED_UP' &&
                  pending.order.fulfillment.status === 'MISSED_PICKUP' &&
                  !pending.reason.trim())
              }
              onClick={() => void action(save)}
            >
              {uncertain ? 'Retry same request' : 'Confirm'}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await load(loadedDate);
                  setPending(null);
                  setUncertain(false);
                })
              }
            >
              {uncertain ? 'Refresh persisted queue' : 'Cancel'}
            </button>
          </section>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(() => load(date));
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  Pickup date
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <button type="submit">View pickups</button>
                <button
                  type="button"
                  onClick={() => {
                    const today = denverToday();
                    setDate(today);
                    void action(() => load(today));
                  }}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => void action(() => load(loadedDate || date))}
                >
                  Refresh
                </button>
              </fieldset>
            </form>
            {detail ? (
              <>
                <button onClick={() => setDetail(null)}>
                  Back to pickup queue
                </button>
                <OrderDetails order={detail} />
                <h3>Fulfillment history</h3>
                {detail.fulfillment.history.length ? (
                  detail.fulfillment.history.map((e) => (
                    <p key={e.requestId}>
                      {human(e.status)} · {timestamp(e.at)} Denver
                      <br />
                      Administrator: {e.administrator}
                      {e.reason && (
                        <>
                          <br />
                          Reason: {e.reason}
                        </>
                      )}
                    </p>
                  ))
                ) : (
                  <p>No fulfillment events recorded.</p>
                )}
              </>
            ) : (
              <section aria-label="Pickup queue">
                <h2>{loadedDate || 'Today'} pickups</h2>
                <p>
                  Paid and captured orders only. Counts cover this retrieved
                  page, not the whole day. Index visibility may lag; historical
                  orders require backfill.
                </p>
                <p>
                  {rows.filter((o) => !o.fulfillment.status).length} awaiting
                  preparation ·{' '}
                  {
                    rows.filter(
                      (o) => o.fulfillment.status === 'READY_FOR_PICKUP',
                    ).length
                  }{' '}
                  ready ·{' '}
                  {
                    rows.filter((o) => o.fulfillment.status === 'PICKED_UP')
                      .length
                  }{' '}
                  collected ·{' '}
                  {
                    rows.filter((o) => o.fulfillment.status === 'MISSED_PICKUP')
                      .length
                  }{' '}
                  missed
                </p>
                {!busy && !rows.length && (
                  <p>
                    No eligible orders on this page.
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
                              const d = await request('orders/' + o.orderId);
                              setDetail({ ...o, ...d.order });
                            })
                          }
                        >
                          {o.displayOrderNumber ?? 'Reference not recorded'}
                        </button>
                      </h3>
                      <p>
                        {o.customerName} · Payment: {human(o.paymentStatus)}
                      </p>
                      <ul>
                        {o.refundProcessing && (
                          <li>
                            Refund processing or reconciliation: fulfillment is
                            blocked.
                          </li>
                        )}
                        {o.refundInventory?.map((i, n) => (
                          <li key={'refund-' + n}>
                            {i.name}: {i.remaining} remaining to fulfill,{' '}
                            {i.returned} returned to stock.
                          </li>
                        ))}
                        {o.items?.map((i, n) => (
                          <li key={n}>
                            {i.quantity} × {i.name}
                          </li>
                        ))}
                      </ul>
                      <p>
                        Pickup {o.pickup?.startTime}–{o.pickup?.endTime} Denver
                      </p>
                      <p>
                        Fulfillment:{' '}
                        {o.fulfillment.status
                          ? human(o.fulfillment.status)
                          : 'Not recorded'}
                      </p>
                      {o.fulfillment.history.at(-1) && (
                        <p>
                          {timestamp(o.fulfillment.history.at(-1)!.at)} Denver
                        </p>
                      )}
                      <div className="fulfillment-actions">
                        {(!o.fulfillment.status
                          ? [
                              'READY_FOR_PICKUP',
                              ...(o.pickupEnded ? ['MISSED_PICKUP'] : []),
                            ]
                          : o.fulfillment.status === 'READY_FOR_PICKUP'
                            ? [
                                'PICKED_UP',
                                ...(o.pickupEnded ? ['MISSED_PICKUP'] : []),
                              ]
                            : o.fulfillment.status === 'MISSED_PICKUP'
                              ? ['PICKED_UP']
                              : []
                        ).map((status) => (
                          <button
                            key={status}
                            disabled={busy}
                            onClick={() => {
                              setError('');
                              setUncertain(false);
                              setPending({
                                order: o,
                                status,
                                requestId: crypto.randomUUID(),
                                reason: '',
                              });
                            }}
                          >
                            {status === 'READY_FOR_PICKUP'
                              ? 'Mark ready'
                              : status === 'MISSED_PICKUP'
                                ? 'Mark missed'
                                : o.fulfillment.status === 'MISSED_PICKUP'
                                  ? 'Record late collection'
                                  : 'Mark collected'}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
                {cursor && (
                  <button
                    disabled={busy}
                    onClick={() => void action(() => load(loadedDate, cursor))}
                  >
                    Next page
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
