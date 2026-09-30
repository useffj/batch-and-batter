import { setup, elementsOptions } from './contract.mjs';
import { createFlow, createContinuation, diagnostic } from './flow.mjs';
const el = (id) => document.getElementById(id);
const status = (text) => {
  el('status').textContent = text;
};
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Acceptance-Client': 'loopback',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
  });
  if (['/start', '/confirm'].includes(path) && !response.ok) {
    // Only fixed relay protocol fields are consumed; never render raw bodies.
    const result = await response.json();
    return { accepted: false, sent: result.sent === 'no' ? 'no' : 'ambiguous' };
  }
  if (!response.ok) throw new Error('Local request rejected.');
  return response.json();
}
let pay;
let loaded = false;
let busy = false;
let allowStart = false;
let stripe;
try {
  const config = await (await fetch('/config', { cache: 'no-store' })).json();
  allowStart = config.allowStart === true;
  stripe = window.Stripe(config.publishableKey);
  status(
    allowStart
      ? 'Local submission unlocked. Separate DEV admission approval is still required.'
      : 'Local payment submission disabled. No ConfirmationToken will be created.',
  );
} catch {
  status(diagnostic('HARNESS_SETUP_INVALID'));
}
el('setup').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loaded || busy || !stripe) return;
  busy = true;
  try {
    const input = setup({
      cartId: el('cart').value.trim(),
      capability: el('capability').value,
    });
    const cart = await post('/cart', input);
    const elements = stripe.elements(elementsOptions(cart));
    elements.create('payment').mount('#payment-element');
    pay = createFlow({
      stripe,
      elements,
      cart,
      capability: input.capability,
      send: (body) => post('/start', body),
      continuePayment: createContinuation({
        stripe,
        cartId: cart.cartId,
        capability: input.capability,
        getStatus: (body) => post('/payment', body),
        sendConfirm: (body) => post('/confirm', body),
        onStatus: status,
      }),
    });
    el('capability').value = '';
    el('setup').hidden = true;
    el('summary').textContent =
      `Cart ${cart.cartId}\n${cart.items.map((i) => `${i.productId}: ${i.quantity} × ${i.priceCents} cents`).join('\n')}\nUSD ${(cart.amount / 100).toFixed(2)} (dev zero tax/fee fixture)\nReservation expires ${cart.shoppingExpiresAt}`;
    for (const p of cart.pickups) {
      const option = document.createElement('option');
      option.value = p.date;
      option.textContent = `${p.date} ${p.startTime}–${p.endTime} ${p.timezone}`;
      el('pickup').append(option);
    }
    el('checkout').hidden = false;
    el('pay').disabled = !allowStart;
    loaded = true;
  } catch {
    el('capability').value = '';
    status(diagnostic('HARNESS_SETUP_INVALID'));
  } finally {
    busy = false;
  }
});
el('checkout').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!allowStart || busy || !pay) return;
  busy = true;
  el('pay').disabled = true;
  try {
    status(
      await pay({
        pickupDate: el('pickup').value,
        customer: {
          name: el('name').value,
          email: el('email').value,
          phone: el('phone').value,
          smsTransactionalConsent: el('consent').checked,
        },
      }),
    );
  } finally {
    busy = false;
    el('pay').disabled = !allowStart;
  }
});
