// Explicit local-only preview using an isolated DynamoDB Local table. No AWS credentials.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
if (process.env.NODE_ENV === 'production') throw Error('Local preview only');
const { customerFixtures } =
  await import('../../backend/scripts/customer-local-fixtures.mjs');
const f = await customerFixtures();
const require = createRequire(
  new URL('../../backend/package.json', import.meta.url),
);
const { createHandler } = require('./dist/src/api');
const { ADMIN_GROUP } = require('./dist/src/admin-auth');
const { AdminNotifications } = require('./dist/src/admin-notifications');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const notifications = new AdminNotifications(f.client, f.table);
for (const o of f.orders)
  await f.client.send(
    new PutCommand({
      TableName: f.table,
      Item: {
        PK: 'ORDER_NOTIFICATIONS#' + o.orderId,
        SK: 'CONFIRMATION#email',
        orderId: o.orderId,
        key: 'CONFIRMATION#email',
        kind: 'CONFIRMATION',
        channel: 'email',
        pickupDate: o.pickup.date,
        status: 'UNCERTAIN',
        attempts: 1,
        revision: 1,
        createdAt: '2026-10-20T18:00:00Z',
        updatedAt: '2026-10-20T18:00:00Z',
        reason: 'DELIVERY_ACKNOWLEDGEMENT_UNKNOWN',
      },
    }),
  );
const handler = createHandler(
  () => ({ listDrops: async () => ({ drops: f.drops }) }),
  undefined,
  undefined,
  undefined,
  undefined,
  () => f.repository,
  undefined,
  () => f.customers,
  () => notifications,
);
const web = resolve(new URL('..', import.meta.url).pathname),
  root = await mkdtemp(join(tmpdir(), 'bb-orders-preview-'));
await writeFile(
  join(root, 'index.html'),
  '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/preview.tsx"></script></body></html>',
);
await writeFile(
  join(root, 'preview.tsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import {Customers} from '/@fs/${web}/src/components/admin/customers.tsx';import '/@fs/${web}/src/app/globals.css';import '/@fs/${web}/src/app/admin/admin.css';createRoot(document.getElementById('root')).render(<><p role="note">SYNTHETIC LOCAL ACCEPTANCE — isolated DynamoDB Local. No AWS. Search Michael. Message states are synthetic.</p><Customers expiresAt={Date.now()+900000}/></>);`,
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
    port: 4180,
    strictPort: true,
    fs: { allow: [root, web] },
  },
  plugins: [
    {
      name: 'synthetic-weekly-api',
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/api/admin/')) return next();
          try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname === '/api/admin/dashboard') {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ overview: { drop: f.drops[0] } }));
              return;
            }
            const path = url.pathname.replace('/api', ''),
              parts = path.split('/');
            let route = path;
            const params = {};
            if (parts[2] === 'orders' && parts[3]) {
              params.orderId = parts[3];
              route =
                '/admin/orders/{orderId}' +
                (parts[4] === 'notifications' ? '/notifications' : '');
            }
            if (parts[2] === 'drops' && parts[3]) {
              params.dropId = parts[3];
              route =
                '/admin/drops/{dropId}' + (parts[4] ? '/' + parts[4] : '');
            }
            let body = '';
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 262144) throw Error('Too large');
            }
            const response = await handler({
              routeKey: req.method + ' ' + route,
              body: body || undefined,
              pathParameters: params,
              queryStringParameters: Object.fromEntries(url.searchParams),
              requestContext: {
                requestId: 'local-preview',
                http: { method: req.method },
                authorizer: {
                  jwt: {
                    claims: {
                      token_use: 'access',
                      sub: 'synthetic',
                      username: 'synthetic',
                      'cognito:groups': [ADMIN_GROUP],
                    },
                  },
                },
              },
            });
            res.statusCode = response.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(response.body);
          } catch {
            res.statusCode = 500;
            res.end('{"message":"Synthetic request failed"}');
          }
        });
      },
    },
  ],
});
await server.listen();
console.log('Local orders preview http://127.0.0.1:4180');
process.on('SIGINT', async () => {
  await server.close();
  await f.close();
  process.exit(0);
});
