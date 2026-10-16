'use client';
import { useEffect, useState } from 'react';
import { AdminNavigation } from './navigation';
import { money, timestamp } from './orders';
import './orders.css';
import './weekly-drops.css';
import './refunds.css';
export const financialStatuses = [
  'AUTHORIZED',
  'DISPATCHED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'RECONCILIATION_REQUIRED',
];
const statusLabel = (value: string) => value.toLowerCase().replaceAll('_', ' ');
type Summary = {
  orderId: string;
  reference: string | null;
  customerName: string;
  dropId: string;
  pickupDate: string;
  currency: string;
  originalTotalCents: number;
  capturedCents: number | null;
  refundedCents: number | null;
  reservedCents: number | null;
  availableCents: number | null;
  blocked: boolean;
  returned: Record<string, number>;
  updatedAt: string;
};
type Operation = {
  operationId: string;
  status: string;
  amountCents: number;
  updatedAt: string;
};
export type WorklistRow = Summary & {
  operation: Operation | null;
  attentionReason: string | null;
};
export type RefundDetail = {
  order: Summary;
  operation: Operation & {
    providerId: string | null;
    checks: number;
    createdAt: string;
    disposition: string;
    items: { productId: string; quantity: number }[];
  };
  audit: { status: string; at: string }[];
  nextCursor: string | null;
};
export function RefundTotals({ order: o }: { order: Summary }) {
  const amount = (n: number | null) =>
    n === null ? 'Not recorded' : money(n, o.currency);
  return (
    <>
      <dl>
        <dt>Original Order total</dt>
        <dd>{amount(o.originalTotalCents)}</dd>
        <dt>Captured payment amount</dt>
        <dd>{amount(o.capturedCents)}</dd>
        <dt>Confirmed refunded total</dt>
        <dd>{amount(o.refundedCents)}</dd>
        <dt>Reserved / in progress</dt>
        <dd>{amount(o.reservedCents)}</dd>
        <dt>Available to refund</dt>
        <dd>{amount(o.availableCents)}</dd>
      </dl>
      <p>
        Available to refund is remaining captured value, not money owed to the
        customer.
      </p>
    </>
  );
}
export function ReadOnlyRefundDetails({ data: d }: { data: RefundDetail }) {
  const o = d.operation;
  return (
    <section aria-label="Read-only refund details">
      <h2>{d.order.reference ?? 'Reference not recorded'}</h2>
      <p>
        {d.order.customerName} · Pickup {d.order.pickupDate}
      </p>
      <p>Financial status: {statusLabel(o.status)}</p>
      <p>Operation amount: {money(o.amountCents, d.order.currency)}</p>
      {d.order.blocked && (
        <p>
          Attention reason: Blocked refund ledger. Recorded totals do not
          authorize another refund.
        </p>
      )}
      <RefundTotals order={d.order} />
      <dl>
        <dt>Operation ID</dt>
        <dd>{o.operationId}</dd>
        <dt>Provider refund reference</dt>
        <dd>{o.providerId ?? 'Not recorded'}</dd>
        <dt>Recorded check count</dt>
        <dd>{o.checks}</dd>
        <dt>Created</dt>
        <dd>{timestamp(o.createdAt)} Denver</dd>
        <dt>Last recorded update</dt>
        <dd>{timestamp(o.updatedAt)} Denver</dd>
        <dt>Restock decision</dt>
        <dd>
          {o.disposition === 'RESTOCK' ? 'Explicit restock' : 'Do not restock'}
        </dd>
        <dt>Detailed failure reason</dt>
        <dd>Not recorded</dd>
        <dt>Complete provider attempt history</dt>
        <dd>Not recorded</dd>
      </dl>
      <h3>Requested restock quantities for this operation</h3>
      {o.items.length ? (
        o.items.map((i) => (
          <p key={i.productId}>
            {i.productId}: {i.quantity}
          </p>
        ))
      ) : (
        <p>None recorded</p>
      )}
      <h3>Recorded returned quantities · cumulative for this Order</h3>
      {Object.entries(d.order.returned).length ? (
        Object.entries(d.order.returned).map(([id, q]) => (
          <p key={id}>
            {id}: {q}
          </p>
        ))
      ) : (
        <p>None recorded</p>
      )}
      <h3>Recorded audit transitions · this page</h3>
      {d.audit.map((a, i) => (
        <p key={i}>
          {statusLabel(a.status)} · {timestamp(a.at)} Denver
        </p>
      ))}
      {!d.audit.length && <p>No transitions on this page.</p>}
      {d.nextCursor && <p>More recorded transitions remain.</p>}
    </section>
  );
}
async function read(query: string) {
  const r = await fetch('/api/admin/refund-worklist?' + query, {
    method: 'GET',
    cache: 'no-store',
  });
  if (r.status === 401 || r.status === 403) {
    window.location.replace('/admin/login?reason=expired');
    throw Error('Sign in again.');
  }
  if (!r.ok)
    throw Error(
      'Unable to read consistent refund evidence. Refresh the worklist. No financial action was performed.',
    );
  return r.json();
}
export function RefundWorklistView({ expiresAt }: { expiresAt: number }) {
  const [drops, setDrops] = useState<{ dropId: string; name: string }[]>([]),
    [dropCursor, setDropCursor] = useState<string | null>(null),
    [mode, setMode] = useState('drop'),
    [drop, setDrop] = useState(''),
    [date, setDate] = useState(''),
    [reference, setReference] = useState(''),
    [status, setStatus] = useState(''),
    [only, setOnly] = useState(true),
    [query, setQuery] = useState(''),
    [scope, setScope] = useState('Choose a scope'),
    [rows, setRows] = useState<WorklistRow[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<RefundDetail | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
  async function loadDrops(next?: string) {
    const r = await fetch(
      '/api/admin/drops' + (next ? '?cursor=' + encodeURIComponent(next) : ''),
      { cache: 'no-store' },
    );
    if (r.status === 401 || r.status === 403)
      window.location.replace('/admin/login?reason=expired');
    if (!r.ok) throw Error('Unable to load Drops.');
    const d = await r.json();
    setDrops((old) => (next ? [...old, ...d.drops] : d.drops));
    setDropCursor(d.nextCursor);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to read refunds.');
    } finally {
      setBusy(false);
    }
  }
  async function page(q: string, next?: string) {
    const d = await read(
      q + (next ? '&cursor=' + encodeURIComponent(next) : ''),
    );
    if (next && d.nextCursor === next)
      throw Error('Continuation did not advance. Refresh.');
    setRows(d.rows);
    setCursor(d.nextCursor);
    setDetail(null);
  }
  async function search() {
    const p = new URLSearchParams({ attentionOnly: String(only) });
    if (status) p.set('status', status);
    let label = '';
    if (mode === 'reference') {
      p.set('reference', reference.trim().toUpperCase());
      label = 'Exact reference ' + reference.trim().toUpperCase();
    } else if (mode === 'date') {
      p.set('pickupDate', date);
      label = 'Pickup ' + date;
    } else {
      p.set('dropId', drop);
      label = 'Drop ' + (drops.find((d) => d.dropId === drop)?.name ?? drop);
    }
    await page(p.toString());
    setQuery(p.toString());
    setScope(label);
  }
  async function open(o: WorklistRow) {
    if (!o.operation) return;
    setDetail(
      await read(
        new URLSearchParams({
          orderId: o.orderId,
          operationId: o.operation.operationId,
        }).toString(),
      ),
    );
  }
  return (
    <div className="admin-shell">
      <AdminNavigation current="orders" />
      <main className="admin-main admin-orders weekly-drops refund-review">
        <a href="/admin/orders">Back to Orders</a>
        <h1>Refunds needing attention</h1>
        <p>Read-only recorded evidence. Refresh never processes a refund.</p>
        <p>
          Discovery covers the selected Drop or pickup date, or an exact
          reference. Historical records missing indexed attributes or references
          may be absent. Index visibility can lag. Pages are not a snapshot;
          refresh when records change.
        </p>
        <p>
          Operational review: authorized or dispatched after 60 minutes; pending
          after 24 hours, measured from creation. These are attention
          indicators, not failure or completion deadlines.
        </p>
        <p role="status">{busy ? 'Loading…' : error}</p>
        {detail ? (
          <>
            <button disabled={busy} onClick={() => setDetail(null)}>
              Back to worklist
            </button>
            <ReadOnlyRefundDetails data={detail} />
            {detail.nextCursor && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const q = new URLSearchParams({
                      orderId: detail.order.orderId,
                      operationId: detail.operation.operationId,
                      cursor: detail.nextCursor!,
                    });
                    const d = await read(q.toString());
                    if (d.nextCursor === detail.nextCursor)
                      throw Error('Continuation did not advance. Refresh.');
                    setDetail(d);
                  })
                }
              >
                Next audit page
              </button>
            )}
          </>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(search);
              }}
            >
              <fieldset disabled={busy}>
                <legend>Worklist scope and filters</legend>
                <label>
                  Scope
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="drop">Drop</option>
                    <option value="date">Pickup date</option>
                    <option value="reference">Exact order reference</option>
                  </select>
                </label>
                {mode === 'drop' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void action(() => loadDrops())}
                    >
                      Load Drops
                    </button>
                    <label>
                      Drop
                      <select
                        required
                        value={drop}
                        onChange={(e) => setDrop(e.target.value)}
                      >
                        <option value="">Select a Drop</option>
                        {drops.map((d) => (
                          <option key={d.dropId} value={d.dropId}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {dropCursor && (
                      <button
                        type="button"
                        onClick={() => void action(() => loadDrops(dropCursor))}
                      >
                        Load more Drops
                      </button>
                    )}
                  </>
                ) : mode === 'date' ? (
                  <label>
                    Pickup date
                    <input
                      required
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </label>
                ) : (
                  <label>
                    Order reference
                    <input
                      required
                      maxLength={15}
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      placeholder="BB-XXXXXXXXXXXX"
                    />
                  </label>
                )}
                <label>
                  Financial status
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">All seven statuses</option>
                    {financialStatuses.map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={only}
                    onChange={(e) => setOnly(e.target.checked)}
                  />
                  Attention only
                </label>
                <p>
                  Blocked ledger notices remain visible regardless of status
                  filters.
                </p>
                <button type="submit">Apply filters</button>
              </fieldset>
            </form>
            <h2>{scope}</h2>
            {query && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void action(() => page(query))}
                >
                  Refresh worklist
                </button>
                <p>These are page results, not a complete worklist count.</p>
                {!rows.length && (
                  <p>
                    No matching records on this page.{' '}
                    {cursor
                      ? 'More records remain; continue to the next page.'
                      : 'End of the selected traversal. Coverage limitations still apply.'}
                  </p>
                )}
              </>
            )}
            <div className="order-cards">
              {rows.map((r) => (
                <article
                  key={r.orderId + ':' + (r.operation?.operationId ?? 'ledger')}
                >
                  <h3>{r.reference ?? 'Reference not recorded'}</h3>
                  <p>
                    {r.customerName} · Pickup {r.pickupDate}
                  </p>
                  <p>Drop {r.dropId}</p>
                  <p>
                    Financial status:{' '}
                    {r.operation
                      ? statusLabel(r.operation.status)
                      : 'Not applicable — ledger notice'}
                  </p>
                  <p>
                    Attention reason:{' '}
                    {r.attentionReason ?? 'No current attention indicator'}
                  </p>
                  {r.operation && (
                    <p>
                      Operation amount:{' '}
                      {money(r.operation.amountCents, r.currency)}
                    </p>
                  )}
                  <p>
                    Last recorded update:{' '}
                    {timestamp(r.operation?.updatedAt ?? r.updatedAt)} Denver
                  </p>
                  <RefundTotals order={r} />
                  {r.operation && (
                    <button
                      disabled={busy}
                      onClick={() => void action(() => open(r))}
                    >
                      View recorded refund details
                    </button>
                  )}
                </article>
              ))}
            </div>
            {cursor && (
              <button
                disabled={busy}
                onClick={() => void action(() => page(query, cursor))}
              >
                Next worklist page
              </button>
            )}
          </>
        )}
      </main>
    </div>
  );
}
