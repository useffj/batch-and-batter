/* eslint-disable @next/next/no-html-link-for-pages */
export function AdminNavigation({
  current,
}: {
  current: 'overview' | 'products';
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
      </nav>
      <p className="admin-eyebrow">Coming later</p>
      <ul className="admin-future">
        {[
          'Drops',
          'Orders',
          'Customers',
          'Fulfillment',
          'Messaging',
          'Settings',
        ].map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </aside>
  );
}
