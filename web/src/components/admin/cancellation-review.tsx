'use client';
import { useRef, useState } from 'react';
import {
  type CancellationView,
  requestLabels,
  requestTime,
} from '../../lib/order-requests';
type ReviewView = CancellationView & {
  paymentStatus: string;
  refundDisposition: string;
  history: {
    requestId: string;
    at: string;
    action: string;
    administrator?: string;
    note?: string;
    reason?: string;
  }[];
  historyTruncated: boolean;
};
export function CancellationReview({ orderId }: { orderId: string }) {
  const [data, setData] = useState<ReviewView | null>(null),
    [note, setNote] = useState(''),
    [decision, setDecision] = useState('NOTE'),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<{
    requestId: string;
    revision: number;
    decision: string;
    note: string;
  } | null>(null);
  async function call(body?: object) {
    const r = await fetch(
      '/api/admin/orders/' + orderId + '/requests' + (body ? '/review' : ''),
      {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      },
    );
    if (r.status === 401 || r.status === 403)
      window.location.replace('/admin/login?reason=expired');
    if (!r.ok) {
      if (body && r.status < 500) pending.current = null;
      throw Error(
        'Request review unavailable. Refresh or retry the same action.',
      );
    }
    return r.json();
  }
  async function load() {
    setData(await call());
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Review unavailable.');
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    if (!data?.request) return;
    pending.current ??= {
      requestId: crypto.randomUUID(),
      revision: data.request.revision,
      decision,
      note,
    };
    await call(pending.current);
    pending.current = null;
    setNote('');
    setDecision('NOTE');
    setMessage('Review recorded. No refund was issued.');
    await load();
  }
  return (
    <section aria-label="Cancellation request review">
      <h3>Cancellation and refund requests</h3>
      <button type="button" disabled={busy} onClick={() => run(load)}>
        Load request and review history
      </button>
      {message && <p role="status">{message}</p>}
      {data &&
        (data.request ? (
          <>
            <p>{requestLabels[data.request.status]}</p>
            <p>
              Payment: {data.paymentStatus} · Refund disposition:{' '}
              {data.refundDisposition}
            </p>
            <p>
              {data.request.type === 'GUARANTEED'
                ? 'Guaranteed full-refund entitlement'
                : 'Exception review; no amount approved'}
              :{' '}
              {new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: data.request.eligibility.currency,
              }).format(data.request.eligibility.amountCents / 100)}{' '}
              order total.
            </p>
            <p>
              Deadline at submission:{' '}
              {requestTime(data.request.eligibility.deadline)}. Pickup:{' '}
              {data.request.eligibility.pickupDate} at{' '}
              {data.request.eligibility.pickupStart} Denver.
            </p>
            <p>
              Received {requestTime(data.request.createdAt)} · Updated{' '}
              {requestTime(data.request.updatedAt)}
            </p>
            <p>Customer reason: {data.request.reason || 'Not supplied'}</p>
            <label htmlFor={'review-note-' + orderId}>Review note</label>
            <textarea
              id={'review-note-' + orderId}
              maxLength={500}
              value={note}
              disabled={busy || !!pending.current}
              onChange={(e) => setNote(e.target.value)}
            />
            <label htmlFor={'review-decision-' + orderId}>Review action</label>
            <select
              id={'review-decision-' + orderId}
              value={decision}
              disabled={busy || !!pending.current}
              onChange={(e) => setDecision(e.target.value)}
            >
              <option value="NOTE">Record note</option>
              {data.request.type === 'EXCEPTION' &&
                data.request.status === 'EXCEPTION_REQUESTED' && (
                  <>
                    <option value="APPROVE_EXCEPTION">
                      Approve exception for processing
                    </option>
                    <option value="DECLINE_EXCEPTION">
                      Decline discretionary exception
                    </option>
                  </>
                )}
            </select>
            <button
              type="button"
              disabled={busy || (!pending.current && !note.trim())}
              onClick={() => run(review)}
            >
              {pending.current ? 'Retry same review' : 'Record review'}
            </button>
            <p>
              Timely guaranteed entitlement cannot be declined. Financial
              execution is not available here.
            </p>
            <h4>Recent audit history</h4>
            <ul>
              {data.history.map((h) => (
                <li key={h.requestId}>
                  {requestTime(h.at)} · {h.action.replaceAll('_', ' ')} ·{' '}
                  {h.administrator
                    ? 'Administrator ' + h.administrator
                    : 'Customer'}
                  {h.note && <p>{h.note}</p>}
                  {h.reason && <p>{h.reason}</p>}
                </li>
              ))}
            </ul>
            {data.historyTruncated && (
              <p>
                Showing the most recent 25 actions; earlier immutable records
                are retained.
              </p>
            )}
          </>
        ) : (
          <p>No request recorded.</p>
        ))}
    </section>
  );
}
