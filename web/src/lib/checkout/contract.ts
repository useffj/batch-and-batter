import { ETAG, identifier, record, type Cart } from '../cart/contract';
import type { StorefrontDrop } from '../storefront/client';
export interface Customer {
  name: string;
  email: string;
  phone: string;
  smsTransactionalConsent: boolean;
}
export interface Start {
  confirmationTokenId: string;
  pickupDate: string;
  customer: Customer;
}
// Matches the current backend Zod default email expression; backend remains validator.
export const EMAIL =
  /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
export const PHONE = /^\+[1-9]\d{7,14}$/;
export function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('Invalid checkout data');
}
export function customer(value: unknown): Customer {
  const c = record(value);
  exact(c, ['name', 'email', 'phone', 'smsTransactionalConsent']);
  if (
    typeof c.name !== 'string' ||
    !c.name.trim() ||
    c.name.trim().length > 200 ||
    typeof c.email !== 'string' ||
    c.email.length > 254 ||
    !EMAIL.test(c.email) ||
    typeof c.phone !== 'string' ||
    !PHONE.test(c.phone) ||
    typeof c.smsTransactionalConsent !== 'boolean'
  )
    throw new Error('Check your contact information.');
  return {
    name: c.name.trim(),
    email: c.email,
    phone: c.phone,
    smsTransactionalConsent: c.smsTransactionalConsent,
  };
}
export function date(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error('Choose an available pickup date.');
  return value;
}
export function startBody(value: unknown): Start {
  const b = record(value);
  exact(b, ['confirmationTokenId', 'pickupDate', 'customer']);
  if (
    typeof b.confirmationTokenId !== 'string' ||
    b.confirmationTokenId.length > 255 ||
    !/^ctoken_[a-zA-Z0-9]+$/.test(b.confirmationTokenId)
  )
    throw new Error('Invalid checkout data');
  return {
    confirmationTokenId: b.confirmationTokenId,
    pickupDate: date(b.pickupDate),
    customer: customer(b.customer),
  };
}
export function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('Invalid checkout data');
  return value;
}
export interface Payment {
  orderId: string;
  paymentAttemptId: string;
  status:
    | 'payment_pending'
    | 'processing'
    | 'action_required'
    | 'paid'
    | 'failed'
    | 'expired'
    | 'cancelled';
  paymentDeadline: string;
  continuationGeneration: number;
  clientSecret?: string;
}
export function payment(value: unknown): Payment {
  const p = record(value);
  if (
    ![
      'payment_pending',
      'processing',
      'action_required',
      'paid',
      'failed',
      'expired',
      'cancelled',
    ].includes(String(p.status)) ||
    !Number.isInteger(p.continuationGeneration) ||
    Number(p.continuationGeneration) < 0 ||
    Number(p.continuationGeneration) > 7
  )
    throw new Error('Invalid payment data');
  const result: Payment = {
    orderId: identifier(p.orderId),
    paymentAttemptId: identifier(p.paymentAttemptId),
    status: p.status as Payment['status'],
    paymentDeadline: timestamp(p.paymentDeadline),
    continuationGeneration: Number(p.continuationGeneration),
  };
  if (result.status === 'action_required' && p.clientSecret !== undefined) {
    if (
      typeof p.clientSecret !== 'string' ||
      !/^pi_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+$/.test(p.clientSecret) ||
      p.clientSecret.length > 512
    )
      throw new Error('Invalid payment data');
    result.clientSecret = p.clientSecret;
  }
  return result;
}
export interface Summary {
  currency: 'USD';
  subtotal: number;
  tax: 0;
  fees: 0;
  total: number;
}
export interface CheckoutSnapshot {
  cart: Cart | null;
  etag: string | null;
  payment: Payment | null;
  paymentEtag: string | null;
  serverNow: number;
  available: boolean;
  paymentSubmissionAllowed: boolean;
  summary: Summary | null;
  drop: StorefrontDrop | null;
}
export function revision(value: unknown): string {
  if (typeof value !== 'string' || !ETAG.test(value))
    throw new Error('Invalid revision');
  return value;
}
export function pickupAllowed(
  p: StorefrontDrop['pickupDates'][number],
  now: number,
) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: p.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return (
    `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}` <
    `${p.date}T${p.endTime}`
  );
}
export const paymentMessages: Record<Payment['status'], string> = {
  payment_pending: 'Your payment has started. We’re checking its progress.',
  processing:
    'Your payment is processing. Please do not submit another payment. Your reservation remains under payment review.',
  action_required:
    'Your bank needs you to complete authentication for this payment.',
  paid: 'Payment confirmed. Thank you for your order!',
  failed:
    'Your payment was declined or could not be completed. This attempt has ended.',
  expired:
    'This payment attempt expired. You can return to the store to check availability.',
  cancelled:
    'This payment attempt was cancelled. You can return to the store to check availability.',
};
export const terminal = (p: Payment) =>
  ['paid', 'failed', 'expired', 'cancelled'].includes(p.status);
export const recoveryMessage =
  'We cannot confirm the result yet. Check payment status before doing anything else. Do not submit another payment.';
