import { remaining } from './client';
import type { Snapshot } from './contract';
// Presentation scheduler only: never mutates inventory or manufactures a Cart state.
export function watchCart(options: {
  document: EventTarget;
  window: EventTarget;
  visible: () => boolean;
  now: () => number;
  wallNow?: () => number;
  lastChecked: () => number;
  state: () => { snapshot: Snapshot | null; sampled: number };
  refresh: () => void;
  seconds: (value: number) => void;
}) {
  let previous = options.now(),
    cartId: string | undefined,
    expiryChecks = 0;
  const wallNow = options.wallNow ?? Date.now;
  let previousWall = wallNow();
  const resume = () => {
    if (options.visible() && options.now() - options.lastChecked() > 1000)
      options.refresh();
  };
  options.document.addEventListener('visibilitychange', resume);
  for (const event of ['focus', 'pageshow'])
    options.window.addEventListener(event, resume);
  const timer = setInterval(() => {
    const now = options.now(),
      gap = now - previous;
    previous = now;
    const wall = wallNow(),
      wallGap = wall - previousWall;
    previousWall = wall;
    if (!options.visible()) return;
    if (gap > 15000 || Math.abs(wallGap - gap) > 15000) {
      options.refresh();
      return;
    }
    const { snapshot, sampled } = options.state();
    if (cartId !== snapshot?.cart?.cartId) {
      cartId = snapshot?.cart?.cartId;
      expiryChecks = 0;
    }
    if (
      !snapshot?.cart ||
      snapshot.cart.status !== 'ACTIVE' ||
      snapshot.pending
    )
      return;
    const seconds = Math.ceil(remaining(snapshot, sampled, now) / 1000);
    options.seconds(seconds);
    if (
      (seconds === 0 || snapshot.expired) &&
      expiryChecks < 6 &&
      (expiryChecks === 0 || now - options.lastChecked() >= 10000)
    ) {
      expiryChecks++;
      options.refresh();
    } else if (
      seconds > 0 &&
      !snapshot.expired &&
      now - options.lastChecked() >= 60000
    )
      options.refresh();
  }, 1000);
  return () => {
    clearInterval(timer);
    options.document.removeEventListener('visibilitychange', resume);
    for (const event of ['focus', 'pageshow'])
      options.window.removeEventListener(event, resume);
  };
}
