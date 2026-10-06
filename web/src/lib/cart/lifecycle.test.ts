import { afterEach, expect, it, vi } from 'vitest';
import { watchCart } from './lifecycle';
import type { Snapshot } from './contract';
afterEach(() => vi.useRealTimers());
function setup(expired = false) {
  vi.useFakeTimers();
  let now = 0,
    lastChecked = 0,
    visible = true;
  const doc = new EventTarget(),
    win = new EventTarget();
  const seconds = vi.fn();
  const snapshot: Snapshot = {
    cart: {
      cartId: '01K00000000000000000000003',
      dropId: '01K00000000000000000000000',
      status: 'ACTIVE',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      shoppingExpiresAt: new Date(expired ? 0 : 480000).toISOString(),
      items: [
        {
          productId: '01K00000000000000000000001',
          priceCents: 525,
          cookieUnits: 2,
          quantity: 1,
        },
      ],
    },
    serverNow: 0,
    pending: false,
    expired,
    etag: '"' + 'a'.repeat(64) + '"',
  };
  const refresh = vi.fn(() => {
    lastChecked = now;
  });
  const stop = watchCart({
    document: doc,
    window: win,
    visible: () => visible,
    now: () => now,
    lastChecked: () => lastChecked,
    state: () => ({ snapshot, sampled: 0 }),
    refresh,
    seconds,
  });
  return {
    doc,
    win,
    snapshot,
    refresh,
    seconds,
    stop,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
    step: (elapsed: number) => {
      now += elapsed;
      vi.advanceTimersByTime(1000);
    },
  };
}
it('focus, pageshow and visibility restoration revalidate after inactivity, with cleanup', () => {
  const h = setup();
  h.step(2000);
  h.win.dispatchEvent(new Event('focus'));
  expect(h.refresh).toHaveBeenCalledTimes(1);
  h.step(2000);
  h.win.dispatchEvent(new Event('pageshow'));
  expect(h.refresh).toHaveBeenCalledTimes(2);
  h.hide();
  h.step(2000);
  h.doc.dispatchEvent(new Event('visibilitychange'));
  expect(h.refresh).toHaveBeenCalledTimes(2);
  h.show();
  h.doc.dispatchEvent(new Event('visibilitychange'));
  expect(h.refresh).toHaveBeenCalledTimes(3);
  h.stop();
  h.step(2000);
  h.win.dispatchEvent(new Event('focus'));
  expect(h.refresh).toHaveBeenCalledTimes(3);
});
it('sleep gap causes revalidation, not an invented deadline or terminal state', () => {
  const h = setup();
  const deadline = h.snapshot.cart!.shoppingExpiresAt;
  h.step(500000);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.snapshot.cart!.shoppingExpiresAt).toBe(deadline);
  expect(h.snapshot.cart!.status).toBe('ACTIVE');
  h.stop();
});
it('zero and expired ACTIVE poll at most six times then await manual/resume checks', () => {
  const h = setup(true);
  for (let i = 0; i < 120; i++) h.step(1000);
  expect(h.refresh).toHaveBeenCalledTimes(6);
  expect(h.snapshot.cart!.status).toBe('ACTIVE');
  h.win.dispatchEvent(new Event('focus'));
  expect(h.refresh).toHaveBeenCalledTimes(7);
  h.stop();
});
it('periodic server anchoring bounds drift and terminal states never poll', () => {
  const h = setup();
  for (let i = 0; i < 60; i++) h.step(1000);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.seconds).toHaveBeenLastCalledWith(420);
  h.snapshot.cart!.status = 'EXPIRED';
  for (let i = 0; i < 90; i++) h.step(1000);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  h.stop();
});
it('wall-clock jump or sleep with paused monotonic clock triggers a read, never a new deadline', () => {
  vi.useFakeTimers();
  let mono = 0,
    wall = 0;
  const refresh = vi.fn();
  const stop = watchCart({
    document: new EventTarget(),
    window: new EventTarget(),
    visible: () => true,
    now: () => mono,
    wallNow: () => wall,
    lastChecked: () => 0,
    state: () => ({ snapshot: null, sampled: 0 }),
    refresh,
    seconds: () => {},
  });
  mono += 1000;
  wall += 300000;
  vi.advanceTimersByTime(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});
