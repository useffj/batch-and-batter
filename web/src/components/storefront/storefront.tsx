/* A full navigation intentionally bypasses client router caches for a fresh public read. */
/* eslint-disable @next/next/no-html-link-for-pages */
import type { StorefrontResult, DropState } from '../../lib/storefront/client';
const labels: Record<DropState, string> = {
  OPEN: 'Open',
  SCHEDULED: 'Upcoming',
  PAUSED: 'Ordering paused',
  SOLD_OUT: 'Sold out',
  CLOSED: 'Closed',
};
function clock(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
export function Storefront({ result }: { result: StorefrontResult }) {
  const drop = result.kind === 'ready' ? result.drop : null;
  return (
    <main>
      <header>
        <h1>Batch &amp; Batter</h1>
        <p>Cookie Co.</p>
      </header>
      {result.kind !== 'ready' ? (
        <section aria-labelledby="unavailable">
          <h2 id="unavailable">Drop information unavailable</h2>
          <p role="status">
            {result.kind === 'invalid'
              ? 'We could not display the latest Drop information safely. Please try again later.'
              : 'We cannot load the latest Drop right now. Please try again later.'}
          </p>
          <a href="/">Reload Drop information</a>
        </section>
      ) : !drop ? (
        <section>
          <h2>Our next Drop is on its way</h2>
          <p>
            No current or upcoming Drop is available. Please check back later.
          </p>
        </section>
      ) : (
        <>
          <section aria-labelledby="drop-name">
            <h2 id="drop-name">{drop.name}</h2>
            <p className="drop-status">{labels[drop.status]}</p>
            <p>{drop.description}</p>
            {drop.status === 'SCHEDULED' && (
              <p>
                Scheduled opening:{' '}
                <time dateTime={drop.opensAt}>
                  {new Intl.DateTimeFormat('en-US', {
                    dateStyle: 'full',
                    timeStyle: 'short',
                    timeZone: drop.timezone,
                  }).format(new Date(drop.opensAt))}
                </time>{' '}
                ({drop.timezone}). Opening is confirmed by the store.
              </p>
            )}
            {drop.status !== 'OPEN' && (
              <p>Ordering is not currently available for this Drop.</p>
            )}
          </section>
          <section aria-labelledby="cookies">
            <h2 id="cookies">Cookies</h2>
            <p>
              Availability is informational and may change. Viewing this page
              does not reserve inventory.
            </p>
            {drop.products.length === 0 ? (
              <p>No products are listed for this Drop.</p>
            ) : (
              <ul className="products">
                {drop.products.map((p, index) => (
                  <li key={index}>
                    <h3>{p.name}</h3>
                    <p>
                      {new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                      }).format(p.priceCents / 100)}
                    </p>
                    <p>
                      {p.available === 0
                        ? 'None currently available'
                        : `${p.available} available`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="pickup">
            <h2 id="pickup">Pickup</h2>
            <p>{drop.pickupLocation}</p>
            <p className="instructions">{drop.pickupInstructions}</p>
            {drop.pickupDates.length === 0 ? (
              <p>No pickup dates are listed.</p>
            ) : (
              <ul>
                {drop.pickupDates.map((p, index) => (
                  <li key={index}>
                    <time dateTime={p.date}>
                      {new Intl.DateTimeFormat('en-US', {
                        dateStyle: 'full',
                        timeZone: 'UTC',
                      }).format(new Date(`${p.date}T12:00:00Z`))}
                    </time>
                    : {clock(p.startTime)}–{clock(p.endTime)} ({p.timezone})
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p>
            This page shows Drop information only. Online ordering is not
            available here yet.
          </p>
          <a href="/">Reload Drop information</a>
        </>
      )}
    </main>
  );
}
