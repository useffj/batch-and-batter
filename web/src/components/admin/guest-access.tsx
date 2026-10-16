'use client';
import { useRef, useState } from 'react';
type Status = {
  tokens: {
    id: string;
    issuedAt: string;
    expiresAt: string;
    expired: boolean;
  }[];
  originalExpiresAt: string | null;
};
export function GuestAccess({ orderId }: { orderId: string }) {
  const [status, setStatus] = useState<Status | null>(null),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<{
    action: string;
    body: { requestId: string; reason: string; tokenId?: string };
  } | null>(null);
  async function load() {
    const r = await fetch(`/api/admin/orders/${orderId}/access`, {
      cache: 'no-store',
    });
    if (r.status === 401 || r.status === 403)
      window.location.replace('/admin/login?reason=expired');
    if (!r.ok) throw Error('Access status unavailable.');
    setStatus(await r.json());
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Access action unavailable.');
    } finally {
      setBusy(false);
    }
  }
  async function act(action: string, tokenId?: string) {
    pending.current ??= {
      action,
      body: {
        requestId: crypto.randomUUID(),
        reason,
        ...(tokenId ? { tokenId } : {}),
      },
    };
    const p = pending.current;
    const r = await fetch(`/api/admin/orders/${orderId}/access/${p.action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p.body),
      cache: 'no-store',
    });
    if (!r.ok) {
      if (r.status < 500) pending.current = null;
      throw Error(
        'Action not confirmed. Retry the same action or refresh status.',
      );
    }
    pending.current = null;
    setReason('');
    setMessage(
      action === 'reissue'
        ? 'Replacement email operation recorded. Existing links remain valid.'
        : 'Selected link revoked.',
    );
    await load();
  }
  return (
    <section aria-label="Guest order access">
      <h3>Guest order access</h3>
      <p>
        Reissue preserves existing links. Revocation is a separate audited
        action. At most two active links are allowed. Live email sending remains
        disabled.
      </p>
      <button type="button" disabled={busy} onClick={() => run(load)}>
        Refresh link status
      </button>
      {message && <p role="status">{message}</p>}
      {status && (
        <>
          <p>
            Original expiration:{' '}
            {status.originalExpiresAt
              ? new Date(status.originalExpiresAt).toLocaleString('en-US', {
                  timeZone: 'America/Denver',
                }) + ' Denver'
              : 'Not issued'}
          </p>
          <label>
            Reason for access action
            <textarea
              value={reason}
              maxLength={500}
              disabled={busy || !!pending.current}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {pending.current ? (
            <button
              disabled={busy}
              type="button"
              onClick={() => run(() => act(pending.current!.action))}
            >
              Retry the same access action
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={
                  busy ||
                  !reason.trim() ||
                  status.tokens.filter((t) => !t.expired).length >= 2
                }
                onClick={() => run(() => act('reissue'))}
              >
                Authorize replacement email
              </button>
              <ul>
                {status.tokens.map((t, n) => (
                  <li key={t.id}>
                    Link {n + 1} · {t.expired ? 'Expired' : 'Active'} · issued{' '}
                    {new Date(t.issuedAt).toLocaleString('en-US', {
                      timeZone: 'America/Denver',
                    })}{' '}
                    Denver{' '}
                    <button
                      type="button"
                      disabled={busy || !reason.trim()}
                      onClick={() => run(() => act('revoke', t.id))}
                    >
                      Revoke link {n + 1}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
