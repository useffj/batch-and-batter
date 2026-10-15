'use client';
import { useEffect, useState } from 'react';
import { AdminNavigation } from './navigation';
import { OrderDetails, human, money, timestamp, type Order } from './orders';
import './weekly-drops.css';
import './orders.css';
type Contact = {
  contactKey: string;
  customer: { name: string; email: string; phone: string };
  recentOrder: { displayOrderNumber: string | null; createdAt: string };
};
type HistoricalOrder = Order & { dropName: string | null };
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
  const d = await r.json();
  if (!r.ok) throw Error(d.message ?? 'Unable to load records.');
  return d;
}
export function Customers({ expiresAt }: { expiresAt: number }) {
  const [query, setQuery] = useState(''),
    [searched, setSearched] = useState(''),
    [contacts, setContacts] = useState<Contact[]>([]),
    [searchCursor, setSearchCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<Contact | null>(null),
    [orders, setOrders] = useState<HistoricalOrder[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<Order | null>(null),
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
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Unable to load customer records.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function search(term: string, cursor?: string) {
    const r = await request('customers/search', {
      query: term,
      ...(cursor ? { cursor } : {}),
    });
    setContacts(r.contacts);
    setSearchCursor(r.nextCursor);
    setSearched(term);
    setSelected(null);
    setDetail(null);
  }
  async function history(contact: Contact, cursor?: string) {
    const r = await request('customers/history', {
      contactKey: contact.contactKey,
      ...(cursor ? { cursor } : {}),
    });
    setOrders(r.orders);
    setHistoryCursor(r.nextCursor);
    setSelected(contact);
    setDetail(null);
  }
  return (
    <div className="admin-shell">
      <AdminNavigation current="customers" />
      <main className="admin-main weekly-drops admin-orders">
        <h1>Customers</h1>
        <p>
          Find recorded contacts and their orders. Matching contact information
          does not verify a person&apos;s identity.
        </p>
        <p>
          Historical search coverage is incomplete until lookup backfill is
          reconciled. No customer accounts are created.
        </p>
        <p role="status" aria-live="polite">
          {busy ? 'Loading…' : error}
        </p>
        {selected ? (
          <>
            <button
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setDetail(null);
                setError('');
              }}
            >
              Back to search results
            </button>
            <h2>{selected.customer.name}</h2>
            <p>
              {selected.customer.email}
              <br />
              {selected.customer.phone}
            </p>
            <p>
              History groups only identical recorded name, email and phone
              values. Changed contact details appear separately.
            </p>
            {detail ? (
              <>
                <button disabled={busy} onClick={() => setDetail(null)}>
                  Back to contact history
                </button>
                <OrderDetails order={detail} />
              </>
            ) : (
              <section aria-label="Contact order history">
                <h3>Order history</h3>
                <p>
                  Newest first. This page is bounded; no lifetime counts or
                  spending totals are implied.
                </p>
                <button
                  disabled={busy}
                  onClick={() => void action(() => history(selected))}
                >
                  Refresh history
                </button>
                {!orders.length && !busy && (
                  <p>
                    No matching orders on this page.
                    {historyCursor
                      ? ' More records can be checked on the next page.'
                      : ''}
                  </p>
                )}
                <div className="order-cards">
                  {orders.map((o) => (
                    <article key={o.orderId}>
                      <h3>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(async () =>
                              setDetail(
                                (await request('orders/' + o.orderId)).order,
                              ),
                            )
                          }
                        >
                          {o.displayOrderNumber ?? 'Reference not recorded'}
                        </button>
                      </h3>
                      <p>{timestamp(o.createdAt)} Denver</p>
                      <p>
                        Drop: {o.dropName ?? 'Name unavailable'}
                        {o.dropName ? ' (current label)' : ''}
                      </p>
                      <ul>
                        {o.items?.map((i, n) => (
                          <li key={n}>
                            {i.quantity} × {i.name}
                          </li>
                        ))}
                      </ul>
                      <p>Historical total: {money(o.totalCents, o.currency)}</p>
                      <p>
                        {human(o.status)} · Payment: {human(o.paymentStatus)}
                      </p>
                      <p>
                        Pickup {o.pickupDate} · Fulfillment:{' '}
                        {o.fulfillmentStatus
                          ? human(o.fulfillmentStatus)
                          : 'Not recorded'}
                      </p>
                    </article>
                  ))}
                </div>
                {historyCursor && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(() => history(selected, historyCursor))
                    }
                  >
                    Next history page
                  </button>
                )}
              </section>
            )}
          </>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(() => search(query.trim()));
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  Name or exact email
                  <input
                    autoComplete="off"
                    required
                    maxLength={254}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <p>
                  Full name or first/last whitespace token, ignoring case and
                  extra spaces. No fuzzy or substring matching.
                </p>
                <button type="submit">Search</button>
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSearched('');
                    setContacts([]);
                    setSearchCursor(null);
                    setOrders([]);
                    setError('');
                  }}
                >
                  Clear search
                </button>
              </fieldset>
            </form>
            {searched && (
              <section aria-label="Matching contacts">
                <h2>Matching recorded contacts</h2>
                <p>
                  Results reflect this page of matching orders. A contact can
                  reappear on another page; no complete order count is implied.
                </p>
                {!contacts.length && !busy && (
                  <p>
                    No matching contacts on this page.
                    {searchCursor
                      ? ' More records can be checked on the next page.'
                      : ''}
                  </p>
                )}
                <div className="order-cards">
                  {contacts.map((c) => (
                    <article key={c.contactKey}>
                      <h3>{c.customer.name}</h3>
                      <p>
                        {c.customer.email}
                        <br />
                        {c.customer.phone}
                      </p>
                      <p>
                        Recent match:{' '}
                        {c.recentOrder.displayOrderNumber ??
                          'Reference not recorded'}
                        <br />
                        {timestamp(c.recentOrder.createdAt)} Denver
                      </p>
                      <button
                        disabled={busy}
                        onClick={() => void action(() => history(c))}
                      >
                        View history for {c.customer.email}
                      </button>
                    </article>
                  ))}
                </div>
                {searchCursor && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(() => search(searched, searchCursor))
                    }
                  >
                    Next results page
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
