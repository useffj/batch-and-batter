import { customer, requireValue, startRequest, ORIGIN } from './contract.mjs';
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
