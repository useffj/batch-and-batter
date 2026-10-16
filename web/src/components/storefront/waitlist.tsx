'use client';
import './waitlist.css';
import { useEffect, useId, useState } from 'react';
export function JoinWaitlist({
  dropId,
  productId,
  name,
}: {
  dropId: string;
  productId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const id = useId();
  return (
    <section
      className="waitlist-signup"
      aria-label={'Availability alerts for ' + name}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Join Waitlist
      </button>
      {open && (
        <form
          method="post"
          action="/api/waitlist/join"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            const data = new FormData(e.currentTarget);
            setBusy(true);
            setMessage('');
            try {
              const r = await fetch('/api/waitlist/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  dropId,
                  productId,
                  email: String(data.get('email') ?? '').trim(),
                  consent: data.get('consent') === 'on',
                }),
                cache: 'no-store',
              });
              const result = await r.json();
              setMessage(result.message);
            } catch {
              setMessage(
                'Unable to confirm your request. You can retry safely.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            Cookies are first-come, first-served. Joining does not reserve
            cookies or guarantee availability.
          </p>
          <label htmlFor={id}>Email address</label>
          <input
            id={id}
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
          />
          <label>
            <input type="checkbox" name="consent" required /> Email me when{' '}
            {name} is available in this Drop. I can unsubscribe at any time.
          </label>
          <button disabled={busy} type="submit">
            {busy ? 'Submitting…' : 'Request availability alerts'}
          </button>
        </form>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
export function Unsubscribe() {
  const [token, setToken] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setToken(window.location.hash.slice(1));
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return (
    <main>
      <h1>Stop availability alerts</h1>
      <p>Stop alerts for the cookie and Drop associated with this link.</p>
      <button
        disabled={!token || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await fetch('/api/waitlist/unsubscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              cache: 'no-store',
              body: JSON.stringify({ token }),
            });
            const data = await r.json();
            setMessage(data.message);
            if (r.ok) setToken('');
          } catch {
            setMessage(
              'Unable to confirm. Please reopen the original email link and retry.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Unsubscribe
      </button>
      <p role="status">{message}</p>
    </main>
  );
}
