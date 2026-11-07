/* eslint-disable @next/next/no-html-link-for-pages */
export function AdminNavigation({
  current,
  photography = false,
}: {
  photography?: boolean;
  current:
    | 'photography'
    | 'overview'
    | 'products'
    | 'drops'
    | 'orders'
    | 'fulfillment'
    | 'customers'
    | 'waitlists';
}) {
  return (
    <aside className="admin-sidebar">
      <a className="admin-brand" href="/">
        Batch &amp; Batter<span>COOKIE CO. / ADMIN</span>
      </a>
      <nav aria-label="Administration">
        <a
          href="/admin"
          aria-current={current === 'overview' ? 'page' : undefined}
        >
          Overview
        </a>
        <a
          href="/admin/products"
          aria-current={current === 'products' ? 'page' : undefined}
        >
          Products
        </a>
        <a
          href="/admin/drops"
          aria-current={current === 'drops' ? 'page' : undefined}
        >
          Weekly Drops
        </a>
        {photography && (
          <a
            href="/admin/photography"
            aria-current={current === 'photography' ? 'page' : undefined}
          >
            Photography (Isolated)
          </a>
        )}
        {!photography && (
          <>
            <a
              href="/admin/orders"
              aria-current={current === 'orders' ? 'page' : undefined}
            >
              Orders
            </a>
            <a
              href="/admin/fulfillment"
              aria-current={current === 'fulfillment' ? 'page' : undefined}
            >
              Fulfillment
            </a>
            <a
              href="/admin/customers"
              aria-current={current === 'customers' ? 'page' : undefined}
            >
              Customers
            </a>
            <a
              href="/admin/waitlists"
              aria-current={current === 'waitlists' ? 'page' : undefined}
            >
              Waitlist Management
            </a>
          </>
        )}
      </nav>
      <p className="admin-eyebrow">Coming later</p>
      <ul className="admin-future">
        {['Messaging', 'Settings'].map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </aside>
  );
}
