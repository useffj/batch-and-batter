import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { CheckoutSnapshot } from '../../lib/checkout/contract';

// Exercise the real Checkout refresh/action handlers in the existing Node runtime.
// Persistent hook slots model rerenders; physical Chrome verifies DOM focus/identity.
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  mounted: false,
  effects: [] as (() => (() => void) | void)[],
  restore: vi.fn(),
  submit: vi.fn(),
  authenticate: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const i = h.stateIndex++;
    if (!(i in h.states)) h.states[i] = initial;
    return [
      h.states[i],
      (value: unknown) => {
        h.states[i] = value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.refIndex++;
    return (h.refs[i] ??= { current: initial });
  },
  useEffect: (effect: () => (() => void) | void) => {
    if (!h.mounted) h.effects.push(effect);
  },
}));
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn().mockResolvedValue(null),
}));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: () => null,
  PaymentElement: () => null,
  ExpressCheckoutElement: () => null,
  useStripe: vi.fn(),
  useElements: vi.fn(),
}));
vi.mock('../../lib/checkout/client', async (original) => ({
  ...(await original<typeof import('../../lib/checkout/client')>()),
  CheckoutClient: class {
    restore = h.restore;
    submit = h.submit;
    authenticate = h.authenticate;
  },
}));
import { Checkout, PaymentForm } from './checkout';
const snapshot = {
  cart: {
    cartId: 'cart',
    shoppingExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    items: [],
  },
  payment: null,
  serverNow: Date.now(),
  available: true,
  paymentSubmissionAllowed: true,
  summary: { currency: 'USD', subtotal: 525, tax: 0, fees: 0, total: 525 },
  drop: null,
} as unknown as CheckoutSnapshot;
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function render() {
  h.stateIndex = h.refIndex = 0;
  return nodes(Checkout({ publishableKey: 'pk_test_fixture' }));
}
function form() {
  return render().find((x) => x.type === PaymentForm)!.props;
}
function pending() {
  let resolve!: (value: CheckoutSnapshot) => void;
  const promise = new Promise<CheckoutSnapshot>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let cleanup: (() => void) | void;
let win: EventTarget;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.states = [];
  h.refs = [];
  h.effects = [];
  h.mounted = false;
  win = new EventTarget();
  Object.assign(win, { localStorage: null });
  vi.stubGlobal('window', win);
  const doc = new EventTarget();
  Object.assign(doc, { visibilityState: 'visible' });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { locks: null });
  vi.stubGlobal('BroadcastChannel', undefined);
  h.restore.mockResolvedValue(snapshot);
  h.submit.mockResolvedValue(snapshot);
  h.authenticate.mockResolvedValue(snapshot);
  render();
  h.mounted = true;
  cleanup = h.effects[0]();
  await Promise.resolve();
  await Promise.resolve();
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each(['timer', 'focus'])(
  '%s refresh changes only refresh state, retaining the form and eligibility',
  async (trigger) => {
    const before = form();
    const read = pending();
    h.restore.mockReturnValueOnce(read.promise);
    if (trigger === 'timer') vi.advanceTimersByTime(5000);
    else win.dispatchEvent(new Event('focus'));
    const during = form();
    expect(during.refreshing).toBe(true);
    expect(during.submitting).toBe(false);
    expect(during.canPay).toBe(true);
    expect(during.snapshot).toBe(before.snapshot);
    const status = render().find((x) => x.type === 'button')!;
    expect(status.props.disabled).toBe(false);
    expect(status.props['aria-busy']).toBe(true);
    read.resolve(snapshot);
    await Promise.resolve();
    await Promise.resolve();
    expect(form().refreshing).toBe(false);
  },
);
it('activation waits for refresh, locks immediately, blocks duplicates and suppresses competing reads', async () => {
  const read = pending(),
    action = pending();
  h.restore.mockReturnValueOnce(read.promise);
  h.submit.mockReturnValueOnce(action.promise);
  win.dispatchEvent(new Event('focus'));
  const submit = form().onSubmit as (...args: unknown[]) => Promise<boolean>;
  const first = submit({}, '', {}, {});
  expect(form().submitting).toBe(true);
  expect(h.submit).not.toHaveBeenCalled();
  expect(await submit({}, '', {}, {})).toBe(false);
  win.dispatchEvent(new Event('focus'));
  vi.advanceTimersByTime(5000);
  expect(h.restore).toHaveBeenCalledTimes(2);
  read.resolve(snapshot);
  await Promise.resolve();
  await Promise.resolve();
  expect(h.submit).toHaveBeenCalledOnce();
  expect(form().submitting).toBe(true);
  action.resolve(snapshot);
  expect(await first).toBe(true);
  expect(form().submitting).toBe(false);
});
it('existing-payment recovery uses the same serialized action path while submission is locked', async () => {
  const payment = {
    ...snapshot,
    paymentSubmissionAllowed: false,
    payment: { status: 'action_required' },
  } as CheckoutSnapshot;
  const read = pending();
  h.restore.mockReturnValueOnce(read.promise);
  win.dispatchEvent(new Event('focus'));
  const authenticate = form().onAction as (stripe: unknown) => Promise<boolean>;
  const stripe = {};
  const result = authenticate(stripe);
  expect(h.authenticate).not.toHaveBeenCalled();
  read.resolve(payment);
  await result;
  expect(h.authenticate).toHaveBeenCalledExactlyOnceWith(stripe);
  expect(h.submit).not.toHaveBeenCalled();
});
