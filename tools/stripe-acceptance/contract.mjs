// Local acceptance display contract; never a financial authority.
export const API = 'https://7otpu9y03a.execute-api.us-east-2.amazonaws.com';
export const ORIGIN = 'http://127.0.0.1:4242';
export const STRIPE_JS = 'https://js.stripe.com/dahlia/stripe.js';
const id = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export function requireValue(ok) {
  if (!ok) throw new Error('Invalid acceptance setup.');
}
export function exact(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  requireValue(
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
  );
}
export function setup(value) {
  exact(value, ['cartId', 'capability']);
  requireValue(id.test(value.cartId));
  // 32 bytes, canonical unpadded base64url.
  requireValue(
    typeof value.capability === 'string' &&
      /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.capability),
  );
  return value;
}
export function customer(value) {
  exact(value, ['name', 'email', 'phone', 'smsTransactionalConsent']);
  requireValue(
    typeof value.name === 'string' &&
      value.name.trim().length > 0 &&
      value.name.length <= 200,
  );
  requireValue(
    typeof value.email === 'string' &&
      value.email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email),
  );
  requireValue(
    typeof value.phone === 'string' && /^\+[1-9]\d{7,14}$/.test(value.phone),
  );
  requireValue(typeof value.smsTransactionalConsent === 'boolean');
  return value;
}
export function startRequest(value) {
  exact(value, ['cartId', 'capability', 'etag', 'key', 'body']);
  setup({ cartId: value.cartId, capability: value.capability });
  requireValue(/^"[a-f0-9]{64}"$/.test(value.etag));
  requireValue(
    /^v1\.\d{13}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.key),
  );
  exact(value.body, ['confirmationTokenId', 'pickupDate', 'customer']);
  requireValue(
    /^ctoken_[A-Za-z0-9]{1,200}$/.test(value.body.confirmationTokenId),
  );
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(value.body.pickupDate));
  customer(value.body.customer);
  return value;
}
export function preview(body, etag, requestedCart, now = Date.now()) {
  const c = body?.cart;
  requireValue(c && c.cartId === requestedCart && id.test(c.dropId));
  requireValue(
    c.status === 'ACTIVE' &&
      body.expired !== true &&
      Date.parse(c.shoppingExpiresAt) > now,
  );
  requireValue(/^"[a-f0-9]{64}"$/.test(etag));
  requireValue(
    Array.isArray(c.items) && c.items.length > 0 && c.items.length <= 12,
  );
  let amount = 0;
  const items = c.items.map((i) => {
    requireValue(
      id.test(i.productId) &&
        Number.isSafeInteger(i.quantity) &&
        i.quantity > 0 &&
        Number.isSafeInteger(i.priceCents) &&
        i.priceCents > 0,
    );
    amount += i.quantity * i.priceCents;
    requireValue(Number.isSafeInteger(amount));
    return {
      productId: i.productId,
      quantity: i.quantity,
      priceCents: i.priceCents,
    };
  });
  requireValue(amount >= 50 && amount <= 99999999);
  return {
    cartId: c.cartId,
    dropId: c.dropId,
    etag,
    items,
    amount,
    currency: 'usd',
    shoppingExpiresAt: c.shoppingExpiresAt,
  };
}
export function elementsOptions(cart) {
  return {
    mode: 'payment',
    amount: cart.amount,
    currency: cart.currency,
    captureMethod: 'manual',
    paymentMethodTypes: ['card'],
    paymentMethodCreation: 'manual',
  };
}
