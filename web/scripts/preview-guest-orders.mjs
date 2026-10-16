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
const token = email.messages[0].text.split('/order/manage#')[1].split(/\s/)[0];
const handler = createHandler(
  () => ({}),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  () => guest,
);
const web = resolve(new URL('..', import.meta.url).pathname),
  root = await mkdtemp(join(tmpdir(), 'bb-guest-preview-'));
await writeFile(
  join(root, 'index.html'),
  '<html><title>Synthetic guest order acceptance</title><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/preview.tsx"></script></body></html>',
);
await writeFile(
  join(root, 'preview.tsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ManageOrder} from '/@fs/${web}/src/components/guest/manage-order.tsx';import '/@fs/${web}/src/app/globals.css';import '/@fs/${web}/src/components/admin/orders.css';import {CancellationReview} from '/@fs/${web}/src/components/admin/cancellation-review.tsx';createRoot(document.getElementById('root')).render(<><p role="note">SYNTHETIC LOCAL ACCEPTANCE. DynamoDB Local, mock email, no AWS. Clock: ${process.argv.includes('--late') ? 'October 21, 5 PM Denver (after deadline)' : 'October 20, noon Denver'}.</p>{location.pathname==='/review'?<main className="admin-orders"><h1>Synthetic customer request review</h1><CancellationReview orderId="${o.orderId}"/></main>:<ManageOrder/>}</>);`,
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
                    ' /admin/orders/{orderId}/requests' +
                    (action === 'review' ? '/review' : '')
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
