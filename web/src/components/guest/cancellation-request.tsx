'use client';
import { useRef, useState } from 'react';
import {
  type CancellationView,
  requestLabels,
  requestTime,
} from '../../lib/order-requests';
export function CancellationRequest({
  data,
  send,
  refresh,
}: {
  data: CancellationView;
  send: (action: string, body: object) => Promise<unknown>;
  refresh: () => Promise<void>;
}) {
  const [reason, setReason] = useState(''),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<{
    requestId: string;
    type: 'GUARANTEED' | 'EXCEPTION';
    reason: string;
  } | null>(null);
  async function submit() {
    setBusy(true);
    setMessage('');
    pending.current ??= {
      requestId: crypto.randomUUID(),
      type: data.eligible ? 'GUARANTEED' : 'EXCEPTION',
      reason,
    };
    try {
      await send('request', { request: pending.current });
      pending.current = null;
      setConfirm(false);
      setMessage('Your cancellation request has been received.');
      await refresh();
    } catch (e) {
      if (
        e instanceof Error &&
        'status' in e &&
        [400, 403, 404, 409].includes(Number(e.status))
      ) {
        pending.current = null;
        setConfirm(false);
        await refresh();
      }
      setMessage(
        'Submission was not confirmed. Retry the same request to check safely, or refresh your order.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Cancellation and refund requests">
      <h3>Cancellation and refund requests</h3>
      <p>
        Eligible paid, uncollected orders qualify for a full refund when
        cancellation is requested at least {data.hours} hours before pickup
        begins. After that deadline, assistance is discretionary and a refund is
        not guaranteed.
      </p>
      {data.deadline && (
        <p>
          Cancellation deadline: <strong>{requestTime(data.deadline)}</strong>
        </p>
      )}
      {data.request ? (
        <>
          <p role="status">
            {requestLabels[data.request.status] ??
              'Request requires bakery review'}
          </p>
          <p>Received {requestTime(data.request.createdAt)}</p>
          {data.request.reason && <p>Your reason: {data.request.reason}</p>}
          <p>
            This request does not confirm an Order cancellation or a completed
            refund.
          </p>
        </>
      ) : (
        <>
          {data.unavailable && <p>{data.unavailable}</p>}
          {data.eligible && (
            <p>
              You are eligible to request cancellation for a full refund.
              Financial processing is a separate step.
            </p>
          )}
          {data.exceptionEligible && (
            <p>
              The guaranteed cancellation deadline has passed. You may request
              assistance with a reason; approval is discretionary.
            </p>
          )}
          {(data.eligible || data.exceptionEligible || pending.current) && (
            <>
              <label htmlFor="request-reason">
                {data.eligible ? 'Reason (optional)' : 'Reason for assistance'}
              </label>
              <textarea
                id="request-reason"
                maxLength={500}
                value={reason}
                disabled={busy || !!pending.current}
                onChange={(e) => setReason(e.target.value)}
              />
              {confirm || pending.current ? (
                <>
                  <p>
                    Submit this request? It will be recorded for the bakery. No
                    refund is issued by this action.
                  </p>
                  <button type="button" disabled={busy} onClick={submit}>
                    {pending.current
                      ? 'Retry the same request'
                      : 'Confirm request'}
                  </button>
                  {!pending.current && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm(false)}
                    >
                      Keep my order
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy || (data.exceptionEligible && !reason.trim())}
                  onClick={() => setConfirm(true)}
                >
                  {data.eligible
                    ? 'Request cancellation'
                    : 'Request assistance'}
                </button>
              )}
            </>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
