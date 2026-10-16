'use client';
import { useRef, useState } from 'react';
import './refunds.css';
import { refundCents, refundLabels } from '../../lib/refunds';
type View = {
  audit: { operationId: string; status: string; at: string }[];
  auditTruncated: boolean;
  capturedCents: number;
  refundedCents: number;
  reservedCents: number;
  remainingCents: number;
  currency: string;
  historyTruncated: boolean;
  items: {
    productId: string;
    name: string;
    quantity: number;
    returned: number;
  }[];
  operations: {
    operationId: string;
    status: string;
    amountCents: number;
    reason: string;
    administrator: string;
    disposition: string;
    updatedAt: string;
  }[];
};
export function RefundReview({ orderId }: { orderId: string }) {
  const [data, setData] = useState<View | null>(null),
    [amount, setAmount] = useState(''),
    [reason, setReason] = useState(''),
    [restock, setRestock] = useState(false),
    [available, setAvailable] = useState(false),
    [items, setItems] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<object | null>(null);
  const money = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: data?.currency ?? 'USD',
    }).format(n / 100);
  async function call(action = '', body?: object) {
    const r = await fetch(
      '/api/admin/orders/' +
        orderId +
        '/refunds' +
        (action ? '/' + action : ''),
      {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      },
    );
    if (r.status === 401 || r.status === 403)
      window.location.replace('/admin/login?reason=expired');
    if (!r.ok)
      throw Error(
        r.status === 503
          ? 'Refund execution is unavailable or not activated. No completion is confirmed.'
          : 'Refund action needs review. Refresh status before another decision.',
      );
    return r.json();
  }
  async function load() {
    setData(await call());
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Refund status unavailable.');
    } finally {
      setBusy(false);
    }
  }
  async function authorize() {
    const cents = refundCents(amount);
    if (!pending.current) {
      if (
        !data ||
        !cents ||
        cents > data.remainingCents ||
        !reason.trim() ||
        !confirmed ||
        (restock && !available)
      )
        throw Error('Confirm the exact amount, reason and inventory decision.');
      const selected = Object.entries(items)
        .filter(([, q]) => q && q !== '0')
        .map(([productId, quantity]) => ({
          productId,
          quantity: Number(quantity),
        }));
      if (
        restock &&
        (!selected.length ||
          selected.some(
            (i) => !Number.isSafeInteger(i.quantity) || i.quantity <= 0,
          ))
      )
        throw Error('Enter explicit eligible restock quantities.');
      pending.current = {
        operationId: crypto.randomUUID(),
        amountCents: cents,
        reason: reason.trim(),
        disposition: restock ? 'RESTOCK' : 'DO_NOT_RESTOCK',
        physicallyAvailable: restock && available,
        items: restock ? selected : [],
      };
    }
    await call('authorize', pending.current);
    pending.current = null;
    setConfirmed(false);
    await load();
    setMessage(
      'Refund authorization recorded. This does not confirm that money was returned.',
    );
  }
  return (
    <section
      className="admin-card refund-review"
      aria-label="Refund management"
    >
      <h3>Refunds</h3>
      <p>
        A request or approval is separate from money returned. Timely
        cancellation retains its full-refund entitlement.
      </p>
      <button type="button" disabled={busy} onClick={() => run(load)}>
        Refresh refund status
      </button>
      <p role="status">{message}</p>
      {data && (
        <>
          <p>
            Captured {money(data.capturedCents)} · Completed{' '}
            {money(data.refundedCents)} · In progress{' '}
            {money(data.reservedCents)} · Available {money(data.remainingCents)}
          </p>
          <fieldset disabled={busy || !!pending.current}>
            <legend>Refund decision</legend>
            <button
              type="button"
              onClick={() => {
                setAmount((data.remainingCents / 100).toFixed(2));
                setConfirmed(false);
              }}
            >
              Use full remaining amount
            </button>
            <label>
              Refund amount
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            <label>
              Reason
              <textarea
                maxLength={500}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={restock}
                onChange={(e) => {
                  setRestock(e.target.checked);
                  setConfirmed(false);
                }}
              />
              Explicitly return eligible inventory
            </label>
            <p>
              Default: do not restock. A monetary refund never determines item
              quantities.
            </p>
            {restock && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={available}
                    onChange={(e) => {
                      setAvailable(e.target.checked);
                      setConfirmed(false);
                    }}
                  />
                  These cookies are physically available and have not been
                  collected.
                </label>
                {data.items.map((i) => (
                  <label key={i.productId}>
                    {i.name} — up to {i.quantity - i.returned} remaining
                    <input
                      type="number"
                      min={0}
                      max={i.quantity - i.returned}
                      step={1}
                      value={items[i.productId] ?? ''}
                      onChange={(e) => {
                        setItems({ ...items, [i.productId]: e.target.value });
                        setConfirmed(false);
                      }}
                    />
                  </label>
                ))}
              </>
            )}
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Confirm this amount, reason and inventory decision.
            </label>
          </fieldset>
          <button
            type="button"
            disabled={busy || (!confirmed && !pending.current)}
            onClick={() => run(authorize)}
          >
            {pending.current
              ? 'Retry the same authorization'
              : 'Authorize refund'}
          </button>
          <h4>Refund history</h4>
          {data.operations.map((o) => (
            <article key={o.operationId}>
              <p>
                {refundLabels[o.status]} · {money(o.amountCents)} ·{' '}
                {o.disposition === 'RESTOCK'
                  ? 'Explicit restock'
                  : 'Do not restock'}
              </p>
              <p>{o.reason}</p>
              <p>
                Authorized by {o.administrator} ·{' '}
                {new Date(o.updatedAt).toLocaleString('en-US', {
                  timeZone: 'America/Denver',
                })}{' '}
                Mountain Time
              </p>
              {!['SUCCEEDED', 'FAILED', 'CANCELED'].includes(o.status) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await call('reconcile', { operationId: o.operationId });
                      await load();
                    })
                  }
                >
                  Process or reconcile original refund
                </button>
              )}
            </article>
          ))}
          <details>
            <summary>Financial audit</summary>
            {data.audit.map((a, n) => (
              <p key={n}>
                {refundLabels[a.status]} ·{' '}
                {new Date(a.at).toLocaleString('en-US', {
                  timeZone: 'America/Denver',
                })}{' '}
                Mountain Time
              </p>
            ))}
            {data.auditTruncated && (
              <p>Audit history continues beyond this page.</p>
            )}
          </details>
          {data.historyTruncated && (
            <p>
              Showing a limited history. Further review is required for older
              operations.
            </p>
          )}
        </>
      )}
    </section>
  );
}
