// Explicit local-only preview using an isolated DynamoDB Local table. No AWS credentials.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
if (process.env.NODE_ENV === 'production') throw Error('Local preview only');
const { fixtures } =
  await import('../../backend/scripts/orders-local-fixtures.mjs');
const waitlistMode = process.argv.includes('--waitlists');
const refundMode = process.argv.includes('--refund-worklist');
const f = refundMode
  ? await (
      await import('../../backend/scripts/refund-worklist-local-fixtures.mjs')
    ).worklistFixtures()
  : await fixtures();
const { RefundWorklist } = createRequire(
  new URL('../../backend/package.json', import.meta.url),
)('./dist/src/refund-worklist');
const require = createRequire(
  new URL('../../backend/package.json', import.meta.url),
);
const { createHandler } = require('./dist/src/api');
const { ADMIN_GROUP } = require('./dist/src/admin-auth');
let waitlistService, waitlistCatalog;
if (waitlistMode) {
  const { Waitlists } = require('./dist/src/waitlists'),
    { MockEmailProvider } = require('./dist/src/notification-providers'),
    { DynamoCatalogRepository } = require('./dist/src/repository'),
    { PutCommand } = require('@aws-sdk/lib-dynamodb'),
    { catalogKeys } = require('./dist/src/keys'),
    fixture = require('./dist/test/fixtures');
  const put = async (key, value) =>
    f.client.send(
      new PutCommand({ TableName: f.table, Item: { ...key, ...value } }),
    );
  await put(catalogKeys.product(fixture.productId), fixture.product);
  await put(catalogKeys.drop(fixture.dropId), fixture.drop);
  await put(
    catalogKeys.dropProduct(fixture.dropId, fixture.productId),
    fixture.relation,
  );
  await put(catalogKeys.inventory(fixture.dropId, fixture.productId), {
    ...fixture.inventory,
    total: 0,
    reserved: 0,
    sold: 0,
  });
  await put(catalogKeys.storefront, {
    storefrontDropId: fixture.dropId,
    updatedAt: fixture.timestamp,
  });
  f.drops = [fixture.drop];
  waitlistCatalog = new DynamoCatalogRepository(f.client, f.table);
  waitlistCatalog.listDrops = async () => ({ drops: f.drops });
  const email = new MockEmailProvider();
  waitlistService = new Waitlists(
    f.client,
    f.table,
    f.table,
    f.table,
    Buffer.alloc(32, 7),
    'https://synthetic.example',
    {
      enqueue: async (m) => {
        await waitlistService.deliver(m);
      },
    },
    email,
  );
}
const handler = createHandler(
  () => waitlistCatalog ?? { listDrops: async () => ({ drops: f.drops }) },
  undefined,
  undefined,
  undefined,
  undefined,
  () => f.repository,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  () =>
    new RefundWorklist(f.client, f.table, f.table, () =>
      Date.parse('2026-10-22T18:00:00Z'),
    ),
  () => waitlistService,
);
const web = resolve(new URL('..', import.meta.url).pathname),
  root = await mkdtemp(join(tmpdir(), 'bb-orders-preview-'));
await writeFile(
  join(root, 'index.html'),
  '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/preview.tsx"></script></body></html>',
);
await writeFile(
  join(root, 'preview.tsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import {${waitlistMode ? 'WaitlistManagement' : refundMode ? 'RefundWorklistView' : 'Orders'} as Orders} from '/@fs/${web}/src/components/admin/${waitlistMode ? 'waitlists' : refundMode ? 'refund-worklist' : 'orders'}.tsx';import {JoinWaitlist} from '/@fs/${web}/src/components/storefront/waitlist.tsx';import '/@fs/${web}/src/app/globals.css';import '/@fs/${web}/src/app/admin/admin.css';createRoot(document.getElementById('root')).render(<><p role="note">SYNTHETIC LOCAL ACCEPTANCE — isolated DynamoDB Local. No AWS. Mock messages only.</p>${waitlistMode ? '<JoinWaitlist dropId="01K5J100000000000000000001" productId="01K5J100000000000000000002" name="Synthetic Cookie"/>' : ''}<Orders expiresAt={Date.now()+900000}/></>);`,
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
    port: 4177,
    strictPort: true,
    fs: { allow: [root, web] },
  },
  plugins: [
    {
      name: 'synthetic-weekly-api',
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (
            !req.url?.startsWith('/api/admin/') &&
            !(waitlistMode && req.url?.startsWith('/api/waitlist/'))
          )
            return next();
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
            if (waitlistMode) {
              if (path === '/waitlist/join') route = '/waitlists';
              if (path === '/waitlist/unsubscribe')
                route = '/waitlists/unsubscribe';
              if (path === '/admin/waitlists/list') route = '/admin/waitlists';
            }
            const params = {};
            if (parts[2] === 'orders' && parts[3]) {
              params.orderId = parts[3];
              route = '/admin/orders/{orderId}';
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
                http: { method: req.method, sourceIp: '127.0.0.1' },
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
console.log('Local orders preview http://127.0.0.1:4177');
process.on('SIGINT', async () => {
  await server.close();
  await f.close();
  process.exit(0);
});
