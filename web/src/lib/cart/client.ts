import {
  ETAG,
  messages,
  parseCart,
  record,
  type Operation,
  type Snapshot,
} from './contract';
export const LOCK = 'batch-and-batter-cart-v1';
export const unsupportedBrowserMessage =
  'This browser can display your Cart, but cannot safely update it. Please use a current browser to make changes.';
export class CartFailure extends Error {
  constructor(
    public code: string,
    public pending = false,
  ) {
    super(
      code === 'UNSUPPORTED_BROWSER'
        ? unsupportedBrowserMessage
        : Object.hasOwn(messages, code)
          ? messages[code as keyof typeof messages]
          : 'We cannot reach your Cart. Check your connection, then check or retry the saved change.',
    );
  }
}
export function parseSnapshot(value: unknown): Snapshot {
  const v = record(value);
  if (
    typeof v.pending !== 'boolean' ||
    typeof v.expired !== 'boolean' ||
    !Number.isFinite(v.serverNow) ||
    (v.etag !== null && (typeof v.etag !== 'string' || !ETAG.test(v.etag)))
  )
    throw new Error('Invalid response');
  const cart = v.cart === null ? null : parseCart(v.cart);
  if (cart && !v.etag) throw new Error('Invalid response');
  return {
    cart,
    pending: v.pending,
    expired: v.expired,
    etag: v.etag as string | null,
    serverNow: v.serverNow as number,
  };
}
export type Lock = <T>(work: () => Promise<T>) => Promise<T>;
export class CartClient {
  constructor(
    private lock: Lock | null,
    private request: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async call(path: string, body?: unknown) {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
      });
      const text = await response.text();
      if (
        text.length > 16384 ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw new Error();
      const value = record(JSON.parse(text));
      if (!response.ok)
        throw new CartFailure(
          typeof value.code === 'string' ? value.code : 'NETWORK',
          value.pending === true,
        );
      if (typeof value.serverNow === 'number')
        value.serverNow += performance.now() - started + 1000;
      return value;
    } catch (error) {
      if (error instanceof CartFailure) throw error;
      throw new CartFailure('NETWORK', body !== undefined);
    } finally {
      clearTimeout(timeout);
    }
  }
  private async read() {
    return parseSnapshot(await this.call('/api/cart'));
  }
  restore() {
    return this.lock ? this.lock(() => this.read()) : this.read();
  }
  retry() {
    if (!this.lock)
      return Promise.reject(new CartFailure('UNSUPPORTED_BROWSER'));
    return this.lock(async () => {
      const current = await this.read();
      if (!current.pending) return current;
      const committed = parseSnapshot(await this.call('/api/cart', {}));
      return committed.cart &&
        ['CANCELLED', 'EXPIRED'].includes(committed.cart.status)
        ? committed
        : this.read();
    });
  }
  change(op: Operation) {
    if (!this.lock)
      return Promise.reject(new CartFailure('UNSUPPORTED_BROWSER'));
    return this.lock(async () => {
      const current = await this.read();
      if (current.pending) throw new CartFailure('CART_BUSY', true);
      if (
        op.kind === 'create'
          ? !!current.cart
          : current.cart?.cartId !== op.cartId ||
            (op.kind === 'replace' && current.etag !== op.ifMatch)
      )
        throw new CartFailure('CART_CONFLICT');
      await this.call('/api/cart/session', op);
      // Cookie acknowledgment precedes execution; capability/key/body never regenerated here.
      const result = parseSnapshot(await this.call('/api/cart', {}));
      // Receipts are historical. Refresh before presenting an editable Cart.
      return result.cart &&
        ['CANCELLED', 'EXPIRED'].includes(result.cart.status)
        ? result
        : this.read();
    });
  }
}
export function remaining(snapshot: Snapshot, sampledAt: number, now: number) {
  if (!snapshot.cart) return 0;
  return Math.max(
    0,
    Date.parse(snapshot.cart.shoppingExpiresAt) -
      snapshot.serverNow -
      Math.max(0, now - sampledAt),
  );
}
export function milestone(seconds: number): string {
  if (seconds <= 0) return 'Checking reservation status.';
  if (seconds <= 30) return 'Thirty seconds or less remaining.';
  if (seconds <= 60) return 'One minute or less remaining.';
  if (seconds <= 180) return 'Three minutes or less remaining.';
  return '';
}
