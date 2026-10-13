import type { Overview } from '../../lib/admin/contract';
export function DropOverview({ overview }: { overview: Overview | null }) {
  if (!overview)
    return (
      <section aria-labelledby="no-drop">
        <h2 id="no-drop">No Drop assigned</h2>
        <p>There is currently no storefront-assigned Drop.</p>
      </section>
    );
  const { drop, products, inventory, pickupDates } = overview;
  const orphans = inventory.filter(
    (row) => !products.some((p) => p.id === row.productId),
  );
  return (
    <>
      <section className="admin-card" aria-labelledby="drop-title">
        <p className="admin-eyebrow">
          Assigned Drop · {drop.status.replaceAll('_', ' ')}
        </p>
        <h2 id="drop-title">{drop.name}</h2>
        <p className="admin-muted">{drop.dropId}</p>
        <p>
          Configured timezone: <strong>{drop.timezone}</strong>
        </p>
      </section>
      <section aria-labelledby="products-title">
        <h2 id="products-title">Cookies &amp; inventory</h2>
        <p className="admin-muted">
          Quantities are units of each product. Available = total − reserved −
          sold.
        </p>
        {!products.length && <p>No products are assigned to this Drop.</p>}
        <div className="admin-products">
          {products.map((product) => {
            const stock = inventory.find((row) => row.productId === product.id);
            return (
              <article className="admin-card" key={product.id}>
                <h3>{product.name ?? 'Missing product reference'}</h3>
                {product.name === null && (
                  <p role="alert">
                    This assignment references a product that could not be
                    found.
                  </p>
                )}
                <p>
                  Catalog:{' '}
                  {product.active === null
                    ? 'Unknown'
                    : product.active
                      ? 'Active'
                      : 'Inactive'}{' '}
                  · In this Drop:{' '}
                  {product.assignedActive ? 'Active' : 'Inactive'}
                </p>
                <p className="admin-muted">{product.id}</p>
                {stock ? (
                  <Inventory stock={stock} />
                ) : (
                  <p role="alert">
                    Inventory record missing. Quantities are unavailable.
                  </p>
                )}
              </article>
            );
          })}
        </div>
        {orphans.length > 0 && (
          <div className="admin-card">
            <h3>Unmatched inventory</h3>
            <p role="alert">
              These inventory records have no matching product assignment.
            </p>
            {orphans.map((row) => (
              <div key={row.productId}>
                <p>{row.productId}</p>
                <Inventory stock={row} />
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="admin-card" aria-labelledby="pickup-title">
        <h2 id="pickup-title">Pickup information</h2>
        <h3>Location</h3>
        <p>{drop.pickupLocation}</p>
        {drop.pickupInstructions && (
          <p className="admin-instructions">{drop.pickupInstructions}</p>
        )}
        <h3>Dates &amp; hours</h3>
        {!pickupDates.length && <p>No pickup dates configured.</p>}
        <ul className="admin-pickups">
          {pickupDates.map((p) => (
            <li key={p.date}>
              <strong>
                <time dateTime={p.date}>
                  {new Intl.DateTimeFormat('en-US', {
                    dateStyle: 'full',
                    timeZone: 'UTC',
                  }).format(new Date(`${p.date}T12:00:00Z`))}
                </time>
              </strong>
              <br />
              {hours(p.startTime)}–{hours(p.endTime)} · {p.timezone}
              <br />
              <span className="admin-muted">
                {p.active ? 'Active pickup date' : 'Inactive pickup date'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
function hours(value: string) {
  const [h, m] = value.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function Inventory({ stock }: { stock: Overview['inventory'][number] }) {
  return (
    <dl className="admin-inventory">
      {(['total', 'reserved', 'sold', 'available'] as const).map((label) => (
        <div key={label}>
          <dt>{label[0].toUpperCase() + label.slice(1)}</dt>
          <dd>{stock[label]}</dd>
        </div>
      ))}
    </dl>
  );
}
