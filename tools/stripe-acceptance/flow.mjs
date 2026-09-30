import {
  customer,
  requireValue,
  startRequest,
  confirmRequest,
  ORIGIN,
} from './contract.mjs';
const descriptions = {
  HARNESS_CONTACT_INVALID: 'Contact fixture is invalid.',
  HARNESS_PICKUP_INVALID: 'Pickup selection is invalid.',
  HARNESS_CART_EXPIRED: 'Cart is expired or its deadline is invalid.',
  HARNESS_ELEMENTS_SUBMIT_FAILED: 'Payment Element preparation failed.',
  HARNESS_CONFIRMATION_TOKEN_FAILED: 'Stripe token preparation failed.',
  HARNESS_START_REQUEST_REJECTED: 'Start request was rejected.',
  HARNESS_START_REQUEST_AMBIGUOUS:
    'Start may have been sent; preserve this session.',
  HARNESS_SETUP_INVALID: 'Local setup is invalid.',
  HARNESS_NEXT_ACTION_UNAVAILABLE: 'Authentication could not be initiated.',
  HARNESS_AUTHENTICATION_FAILED:
    'Authentication did not complete successfully.',
  HARNESS_CONFIRM_REQUEST_REJECTED:
    'Continuation was rejected; use reviewed status verification.',
  HARNESS_CONFIRM_REQUEST_AMBIGUOUS:
    'Continuation may have been accepted; preserve this session.',
  HARNESS_PAYMENT_DEADLINE_ELAPSED:
    'Payment deadline elapsed; backend reconciliation remains responsible.',
  HARNESS_PAYMENT_PROCESSING:
    'Backend is still processing; this is not proof of payment.',
  HARNESS_PAYMENT_STATUS_UNAVAILABLE: 'Payment status could not be verified.',
  HARNESS_ACTION_INCOMPLETE:
    'Customer action remains incomplete; stop for review.',
  HARNESS_PAYMENT_TERMINAL_FAILURE:
    'Backend reports a terminal unsuccessful payment.',
};
export function diagnostic(code, sent = 'no') {
  if (!Object.hasOwn(descriptions, code)) code = 'HARNESS_SETUP_INVALID';
  if (!['yes', 'no', 'ambiguous'].includes(sent)) sent = 'ambiguous';
  return `${code}: ${descriptions[code]} payment/start sent: ${sent}.`;
}
export function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const value = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `v1.${Date.now()}.${value}`;
}
// One token and one immutable start request per session. Ambiguous responses can
// only replay that exact request; never allocate a new financial command.
export function createFlow({
  stripe,
  elements,
  cart,
  capability,
  send,
  key = newKey,
  continuePayment,
}) {
  let busy = false;
  let pending;
  let completed = false;
  return async function pay(input) {
    if (busy || completed) return 'Submission already in progress or accepted.';
    busy = true;
    let stage = 'HARNESS_SETUP_INVALID';
    let sending = false;
    try {
      if (!pending) {
        stage = 'HARNESS_CONTACT_INVALID';
        customer(input.customer);
        stage = 'HARNESS_PICKUP_INVALID';
        requireValue(cart.pickups.some((p) => p.date === input.pickupDate));
        stage = 'HARNESS_CART_EXPIRED';
        requireValue(Date.parse(cart.shoppingExpiresAt) > Date.now());
        stage = 'HARNESS_ELEMENTS_SUBMIT_FAILED';
        const submitted = await elements.submit();
        if (submitted.error) return diagnostic(stage);
        stage = 'HARNESS_CONFIRMATION_TOKEN_FAILED';
        const result = await stripe.createConfirmationToken({
          elements,
          params: { return_url: ORIGIN + '/' },
        });
        if (result.error || !result.confirmationToken) return diagnostic(stage);
        stage = 'HARNESS_START_REQUEST_REJECTED';
        pending = startRequest({
          cartId: cart.cartId,
          capability,
          etag: cart.etag,
          key: key(),
          body: {
            confirmationTokenId: result.confirmationToken.id,
            pickupDate: input.pickupDate,
            customer: { ...input.customer },
          },
        });
      }
      sending = true;
      const result = await send(pending);
      if (result?.sent === 'no')
        return diagnostic('HARNESS_START_REQUEST_REJECTED');
      if (result?.sent === 'yes' && result?.ambiguous === true)
        return diagnostic('HARNESS_START_REQUEST_AMBIGUOUS', 'yes');
      if (result?.sent === 'ambiguous')
        return diagnostic('HARNESS_START_REQUEST_AMBIGUOUS', 'ambiguous');
      if (result.accepted) {
        completed = true;
        pending = undefined;
        if (continuePayment) {
          try {
            return await continuePayment();
          } finally {
            capability = '';
          }
        }
        capability = '';
        return 'Payment start accepted; this is NOT proof of payment. Use the reviewed payment-status procedure.';
      }
      return result?.sent === 'yes'
        ? diagnostic('HARNESS_START_REQUEST_REJECTED', 'yes')
        : diagnostic('HARNESS_START_REQUEST_AMBIGUOUS', 'ambiguous');
    } catch {
      return sending
        ? diagnostic('HARNESS_START_REQUEST_AMBIGUOUS', 'ambiguous')
        : diagnostic(stage);
    } finally {
      busy = false;
    }
  };
}

// Accepted start only. No new token, Cart, provider confirmation, or automatic
// continuation replay. All sensitive state lives only in the current tab.
export function createContinuation({
  stripe,
  cartId,
  capability,
  getStatus,
  sendConfirm,
  key = newKey,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 30,
  onStatus = () => {},
}) {
  let entered = false;
  const notice =
    ' Payment start already accepted. Never create another Cart or token after an ambiguous outcome. Keep this tab open.';
  const report = (code) => diagnostic(code, 'yes') + notice;
  return async () => {
    if (entered) return report('HARNESS_PAYMENT_PROCESSING');
    entered = true;
    let stage = 'HARNESS_PAYMENT_STATUS_UNAVAILABLE';
    let confirmSending = false;
    try {
      onStatus(
        'Payment start already accepted; waiting for canonical status.' +
          notice,
      );
      let view;
      for (let i = 0; i < attempts; i++) {
        view = await getStatus({ cartId, capability });
        if (!['processing', 'payment_pending'].includes(view.status)) break;
        if (now() >= Date.parse(view.paymentDeadline))
          return report('HARNESS_PAYMENT_DEADLINE_ELAPSED');
        if (i + 1 < attempts) await sleep(1000);
      }
      if (view?.status === 'paid') return 'Backend reports paid.' + notice;
      if (['failed', 'expired', 'cancelled'].includes(view?.status))
        return report('HARNESS_PAYMENT_TERMINAL_FAILURE');
      if (view?.status !== 'action_required')
        return report('HARNESS_PAYMENT_PROCESSING');
      if (now() >= Date.parse(view.paymentDeadline))
        return report('HARNESS_PAYMENT_DEADLINE_ELAPSED');
      stage = 'HARNESS_NEXT_ACTION_UNAVAILABLE';
      requireValue(
        typeof stripe.handleNextAction === 'function' &&
          typeof view.clientSecret === 'string' &&
          view.clientSecret.length > 0,
      );
      onStatus(
        'Payment start already accepted; complete Stripe authentication.' +
          notice,
      );
      let action;
      try {
        action = await stripe.handleNextAction({
          clientSecret: view.clientSecret,
        });
      } finally {
        delete view.clientSecret;
      }
      stage = 'HARNESS_AUTHENTICATION_FAILED';
      if (!action || action.error) return report(stage);
      if (now() >= Date.parse(view.paymentDeadline))
        return report('HARNESS_PAYMENT_DEADLINE_ELAPSED');
      // Ignore browser PaymentIntent state. Refresh the backend ETag; a webhook
      // may already have advanced authorization, making continuation unnecessary.
      stage = 'HARNESS_PAYMENT_STATUS_UNAVAILABLE';
      const fresh = await getStatus({ cartId, capability });
      delete fresh.clientSecret;
      if (fresh.status === 'paid') return 'Backend reports paid.' + notice;
      if (['failed', 'expired', 'cancelled'].includes(fresh.status))
        return report('HARNESS_PAYMENT_TERMINAL_FAILURE');
      if (now() >= Date.parse(fresh.paymentDeadline))
        return report('HARNESS_PAYMENT_DEADLINE_ELAPSED');
      if (fresh.status !== 'action_required')
        return report('HARNESS_PAYMENT_PROCESSING');
      stage = 'HARNESS_CONFIRM_REQUEST_REJECTED';
      const request = confirmRequest({
        cartId,
        capability,
        etag: fresh.etag,
        key: key(),
        body: { continuationGeneration: fresh.continuationGeneration },
      });
      confirmSending = true;
      const result = await sendConfirm(request);
      confirmSending = false;
      if (result?.ambiguous || result?.sent === 'ambiguous')
        return report('HARNESS_CONFIRM_REQUEST_AMBIGUOUS');
      if (!result?.accepted) return report('HARNESS_CONFIRM_REQUEST_REJECTED');
      stage = 'HARNESS_PAYMENT_STATUS_UNAVAILABLE';
      const after = await getStatus({ cartId, capability });
      delete after.clientSecret;
      if (after.status === 'paid') return 'Backend reports paid.' + notice;
      if (['failed', 'expired', 'cancelled'].includes(after.status))
        return report('HARNESS_PAYMENT_TERMINAL_FAILURE');
      return report(
        after.status === 'action_required'
          ? 'HARNESS_ACTION_INCOMPLETE'
          : 'HARNESS_PAYMENT_PROCESSING',
      );
    } catch {
      return report(
        confirmSending ? 'HARNESS_CONFIRM_REQUEST_AMBIGUOUS' : stage,
      );
    } finally {
      capability = '';
    }
  };
}
