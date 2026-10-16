import { BrandLogo, CookiePhoto } from './presentation';
import { JoinWaitlist } from './waitlist';
/* A full navigation intentionally bypasses client router caches for a fresh public read. */
/* eslint-disable @next/next/no-html-link-for-pages */
import Image from 'next/image';
import { AddToCart, CartProvider } from '../cart/cart';
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
    <main className="storefront">
      <header>
        <BrandLogo />
        <nav aria-label="Store navigation">
          {drop && (
            <>
              <a href="#cookies">Cookies</a>
              <a href="#pickup">Pickup</a>
            </>
          )}
          <a href="#cart">Your cart</a>
        </nav>
      </header>
      <CartProvider drop={drop}>
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
          <section className="no-drop" aria-labelledby="no-drop-heading">
            <Image
              className="no-drop-logo"
              src="/brand/secondary-mixing-bowl.png"
              alt="A smiling mixing bowl with cookies, Batch and Batter Cookie Co."
              width={1254}
              height={1254}
              sizes="(max-width: 480px) 85vw, 360px"
              priority
            />
            <h2 id="no-drop-heading">Fresh cookies are in the works.</h2>
            <p>
              We’re getting the kitchen ready for our next drop. Check back soon
              for what’s baking.
            </p>
          </section>
        ) : (
          <>
            <section className="drop-intro" aria-labelledby="drop-name">
              <p className="eyebrow">
                Small batches. Something worth waiting for.
              </p>
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
                    <li key={index} className="cookie-card">
                      <CookiePhoto name={p.name} />
                      <div className="cookie-content">
                        <h3>{p.name}</h3>
                        <p className="cookie-description">
                          {p.description || 'Ask us about this cookie.'}
                        </p>
                        <details>
                          <summary>Ingredients &amp; allergens</summary>
                          <p>
                            <strong>Ingredients: </strong>
                            {p.ingredients.length
                              ? p.ingredients.join(', ')
                              : 'Not listed.'}
                          </p>
                          <p>
                            <strong>Allergens: </strong>
                            {p.allergens.length
                              ? p.allergens.join(', ')
                              : 'No allergen information listed.'}
                          </p>
                          <p>
                            Have a food allergy? Contact the bakery before
                            ordering.
                          </p>
                        </details>
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
                        {p.available === 0 && drop.status !== 'CLOSED' && (
                          <JoinWaitlist
                            dropId={drop.id}
                            productId={p.id}
                            name={p.name}
                          />
                        )}
                        {drop.status === 'OPEN' && p.available > 0 && (
                          <AddToCart productId={p.id} name={p.name} />
                        )}
                      </div>
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
              Cart reservations are confirmed by the store. Checkout will
              confirm whether online payment is available.
            </p>
            <a href="/">Reload Drop information</a>
          </>
        )}
      </CartProvider>
    </main>
  );
}
