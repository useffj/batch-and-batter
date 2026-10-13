'use client';
// Full navigation avoids retaining authenticated route state in client caches.
/* eslint-disable @next/next/no-html-link-for-pages */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminRequest,
  ClientFailure,
  type Snapshot,
} from '../../lib/admin/client';
import { DropOverview } from './overview';
export function Dashboard({ expiresAt }: { expiresAt: number }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null),
    signedOut = useRef(false);
  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError('');
    setSnapshot(null);
    try {
      const result: Snapshot = await adminRequest(
        'dashboard',
        undefined,
        current.signal,
      );
      if (!current.signal.aborted && !signedOut.current) setSnapshot(result);
    } catch (e) {
      if (current.signal.aborted || signedOut.current) return;
      if (
        e instanceof ClientFailure &&
        (e.status === 401 || e.status === 403)
      ) {
        window.location.replace(
          `/admin/login?reason=${e.status === 403 ? 'forbidden' : 'expired'}`,
        );
        return;
      }
      setError(
        e instanceof ClientFailure
          ? e.message
          : 'Unable to reach administrative services. Try refreshing.',
      );
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const expire = () => {
      if (Date.now() >= expiresAt) {
        controller.current?.abort();
        setSnapshot(null);
        window.location.replace('/admin/login?reason=expired');
      }
    };
    const timer = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    const visible = () => {
      if (document.visibilityState === 'visible') {
        expire();
        if (Date.now() < expiresAt) void load();
      } else {
        controller.current?.abort();
        setSnapshot(null);
      }
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setSnapshot(null);
        window.location.reload();
      }
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', restored);
    return () => {
      controller.current?.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', restored);
    };
  }, [load, expiresAt]);
  async function signOut() {
    signedOut.current = true;
    controller.current?.abort();
    setSnapshot(null);
    setBusy(true);
    setError('');
    try {
      const result = await adminRequest('logout');
      window.location.replace(
        `/admin/login?reason=${result.revocationConfirmed ? 'signed-out' : 'local-sign-out'}`,
      );
    } catch {
      setError('Sign-out could not be confirmed. Please try Sign out again.');
      setBusy(false);
    }
  }
  return (
    <div className="admin-shell">
      <a className="admin-skip" href="#admin-content">
        Skip to overview
      </a>
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/">
          Batch &amp; Batter<span>COOKIE CO. / ADMIN</span>
        </a>
        <nav aria-label="Administration">
          <a href="/admin" aria-current="page">
            Overview
          </a>
        </nav>
        <p className="admin-eyebrow">Coming later</p>
        <ul className="admin-future">
          {[
            'Products',
            'Drops',
            'Orders',
            'Customers',
            'Fulfillment',
            'Messaging',
            'Settings',
          ].map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </aside>
      <main id="admin-content" className="admin-main" tabIndex={-1}>
        <header className="admin-heading">
          <div>
            <p className="admin-eyebrow">Your weekly Drop</p>
            <h1>Overview</h1>
            <p className="admin-muted">A read-only view of the kitchen.</p>
          </div>
          <div className="admin-actions">
            <button
              type="button"
              disabled={busy || signedOut.current}
              onClick={() => void load()}
            >
              Refresh
            </button>
            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        <div aria-live="polite" role="status">
          {busy ? (
            'Loading administrative information…'
          ) : snapshot ? (
            <>
              Last loaded:{' '}
              <time dateTime={snapshot.loadedAt}>
                {new Intl.DateTimeFormat('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                  timeZone: snapshot.overview?.drop.timezone ?? 'UTC',
                }).format(new Date(snapshot.loadedAt))}
              </time>{' '}
              ({snapshot.overview?.drop.timezone ?? 'UTC'})
            </>
          ) : null}
        </div>
        {error && (
          <section className="admin-card admin-error" role="alert">
            <h2>Information unavailable</h2>
            <p>{error}</p>
          </section>
        )}
        {snapshot && !busy && <DropOverview overview={snapshot.overview} />}
      </main>
    </div>
  );
}
