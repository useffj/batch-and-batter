import { seedRefundOrder } from '../../backend/scripts/refund-local-fixtures.mjs';
// Loopback-only synthetic acceptance. No production import or live providers.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
if (process.env.NODE_ENV === 'production') throw Error('Local preview only');
const { fixtures } =
  await import('../../backend/scripts/orders-local-fixtures.mjs');
const f = await fixtures(),
  require = createRequire(
    new URL('../../backend/package.json', import.meta.url),
  );
const { PutCommand } = require('@aws-sdk/lib-dynamodb'),
  { GuestOrders } = require('./dist/src/guest-orders'),
  { Notifications } = require('./dist/src/notifications'),
  { MockNotificationTransport } = require('./dist/src/notification-transport'),
  {
    MockEmailProvider,
    MockSmsProvider,
  } = require('./dist/src/notification-providers'),
  { digest, refundKey } = require('./dist/src/notification-contract'),
  { orderKey } = require('./dist/src/payment-domain'),
  { createHandler } = require('./dist/src/api');
const now = () =>
    Date.parse(
      process.argv.includes('--late')
        ? '2026-10-21T23:00:00Z'
        : '2026-10-20T18:00:00Z',
    ),
  o = f.orders[1];
o.settlement = {
  id: digest(o.orderId),
  lineDigest: digest('synthetic'),
  outcome: 'PAID',
  amountCents: o.totalCents,
};
const put = (Item) =>
  f.client.send(new PutCommand({ TableName: f.table, Item }));
await put({ ...orderKey(o.orderId), ...o });
await put({
  ...refundKey(o.orderId),
  disposition: 'NONE',
  settlementId: o.settlement.id,
  updatedAt: new Date(now()).toISOString(),
});
await put({
  PK: 'ORDER_EVENT#' + o.orderId + '#PAID',
  SK: 'META',
  schemaVersion: 1,
  eventType: 'PAID',
  orderId: o.orderId,
  cartId: o.cartId,
  paymentAttemptId: o.paymentAttemptId,
  dropId: o.dropId,
  settlementId: o.settlement.id,
  createdAt: new Date(now()).toISOString(),
});
await put({
  PK: 'DROP#' + o.dropId,
  SK: 'PICKUP#2026-10-23',
  dropId: o.dropId,
  date: '2026-10-23',
  startTime: '12:00',
  endTime: '15:00',
  timezone: 'America/Denver',
  active: true,
});
const guest = new GuestOrders(
    f.client,
    f.table,
    f.table,
    f.table,
    'https://synthetic.example.test',
    now,
  ),
  email = new MockEmailProvider(),
  service = new Notifications(
    f.client,
    f.table,
    f.table,
    new MockNotificationTransport(),
    { email, sms: new MockSmsProvider() },
    {
      policies: 'Synthetic only',
      now,
      issueManagementLink: (op) => guest.issue(op),
    },
  );
await service.confirmation(o.orderId);
await service.deliver(o.orderId, 'CONFIRMATION#email');
const refundMode = process.argv.includes('--refund');
const { Refunds } = require('./dist/src/refunds');
const { MockStripeRefundProvider } = require('./dist/src/refund-provider');
const provider = new MockStripeRefundProvider();
provider.initialStatus = 'succeeded';
let refundNow = now();
if (refundMode) await seedRefundOrder(f, 1, now());
const refunds = new Refunds(
  f.client,
  f.table,
  f.table,
  f.table,
  provider,
  'dev:acct_SYNTHETIC',
  () => ++refundNow,
);
const token = email.messages[0].text.split('/order/manage#')[1].split(/\s/)[0];
const storefrontMode = process.argv.includes('--storefront');
let catalog, carts, waitlists;
if (storefrontMode) {
  const { DynamoCatalogRepository } = require('./dist/src/repository');
  const { DynamoCartRepository } = require('./dist/src/cart-repository');
  const { Waitlists } = require('./dist/src/waitlists');
  const { catalogKeys } = require('./dist/src/keys');
  const fixture = require('./dist/test/fixtures');
  const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await put({
    ...catalogKeys.drop(fixture.dropId),
    ...fixture.drop,
    name: 'The small-batch collection',
    description:
      'A little comfort, baked from scratch. Choose your cookies and collect them fresh at pickup.',
    quantityLimit: 4,
    status: process.argv.includes('--upcoming') ? 'SCHEDULED' : 'OPEN',
    opensAt: process.argv.includes('--upcoming')
      ? new Date(Date.now() + 86400000).toISOString()
      : fixture.timestamp,
    pickupLocation: 'Synthetic bakery · 123 Test Lane',
    pickupInstructions:
      'Local acceptance only. Bring your order reference to pickup.',
  });
  for (const [index, id] of [
    fixture.productId,
    fixture.otherProductId,
  ].entries()) {
    await put({
      ...catalogKeys.product(id),
      ...fixture.product,
      productId: id,
      name: index ? 'Brown butter vanilla' : 'Classic chocolate chunk',
      slug: index ? 'vanilla' : 'chocolate',
      description: index
        ? 'Toasty brown butter, fragrant vanilla and a delicate sprinkle of sea salt.'
        : 'Golden edges, a soft center and generous pockets of dark chocolate.',
      ingredients: [
        'Wheat flour',
        'Butter',
        'Sugar',
        'Eggs',
        index ? 'Vanilla' : 'Dark chocolate',
      ],
      allergens: ['Wheat', 'Milk', 'Eggs'],
    });
    await put({
      ...catalogKeys.dropProduct(fixture.dropId, id),
      ...fixture.relation,
      productId: id,
      priceCents: index ? 450 : 525,
      displayOrder: index,
    });
    await put({
      ...catalogKeys.inventory(fixture.dropId, id),
      ...fixture.inventory,
      productId: id,
      total: index ? 0 : 24,
      reserved: 0,
      sold: 0,
    });
  }
  await put({
    ...catalogKeys.pickup(fixture.dropId, date),
    ...fixture.pickup,
    date,
  });
  await put({
    ...catalogKeys.storefront,
    storefrontDropId: fixture.dropId,
    updatedAt: fixture.timestamp,
  });
  catalog = new DynamoCatalogRepository(f.client, f.table);
  carts = new DynamoCartRepository(f.client, f.table, f.table, f.table);
  waitlists = new Waitlists(
    f.client,
    f.table,
    f.table,
    f.table,
    Buffer.alloc(32, 7),
    'https://synthetic.example.test',
    {
      enqueue: async () => {
        throw Error('No availability dispatch in storefront acceptance');
      },
    },
    email,
  );
}
const handler = createHandler(
  () => catalog ?? {},
  undefined,
  () => carts,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  () => guest,
  () => refunds,
  undefined,
  () => waitlists,
);
if (storefrontMode) {
  const { createServer: httpServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const api = httpServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    // Only the existing customer contracts are reachable in this disposable fixture.
    const match = path.match(
      /^\/carts\/([0-7][0-9A-HJKMNP-TV-Z]{25})(\/items)?$/,
    );
    if (
      !match &&
      ![
        '/drops/current',
        '/carts',
        '/waitlists',
        '/waitlists/unsubscribe',
        '/orders/manage/view',
        '/orders/manage/pickup',
        '/orders/manage/request',
      ].includes(path)
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) throw Error('Body too large');
      }
      const response = await handler({
        routeKey:
          req.method +
          ' ' +
          (match ? '/carts/{cartId}' + (match[2] ?? '') : path),
        headers: req.headers,
        pathParameters: match ? { cartId: match[1] } : undefined,
        body: body || undefined,
        requestContext: {
          requestId: 'synthetic-local',
          http: { method: req.method, sourceIp: '127.0.0.1' },
        },
      });
      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch {
      res.writeHead(503);
      res.end('{}');
    }
  });
  await new Promise((resolve) => api.listen(4182, '127.0.0.1', resolve));
  const child = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4183',
    ],
    {
      cwd: resolve(new URL('..', import.meta.url).pathname),
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'development',
        STOREFRONT_API_BASE_URL: 'http://127.0.0.1:4182',
        STOREFRONT_CURRENCY: 'USD',
        CHECKOUT_PRICING_MODE: 'dev-zero-tax-fee',
        CHECKOUT_SUBMISSION_MODE: 'disabled',
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: '',
      },
    },
  );
  console.log(
    'SYNTHETIC LOCAL ONLY: storefront http://127.0.0.1:4183. Run the default preview separately for the existing captured guest order. No payment provider.',
  );
  process.on('SIGINT', async () => {
    child.kill('SIGTERM');
    api.close();
    await f.close();
    process.exit(0);
  });
  await new Promise((resolve) => child.on('exit', resolve));
  api.close();
  await f.close();
  process.exit(0);
}
const web = resolve(new URL('..', import.meta.url).pathname),
  root = await mkdtemp(join(tmpdir(), 'bb-guest-preview-'));
await writeFile(
  join(root, 'index.html'),
  '<html><title>Synthetic guest order acceptance</title><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/preview.tsx"></script></body></html>',
);
await writeFile(
  join(root, 'preview.tsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ManageOrder} from '/@fs/${web}/src/components/guest/manage-order.tsx';import '/@fs/${web}/src/app/globals.css';import '/@fs/${web}/src/components/admin/orders.css';import {RefundReview} from '/@fs/${web}/src/components/admin/refunds.tsx';import {CancellationReview} from '/@fs/${web}/src/components/admin/cancellation-review.tsx';createRoot(document.getElementById('root')).render(<><p role="note">SYNTHETIC LOCAL ACCEPTANCE. DynamoDB Local, mock email, no AWS. Clock: ${process.argv.includes('--late') ? 'October 21, 5 PM Denver (after deadline)' : 'October 20, noon Denver'}.</p>{location.pathname==='/review'?<main className="admin-orders"><h1>Synthetic customer request review</h1><CancellationReview orderId="${o.orderId}"/>${refundMode ? `<RefundReview orderId="${o.orderId}"/>` : ''}</main>:<ManageOrder/>}</>);`,
);
const server = await createServer({
  configFile: false,
  root,
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      react: resolve(web, 'node_modules/react'),
      'react-dom': resolve(web, 'node_modules/react-dom'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4181,
    strictPort: true,
    fs: { allow: [root, web] },
  },
  plugins: [
    {
      name: 'synthetic-guest-api',
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Referrer-Policy', 'no-referrer');
          if (req.url === '/') {
            res.statusCode = 302;
            res.setHeader('Location', '/order/manage#' + token);
            res.end();
            return;
          }
          const admin = req.url?.startsWith('/api/admin/orders/');
          if (!req.url?.startsWith('/api/order/manage/') && !admin)
            return next();
          try {
            let body = '';
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 2048) throw Error();
            }
            const action = req.url.split('/').at(-1),
              response = await handler({
                routeKey: admin
                  ? req.method +
                    ' /admin/orders/{orderId}/' +
                    (req.url.includes('/refunds')
                      ? 'refunds' +
                        (['authorize', 'reconcile'].includes(action)
                          ? '/' + action
                          : '')
                      : 'requests' + (action === 'review' ? '/review' : ''))
                  : req.method + ' /orders/manage/' + action,
                pathParameters: admin ? { orderId: o.orderId } : undefined,
                body,
                requestContext: {
                  authorizer: admin
                    ? {
                        jwt: {
                          claims: {
                            token_use: 'access',
                            sub: 'synthetic-admin',
                            username: 'synthetic-admin',
                            'cognito:groups': ['batch-and-batter-admins'],
                          },
                        },
                      }
                    : undefined,
                  requestId: 'synthetic',
                  http: { method: req.method, sourceIp: '127.0.0.1' },
                },
              });
            res.statusCode = response.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(response.body);
          } catch {
            res.statusCode = 503;
            res.end('{"message":"Synthetic request failed"}');
          }
        });
      },
    },
  ],
});
await server.listen();
console.log(
  'Synthetic guest preview ready on http://127.0.0.1:4181 (token stays in memory).',
);
process.on('SIGINT', async () => {
  await server.close();
  await f.close();
  process.exit(0);
});
