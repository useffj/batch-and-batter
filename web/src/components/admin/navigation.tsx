/* eslint-disable @next/next/no-html-link-for-pages */
export function AdminNavigation({
  current,
}: {
  current: 'overview' | 'products' | 'drops' | 'orders' | 'fulfillment';
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
      </nav>
      <p className="admin-eyebrow">Coming later</p>
      <ul className="admin-future">
        {['Customers', 'Messaging', 'Settings'].map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </aside>
  );
}
