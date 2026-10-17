import { PrivateImage } from '../admin/private-image';
import type { previewData } from '../../lib/admin/preview';
import { BrandLogo, CookiePhoto } from './presentation';
export function DraftPreview({
  data,
  images = {},
}: {
  data: ReturnType<typeof previewData>;
  images?: Record<string, { mediaId: string; alt: string }>;
}) {
  return (
    <main className="storefront">
      <header>
        <BrandLogo />
        <nav>
          <a href="/admin/drops">Return to Weekly Drops</a>
        </nav>
      </header>
      <p className="dev-preview-notice">
        Restricted DEV preview · Saved DRAFT · Ordering, payments and waitlists
        are disabled.
      </p>
      <section className="drop-intro">
        <h2>{data.drop.name}</h2>
        <p>{data.description}</p>
      </section>
      <section>
        <h2>Cookies</h2>
        <ul className="products">
          {data.products.map((p) => (
            <li className="cookie-card" key={p.id}>
              {images[p.id] ? (
                <PrivateImage
                  productId={p.id}
                  mediaId={images[p.id].mediaId}
                  alt={images[p.id].alt}
                />
              ) : (
                <CookiePhoto name={p.name} />
              )}
              <div className="cookie-content">
                <h3>{p.name}</h3>
                <p>{p.description}</p>
                <p>
                  {new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  }).format(p.priceCents / 100)}
                </p>
                <p>
                  {p.quantity} planned · {p.active ? 'Active' : 'Inactive'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Pickup</h2>
        <p>{data.drop.pickupLocation}</p>
        <p>{data.drop.pickupInstructions}</p>
        <ul>
          {data.pickupDates.map((p) => (
            <li key={p.date}>
              {p.date}: {p.startTime}–{p.endTime} ({p.timezone})
              {!p.active && ' · Inactive'}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
