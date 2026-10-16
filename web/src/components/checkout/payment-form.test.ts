import { beforeEach, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CheckoutSnapshot } from '../../lib/checkout/contract';

// Existing test runtime is Node-only. Exercise real form handlers and native HTML
// semantics with controlled hook state; this is not a browser/iframe certification.
const harness = vi.hoisted(() => ({
  index: 0,
  ready: true,
  loadError: false,
  stripeAvailable: true,
  elementsAvailable: true,
  valid: vi.fn(() => true),
  stripe: { createConfirmationToken: vi.fn() },
  elements: { submit: vi.fn() },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [
    harness.index === 2
      ? (harness.index++, harness.ready)
      : harness.index++ === 3
        ? harness.loadError
        : initial,
    vi.fn(),
  ],
  useRef: (initial: unknown) => ({
    current: initial === null ? { reportValidity: harness.valid } : initial,
  }),
  useEffect: vi.fn(),
}));
vi.mock('@stripe/react-stripe-js', () => ({
  useStripe: () => (harness.stripeAvailable ? harness.stripe : null),
  useElements: () => (harness.elementsAvailable ? harness.elements : null),
  PaymentElement: () => null,
  ExpressCheckoutElement: () => null,
  Elements: () => null,
}));
import {
  ExpressCheckoutElement,
  PaymentElement,
} from '@stripe/react-stripe-js';
import { PaymentForm, ContactPickupFields, CheckoutReview } from './checkout';
const snapshot: CheckoutSnapshot = {
  cart: null,
  etag: null,
  payment: null,
  paymentEtag: null,
  serverNow: Date.now(),
  available: true,
  paymentSubmissionAllowed: false,
  summary: { currency: 'USD', subtotal: 525, tax: 0, fees: 0, total: 525 },
  drop: null,
};
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (node.type === ContactPickupFields)
    return [
      node,
      ...nodes(
        ContactPickupFields(
          node.props as Parameters<typeof ContactPickupFields>[0],
        ),
      ),
    ];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function form(
  allowed: boolean,
  refreshing = false,
  submitting = false,
  canPay = true,
) {
  harness.index = 0;
  const onSubmit = vi.fn().mockResolvedValue(true);
  const tree = PaymentForm({
    snapshot: { ...snapshot, paymentSubmissionAllowed: allowed },
    refreshing,
    submitting,
    canPay,
    canAct: true,
    onSubmit,
    onAction: vi.fn(),
  });
  const all = nodes(tree);
  return {
    tree,
    all,
    onSubmit,
    form: all.find((x) => x.type === 'form')!,
    pay: all.find((x) => x.type === 'button' && x.props.type === 'submit')!,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.index = 0;
  harness.ready = true;
  harness.loadError = false;
  harness.stripeAvailable = true;
  harness.elementsAvailable = true;
});
it('locked Pay uses native disabled semantics and an associated visible explanation, without fake loading', () => {
  const f = form(false, true);
  expect(f.pay.props.disabled).toBe(true);
  expect(f.pay.props['aria-describedby']).toBe('checkout-payment-unavailable');
  const html = renderToStaticMarkup(f.tree);
  expect(html).toContain('Payments are temporarily unavailable.');
  expect(html).toContain('id="checkout-payment-unavailable"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
  expect(html).not.toContain('Checking payment');
  expect(html).not.toMatch(/CHECKOUT_SUBMISSION_MODE|PAYMENT_START_ENABLED/);
});
it.each(['keyboard', 'pointer'])(
  'locked %s activation cannot pass the form handler even if a submit event is synthesized',
  async () => {
    const f = form(false),
      preventDefault = vi.fn();
    (f.form.props.onSubmit as (e: { preventDefault: () => void }) => void)({
      preventDefault,
    });
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalled();
    expect(f.onSubmit).not.toHaveBeenCalled();
    expect(harness.valid).not.toHaveBeenCalled();
    expect(harness.elements.submit).not.toHaveBeenCalled();
    expect(harness.stripe.createConfirmationToken).not.toHaveBeenCalled();
  },
);
it('locked mode retains Payment Element but does not mount interactive Express Checkout', () => {
  const f = form(false);
  expect(f.all.some((x) => x.type === PaymentElement)).toBe(true);
  expect(f.all.some((x) => x.type === ExpressCheckoutElement)).toBe(false);
});
it('enabled mode retains mocked Pay submission and native validation before delegation', async () => {
  const f = form(true);
  expect(f.pay.props.disabled).toBe(false);
  (f.form.props.onSubmit as (e: { preventDefault: () => void }) => void)({
    preventDefault: vi.fn(),
  });
  await Promise.resolve();
  expect(harness.valid).toHaveBeenCalledOnce();
  expect(f.onSubmit).toHaveBeenCalledOnce();
});
it('enabled Express Checkout retains validation, resolution and confirmation delegation', async () => {
  const f = form(true),
    express = f.all.find((x) => x.type === ExpressCheckoutElement)!;
  const resolve = vi.fn();
  (express.props.onClick as (e: { resolve: () => void }) => void)({ resolve });
  expect(resolve).toHaveBeenCalledOnce();
  await (
    express.props.onConfirm as (e: {
      paymentFailed: () => void;
    }) => Promise<void>
  )({ paymentFailed: vi.fn() });
  expect(f.onSubmit).toHaveBeenCalledOnce();
});
it('native invalid-field focus/reportValidity prevents enabled delegation', async () => {
  harness.valid.mockReturnValueOnce(false);
  const f = form(true);
  (f.form.props.onSubmit as (e: { preventDefault: () => void }) => void)({
    preventDefault: vi.fn(),
  });
  await Promise.resolve();
  expect(f.onSubmit).not.toHaveBeenCalled();
});
it('background reads preserve contact/pickup/consent focusability; only submission disables the fieldset', () => {
  expect(
    form(false, true).all.find((x) => x.type === 'fieldset')!.props.disabled,
  ).toBe(false);
  expect(
    form(true, true, true).all.find((x) => x.type === 'fieldset')!.props
      .disabled,
  ).toBe(true);
  const controls = form(false).all.filter(
    (x) => x.type === 'input' || x.type === 'select',
  );
  expect(controls.map((x) => x.props.id || x.props.type)).toEqual([
    'checkout-name',
    'checkout-email',
    'checkout-phone',
    'checkout-pickup',
    'checkbox',
  ]);
  expect(controls.every((x) => x.props.tabIndex === undefined)).toBe(true);
  expect(controls.at(-1)!.props.checked).toBe(false);
  expect(controls.at(-1)!.props.required).toBeUndefined();
  expect(controls[2].props['aria-describedby']).toBe('phone-help');
});

it('associates the fixed U.S. country context and formatting help with the phone field', () => {
  const html = renderToStaticMarkup(form(false).tree);
  expect(html).toContain('Mobile phone — United States (+1)');
  expect(html).toContain('for="checkout-phone"');
  expect(html).toContain('aria-describedby="phone-help"');
  expect(html).toContain('Enter a 10-digit U.S. phone number.');
  expect(html).toContain('<span aria-hidden="true">+1</span>');
  expect(html).toContain('inputMode="numeric"');
  expect(html).toContain('autoComplete="tel-national"');
});
it('phone field reports unsupported prefixes and clears validity after correction', () => {
  const phone = form(false).all.find((x) => x.props.id === 'checkout-phone')!;
  const setCustomValidity = vi.fn();
  const change = phone.props.onChange as (event: {
    currentTarget: {
      value: string;
      setCustomValidity: typeof setCustomValidity;
    };
  }) => void;
  change({ currentTarget: { value: '+443035550123', setCustomValidity } });
  expect(setCustomValidity).toHaveBeenLastCalledWith(
    'Only U.S. phone numbers with country code +1 are supported.',
  );
  change({ currentTarget: { value: '(303) 555-0123', setCustomValidity } });
  expect(setCustomValidity).toHaveBeenLastCalledWith('');
});

it.each(['(303) 555-0123', '303-555-0123', '+1 303 555 0123', '3035550123'])(
  'paste %s leaves exactly ten visible digits',
  (value) => {
    const phone = form(false).all.find((x) => x.props.id === 'checkout-phone')!;
    const input = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      setCustomValidity: vi.fn(),
    };
    const preventDefault = vi.fn();
    (phone.props.onPaste as (e: unknown) => void)({
      currentTarget: input,
      preventDefault,
      clipboardData: { getData: () => value },
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input.value).toBe('3035550123');
    expect(input.setCustomValidity).toHaveBeenLastCalledWith('');
  },
);
it.each(['30355501234', 'abc3035550123', '+443035550123'])(
  'rejects paste %s without truncation or reinterpretation',
  (value) => {
    const phone = form(false).all.find((x) => x.props.id === 'checkout-phone')!;
    const input = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      setCustomValidity: vi.fn(),
    };
    (phone.props.onPaste as (e: unknown) => void)({
      currentTarget: input,
      preventDefault: vi.fn(),
      clipboardData: { getData: () => value },
    });
    expect(input.value).toBe('');
    expect(input.setCustomValidity).toHaveBeenCalledWith(expect.any(String));
    expect(input.setCustomValidity).not.toHaveBeenCalledWith('');
  },
);

it('background refresh leaves eligible Pay enabled and delegates activation', async () => {
  const f = form(true, true);
  expect(f.pay.props.disabled).toBe(false);
  expect(f.pay.props.tabIndex).toBeUndefined();
  expect(renderToStaticMarkup(f.tree)).not.toContain('Checking payment');
  (f.form.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
  await Promise.resolve();
  expect(f.onSubmit).toHaveBeenCalledOnce();
});
it('submission disables Pay and rejects form and Express activation', async () => {
  const f = form(true, false, true);
  expect(f.pay.props.disabled).toBe(true);
  (f.form.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
  const express = f.all.find((x) => x.type === ExpressCheckoutElement)!;
  const resolve = vi.fn();
  (express.props.onClick as (e: unknown) => void)({ resolve });
  await (express.props.onConfirm as (e: unknown) => Promise<void>)({
    paymentFailed: vi.fn(),
  });
  expect(resolve).not.toHaveBeenCalled();
  expect(f.onSubmit).not.toHaveBeenCalled();
});
it('duplicate activation cannot delegate twice while submission is pending', async () => {
  const f = form(true, true);
  let finish!: (value: boolean) => void;
  f.onSubmit.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const submit = f.form.props.onSubmit as (e: unknown) => void;
  submit({ preventDefault: vi.fn() });
  submit({ preventDefault: vi.fn() });
  expect(f.onSubmit).toHaveBeenCalledOnce();
  finish(true);
  await Promise.resolve();
});
it.each(['stripe', 'elements', 'ready', 'loadError', 'checkout'])(
  'hard blocker %s disables Pay and rejects activation',
  async (blocker) => {
    harness.stripeAvailable = blocker !== 'stripe';
    harness.elementsAvailable = blocker !== 'elements';
    harness.ready = blocker !== 'ready';
    harness.loadError = blocker === 'loadError';
    const f = form(true, false, false, blocker !== 'checkout');
    expect(f.pay.props.disabled).toBe(true);
    (f.form.props.onSubmit as (e: unknown) => void)({
      preventDefault: vi.fn(),
    });
    await Promise.resolve();
    expect(f.onSubmit).not.toHaveBeenCalled();
  },
);

it('locked checkout review has labeled contact and pickup fields without a payment form or provider', () => {
  const tree = CheckoutReview({ snapshot });
  const all = nodes(tree);
  expect(all.filter((n) => n.type === 'input')).toHaveLength(4);
  expect(all.some((n) => n.type === 'select')).toBe(true);
  expect(
    all.some(
      (n) =>
        n.type === 'form' ||
        n.type === PaymentElement ||
        n.type === ExpressCheckoutElement,
    ),
  ).toBe(false);
  expect(all.find((n) => n.type === 'button')?.props.disabled).toBe(true);
  expect(renderToStaticMarkup(tree)).toContain('Nothing is submitted or saved');
});
