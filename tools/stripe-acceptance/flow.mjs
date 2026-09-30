import { customer, requireValue, startRequest, ORIGIN } from './contract.mjs';
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
    try {
      if (!pending) {
        customer(input.customer);
        requireValue(cart.pickups.some((p) => p.date === input.pickupDate));
        requireValue(Date.parse(cart.shoppingExpiresAt) > Date.now());
        const submitted = await elements.submit();
        if (submitted.error)
          return 'Payment Element validation failed. Check the sandbox details.';
        const result = await stripe.createConfirmationToken({
          elements,
          params: { return_url: ORIGIN + '/' },
        });
        if (result.error || !result.confirmationToken)
          return 'Stripe could not prepare the sandbox payment.';
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
      const result = await send(pending);
      if (result.accepted) {
        completed = true;
        pending = undefined;
        capability = '';
        return 'Payment start accepted; this is NOT proof of payment. Use the reviewed payment-status procedure.';
      }
      return 'Start not confirmed. Retry sends the identical request. Do not create another Cart/payment attempt.';
    } catch {
      return pending
        ? 'Outcome unknown. Retry sends the identical request; do not restart this session.'
        : 'Unable to prepare payment. Check the setup; no start was sent.';
    } finally {
      busy = false;
    }
  };
}
