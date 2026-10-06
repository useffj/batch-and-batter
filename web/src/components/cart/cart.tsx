'use client';
/* Full navigation refreshes authoritative availability instead of router cache. */
/* eslint-disable @next/next/no-html-link-for-pages */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { watchCart } from '../../lib/cart/lifecycle';
import {
  CartClient,
  CartFailure,
  LOCK,
  milestone,
  remaining,
  unsupportedBrowserMessage,
} from '../../lib/cart/client';
import {
  released,
  reservationMessage,
  total,
  type Operation,
  type Snapshot,
} from '../../lib/cart/contract';
import type { StorefrontDrop } from '../../lib/storefront/client';
const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );
interface Context {
  add: (productId: string) => void;
  disabled: boolean;
}
const CartContext = createContext<Context>({
  add: () => undefined,
  disabled: true,
});
export function AddToCart({
  productId,
  name,
}: {
  productId: string;
  name: string;
}) {
  const cart = useContext(CartContext);
  return (
    <button
      type="button"
      disabled={cart.disabled}
      onClick={() => cart.add(productId)}
      aria-label={`Add ${name} to Cart`}
    >
      Add to Cart
    </button>
  );
}
export function CartPanel({
  snapshot,
  seconds,
  busy,
  disabled,
  drop,
  onChange,
  onRetry,
  onCheck,
  heading,
  canRetry = true,
}: {
  snapshot: Snapshot | null;
  seconds: number;
  busy: boolean;
  canRetry?: boolean;
  disabled: boolean;
  drop: StorefrontDrop | null;
  onChange: (op: Operation) => void;
  onRetry: () => void;
  onCheck: () => void;
  heading: React.RefObject<HTMLHeadingElement | null>;
}) {
  const cart = snapshot?.cart;
  const editable =
    cart?.status === 'ACTIVE' && !snapshot?.expired && seconds > 0 && !disabled;
  return (
    <section className="cart" aria-labelledby="cart-heading" aria-busy={busy}>
      <h2 id="cart-heading" tabIndex={-1} ref={heading}>
        Your Cart
      </h2>
      {snapshot?.pending ? (
        <>
          <p>
            A saved change needs confirmation. Retrying checks the same saved
            change.
          </p>
          <button disabled={busy || !canRetry} onClick={onRetry}>
            Retry saved change
          </button>
        </>
      ) : cart ? (
        <>
          <p role="status">{reservationMessage(cart, snapshot!.expired)}</p>
          {cart.status === 'ACTIVE' && !snapshot!.expired && (
            <p className="cart-timer" aria-live="off">
              {seconds > 0
                ? `Reservation remaining: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                : 'Checking reservation status…'}
            </p>
          )}
          <p className="sr-only" role="status">
            {cart.status === 'ACTIVE' && !snapshot!.expired
              ? milestone(seconds)
              : ''}
          </p>
          {!released(cart) && (
            <>
              <ul className="cart-lines">
                {cart.items.map((line, index) => {
                  const name =
                    drop?.id === cart.dropId
                      ? (drop.products.find((p) => p.id === line.productId)
                          ?.name ?? `Reserved cookie ${index + 1}`)
                      : `Reserved cookie ${index + 1}`;
                  const replace = (quantity: number) =>
                    onChange({
                      kind: 'replace',
                      cartId: cart.cartId,
                      ifMatch: snapshot!.etag!,
                      items: cart.items.map((p) => ({
                        productId: p.productId,
                        quantity:
                          p.productId === line.productId
                            ? quantity
                            : p.quantity,
                      })),
                    });
                  const remove = () =>
                    onChange(
                      cart.items.length === 1
                        ? { kind: 'release', cartId: cart.cartId }
                        : {
                            kind: 'replace',
                            cartId: cart.cartId,
                            ifMatch: snapshot!.etag!,
                            items: cart.items
                              .filter((p) => p.productId !== line.productId)
                              .map(({ productId, quantity }) => ({
                                productId,
                                quantity,
                              })),
                          },
                    );
                  const atLimit =
                    drop?.id === cart.dropId &&
                    total(cart, 'cookieUnits') + line.cookieUnits >
                      drop.quantityLimit;
                  const canIncrease =
                    editable &&
                    drop?.id === cart.dropId &&
                    drop.status === 'OPEN' &&
                    !atLimit &&
                    !!drop.products.find(
                      (p) => p.id === line.productId && p.available > 0,
                    );
                  return (
                    <li key={line.productId}>
                      <h3>{name}</h3>
                      <p>
                        {money(line.priceCents)} each · {line.cookieUnits}{' '}
                        cookie {line.cookieUnits === 1 ? 'unit' : 'units'} each
                      </p>
                      <div className="quantity-controls">
                        <button
                          aria-label={`Decrease quantity of ${name}`}
                          disabled={!editable || line.quantity <= 1}
                          onClick={() => replace(line.quantity - 1)}
                        >
                          −
                        </button>
                        <span
                          aria-label={`Quantity of ${name}: ${line.quantity}`}
                        >
                          Quantity: {line.quantity}
                        </span>
                        <button
                          aria-label={`Increase quantity of ${name}`}
                          disabled={!canIncrease}
                          onClick={() => replace(line.quantity + 1)}
                        >
                          +
                        </button>
                        <button
                          aria-label={`Remove ${name} from Cart`}
                          disabled={!editable}
                          onClick={remove}
                        >
                          Remove
                        </button>
                      </div>
                      <p>
                        Line subtotal: {money(line.quantity * line.priceCents)}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <p className="cart-total">
                Cart total: <strong>{money(total(cart, 'priceCents'))}</strong>
              </p>
              <p>
                {total(cart, 'cookieUnits')} cookie units
                {drop?.id === cart.dropId
                  ? ` of ${drop.quantityLimit} allowed`
                  : ''}
                . Prices are held for this reservation.
              </p>
              {editable &&
              drop?.id === cart.dropId &&
              drop.status === 'OPEN' ? (
                <a href="/checkout">Continue to checkout</a>
              ) : cart.status === 'PAYMENT_PENDING' ||
                cart.status === 'PAYMENT_COMMITTING' ||
                cart.status === 'CONVERTED' ? (
                <a href="/checkout">Check payment status</a>
              ) : (
                <p>Checkout unavailable</p>
              )}
            </>
          )}
        </>
      ) : (
        <p>
          {snapshot ? 'Your Cart is empty.' : 'Checking for an existing Cart…'}
        </p>
      )}
      <button type="button" disabled={busy} onClick={onCheck}>
        Check Cart status
      </button>{' '}
      <a href="/">View latest cookie availability</a>
    </section>
  );
}
export function CartProvider({
  drop,
  children,
}: {
  drop: StorefrontDrop | null;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [supported, setSupported] = useState(false);
  const [message, setMessage] = useState('');
  const [seconds, setSeconds] = useState(0);
  const client = useRef<CartClient | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = useRef<Snapshot | null>(null);
  const sampled = useRef(0);
  const inFlight = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const check = useRef<() => void>(() => undefined);
  const lastCheck = useRef(0);
  function accept(next: Snapshot) {
    current.current = next;
    sampled.current = performance.now();
    setSnapshot(next);
    setSeconds(
      Math.ceil(remaining(next, sampled.current, performance.now()) / 1000),
    );
  }
  async function run(work: () => Promise<Snapshot>, focus = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      accept(await work());
    } catch (error) {
      setMessage(
        error instanceof CartFailure
          ? error.message
          : 'We could not check your Cart. Please try again.',
      );
      // Read back the durable journal/current Cart after any ambiguous response.
      try {
        if (client.current) accept(await client.current.restore());
      } catch {
        /* Preserve previous state and offer explicit recovery. */
      }
    } finally {
      lastCheck.current = performance.now();
      inFlight.current = false;
      setBusy(false);
      if (focus) heading.current?.focus();
    }
  }
  check.current = () => {
    if (client.current) void run(() => client.current!.restore());
  };
  useEffect(() => {
    const locks = navigator.locks;
    setSupported(!!locks);
    client.current = new CartClient(
      locks ? async (work) => await locks.request(LOCK, work) : null,
    );
    check.current();
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel(LOCK);
      channel.current.onmessage = () => check.current();
    }
    const stop = watchCart({
      document,
      window,
      visible: () => document.visibilityState === 'visible',
      now: () => performance.now(),
      lastChecked: () => lastCheck.current,
      state: () => ({ snapshot: current.current, sampled: sampled.current }),
      refresh: () => check.current(),
      seconds: setSeconds,
    });
    return () => {
      stop();
      channel.current?.close();
    };
  }, []);
  const disabled =
    busy ||
    !supported ||
    !snapshot ||
    snapshot.pending ||
    (!!snapshot.cart &&
      (snapshot.cart.status !== 'ACTIVE' || snapshot.expired || seconds <= 0));
  function change(op: Operation) {
    if (!client.current || disabled) return;
    void run(async () => {
      try {
        const result = await client.current!.change(op);
        if (op.kind === 'release' && result.cart && released(result.cart))
          window.location.assign('/');
        return result;
      } finally {
        channel.current?.postMessage('changed');
      }
    }, true);
  }
  function add(productId: string) {
    if (!drop || drop.status !== 'OPEN') return;
    const cart = snapshot?.cart;
    if (cart && cart.dropId !== drop.id) {
      setMessage(
        'Your Cart belongs to another Drop. Remove its items before starting this Drop.',
      );
      return;
    }
    const product = drop.products.find((p) => p.id === productId);
    if (!product) return;
    const units = cart ? total(cart, 'cookieUnits') : 0;
    const existing = cart?.items.find((p) => p.productId === productId);
    if (
      units + (existing?.cookieUnits ?? product.cookieUnits) >
      drop.quantityLimit
    ) {
      setMessage('That addition exceeds this Drop’s cookie-unit limit.');
      return;
    }
    const items =
      cart?.items.map(({ productId, quantity }) => ({ productId, quantity })) ??
      [];
    const line = items.find((p) => p.productId === productId);
    if (line) line.quantity++;
    else items.push({ productId, quantity: 1 });
    change(
      cart
        ? {
            kind: 'replace',
            cartId: cart.cartId,
            ifMatch: snapshot!.etag!,
            items,
          }
        : { kind: 'create', dropId: drop.id, items },
    );
  }
  return (
    <CartContext.Provider value={{ add, disabled }}>
      {children}
      <div role="status" className="cart-message">
        {message}
      </div>
      {!supported && !busy && <p role="status">{unsupportedBrowserMessage}</p>}
      <CartPanel
        snapshot={snapshot}
        seconds={seconds}
        busy={busy}
        disabled={disabled}
        canRetry={supported}
        drop={drop}
        onChange={change}
        onRetry={() => {
          if (client.current && supported)
            void run(() => client.current!.retry(), true);
        }}
        onCheck={() => check.current()}
        heading={heading}
      />
    </CartContext.Provider>
  );
}
