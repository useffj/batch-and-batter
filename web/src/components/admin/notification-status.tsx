'use client';
import { useState } from 'react';
type Notice = {
  key: string;
  kind: 'CONFIRMATION' | 'REMINDER' | 'ACCESS' | 'PICKUP_CHANGE' | 'REQUEST';
  channel: 'email' | 'sms';
  status: string;
  reason?: string;
  sentAt?: string;
  updatedAt: string;
  pickupDate: string;
};
export type NotificationSummary = {
  notifications: Notice[];
  truncated: boolean;
  confirmationSms: string;
};
const labels: Record<string, string> = {
  PENDING: 'Queued',
  DISPATCHED: 'Sending — awaiting acknowledgement',
  SENT: 'Accepted by provider',
  FAILED: 'Failed — needs attention',
  UNCERTAIN: 'Delivery uncertain — needs attention',
  SUPPRESSED: 'Suppressed',
};
const reasons: Record<string, string> = {
  PAYMENT_NOT_ELIGIBLE: 'Payment is not eligible.',
  PICKUP_CHANGED: 'Pickup date changed.',
  REMINDER_WINDOW_CLOSED: 'The reminder window has closed.',
  REFUND_UNKNOWN: 'Refund eligibility is unverified.',
  REFUND_PENDING: 'Refund pending.',
  REFUND_PARTIAL: 'Partially refunded.',
  REFUND_FULL: 'Fully refunded.',
  FULFILLMENT_NOT_ELIGIBLE: 'Order no longer awaits pickup.',
  SMS_CONSENT_UNVERIFIED: 'SMS consent provenance is unverified.',
  SMS_SUPPRESSION_UNVERIFIED: 'Current opt-out verification is unavailable.',
  SMS_OPTED_OUT: 'Customer opted out of SMS.',
  PROVIDER_REJECTED: 'Provider rejected the message.',
  DELIVERY_ACKNOWLEDGEMENT_UNKNOWN:
    'Provider acknowledgement is unknown. Do not resend without reconciliation.',
  ELIGIBILITY_CHECK_FAILED: 'Eligibility could not be verified.',
  RETRY_LIMIT: 'Retry limit reached.',
};
export function NotificationRows({ data }: { data: NotificationSummary }) {
  return (
    <>
      <p>
        Confirmation SMS: not configured. Provider acceptance does not confirm
        customer receipt.
      </p>
      {(
        [
          'CONFIRMATION',
          'REMINDER',
          'ACCESS',
          'PICKUP_CHANGE',
          'REQUEST',
        ] as const
      ).map((kind) => (
        <div key={kind}>
          <h4>
            {kind === 'REQUEST'
              ? 'Cancellation or assistance request'
              : kind === 'CONFIRMATION'
                ? 'Order confirmation'
                : kind === 'ACCESS'
                  ? 'Replacement order link'
                  : kind === 'PICKUP_CHANGE'
                    ? 'Pickup change'
                    : 'Pickup reminder'}
          </h4>
          {(['email', 'sms'] as const)
            .filter((channel) => kind === 'REMINDER' || channel === 'email')
            .map((channel) => {
              const rows = data.notifications.filter(
                (n) => n.kind === kind && n.channel === channel,
              );
              return (
                <div key={channel}>
                  <strong>{channel === 'email' ? 'Email' : 'SMS'}</strong>
                  {rows.length ? (
                    rows.map((n) => (
                      <p key={n.key}>
                        {labels[n.status] ?? 'Unknown status'}
                        {kind === 'REMINDER' ? ` · Pickup ${n.pickupDate}` : ''}
                        {n.reason && (
                          <>
                            <br />
                            {reasons[n.reason] ??
                              'Review eligibility or delivery configuration.'}
                          </>
                        )}
                        {n.sentAt && (
                          <>
                            <br />
                            Accepted{' '}
                            {new Intl.DateTimeFormat('en-US', {
                              timeZone: 'America/Denver',
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }).format(new Date(n.sentAt))}{' '}
                            Denver
                          </>
                        )}
                      </p>
                    ))
                  ) : (
                    <p>Not recorded — no delivery is implied.</p>
                  )}
                </div>
              );
            })}
        </div>
      ))}
      {data.truncated && (
        <p role="status">
          Only the first 50 operations are shown. Older or additional records
          require operator review.
        </p>
      )}
    </>
  );
}
export function NotificationStatus({ orderId }: { orderId: string }) {
  const [data, setData] = useState<NotificationSummary | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    setData(null);
    try {
      const r = await fetch(
        `/api/admin/orders/${encodeURIComponent(orderId)}/notifications`,
        { cache: 'no-store' },
      );
      if (r.status === 401 || r.status === 403) {
        window.location.replace('/admin/login?reason=expired');
        return;
      }
      if (!r.ok) throw Error('Notification status is unavailable. Try again.');
      setData(await r.json());
    } catch {
      setError('Notification status is unavailable. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Customer notifications">
      <h3>Customer notifications</h3>
      <p>
        Transactional messages only. Live sending remains disabled pending
        release approval.
      </p>
      <button type="button" disabled={busy} onClick={load}>
        {busy
          ? 'Loading messages…'
          : data
            ? 'Refresh message status'
            : 'View message status'}
      </button>
      {error && <p role="alert">{error}</p>}
      {data && <NotificationRows data={data} />}
    </section>
  );
}
