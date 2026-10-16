'use client';
import { useEffect, useState } from 'react';
import { AdminNavigation } from './navigation';
import './weekly-drops.css';
import './orders.css';
type Entry = {
  id: string;
  email: string;
  joinedAt: string;
  suppressed: boolean;
  notification: string;
};
type Choice = { dropId: string; name: string };
type Product = { productId: string; name: string };
async function request(path: string, body?: unknown) {
  const r = await fetch('/api/admin/' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (r.status === 401 || r.status === 403) {
    window.location.replace('/admin/login?reason=expired');
    throw Error('Sign in again.');
  }
  const data = await r.json();
  if (!r.ok)
    throw Error(
      data.message ?? 'Unable to confirm this action. Refresh before retrying.',
    );
  return data;
}
export function WaitlistManagement({ expiresAt }: { expiresAt: number }) {
  const [drops, setDrops] = useState<Choice[]>([]),
    [dropCursor, setDropCursor] = useState<string | null>(null),
    [dropId, setDrop] = useState(''),
    [products, setProducts] = useState<Product[]>([]),
    [productId, setProduct] = useState(''),
    [entries, setEntries] = useState<Entry[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [review, setReview] = useState<{
      event: string;
      available: number;
      product: string;
      drop: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [continueCampaign, setContinue] = useState(false);
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
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Unable to complete this action.',
      );
      setReview(null);
      setContinue(false);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    request('drops')
      .then((d) => {
        if (active) {
          setDrops(d.drops);
          setDropCursor(d.cursor ?? null);
        }
      })
      .catch(() => {
        if (active)
          setMessage('Unable to load Drops. Reload this page to retry.');
      });
    return () => {
      active = false;
    };
  }, []);
  const scope = { dropId, productId };
  async function load(more = false) {
    const d = await request(
      'waitlists/list?' +
        new URLSearchParams({
          ...scope,
          ...(more && cursor ? { cursor } : {}),
        }),
    );
    setEntries((old) => (more ? [...old, ...d.entries] : d.entries));
    setCursor(d.cursor);
  }
  return (
    <div className="admin-shell">
      <AdminNavigation current="waitlists" />
      <main className="admin-main weekly-drops admin-orders">
        <h1>Waitlist Management</h1>
        <p>
          Review availability before requesting email alerts. Alerts never
          reserve cookies; purchasing remains first-come, first-served.
        </p>
        <p role="status">{busy ? 'Working…' : message}</p>
        <label>
          Drop
          <select
            value={dropId}
            disabled={busy}
            onChange={(e) => {
              const value = e.target.value;
              setDrop(value);
              setProduct('');
              setProducts([]);
              setEntries([]);
              setCursor(null);
              setReview(null);
              setContinue(false);
              if (value)
                void action(async () => {
                  const d = await request('drops/' + value + '/composition');
                  setProducts(
                    d.products
                      .filter((p: { product: Product | null }) => p.product)
                      .map((p: { product: Product }) => p.product),
                  );
                });
            }}
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
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const d = await request(
                  'drops?cursor=' + encodeURIComponent(dropCursor),
                );
                setDrops((old) => [...old, ...d.drops]);
                setDropCursor(d.cursor ?? null);
              })
            }
          >
            Load more Drops
          </button>
        )}
        <label>
          Cookie
          <select
            value={productId}
            disabled={busy || !dropId}
            onChange={(e) => {
              setProduct(e.target.value);
              setEntries([]);
              setCursor(null);
              setReview(null);
              setContinue(false);
            }}
          >
            <option value="">Select a cookie</option>
            {products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !productId}
          onClick={() => void action(() => load())}
        >
          Refresh entries
        </button>
        <button
          disabled={busy || !productId}
          onClick={() =>
            void action(async () => {
              setReview(await request('waitlists/review', scope));
              setContinue(false);
            })
          }
        >
          Review availability
        </button>
        {review && (
          <section aria-label="Availability approval">
            <h2>
              {review.product} · {review.drop}
            </h2>
            <p>
              {review.available} available at last check. Sending rechecks
              inventory and consent. This action prepares up to 20 entries at a
              time; continue until preparation is complete.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const r = await request('waitlists/campaign', {
                    ...scope,
                    event: review.event,
                  });
                  setContinue(!r.done);
                  setMessage(
                    r.done
                      ? 'Campaign preparation complete. Delivery status appears after worker processing.'
                      : 'Page prepared. Continue this approved campaign for remaining entries.',
                  );
                  await load();
                })
              }
            >
              {continueCampaign
                ? 'Continue approved campaign'
                : 'Approve availability emails'}
            </button>
          </section>
        )}
        <section aria-label="Waitlist entries">
          <h2>Entries</h2>
          <p>
            Unconfirmed delivery needs operator investigation; do not assume
            delivery or resend.
          </p>
          {entries.length === 0 ? (
            <p>No entries loaded. Select a cookie and refresh.</p>
          ) : (
            <ul>
              {entries.map((e) => (
                <li key={e.id}>
                  <strong style={{ overflowWrap: 'anywhere' }}>
                    {e.email}
                  </strong>
                  <p>
                    Joined{' '}
                    {new Intl.DateTimeFormat('en-US', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'America/Denver',
                    }).format(new Date(e.joinedAt))}{' '}
                    (Denver)
                  </p>
                  <p>
                    {e.suppressed
                      ? 'Unsubscribed — excluded from alerts'
                      : 'Consented to email availability alerts'}
                  </p>
                  <p>
                    Notification:{' '}
                    {(
                      {
                        NOT_NOTIFIED: 'Not notified',
                        PENDING: 'Queued',
                        DISPATCHED_OUTCOME_UNKNOWN:
                          'Delivery unconfirmed — needs attention',
                        UNCERTAIN: 'Delivery uncertain — needs attention',
                        FAILED: 'Delivery failed — needs attention',
                        SENT: 'Sent',
                        SUPPRESSED: 'Suppressed',
                        SUPPRESSED_UNAVAILABLE: 'Skipped — unavailable',
                      } as Record<string, string>
                    )[e.notification] ?? 'Status unavailable — needs attention'}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <button
              disabled={busy}
              onClick={() => void action(() => load(true))}
            >
              Load more entries
            </button>
          )}
        </section>
      </main>
    </div>
  );
}
