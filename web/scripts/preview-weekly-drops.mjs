// Explicit local-only preview using an isolated DynamoDB Local table. No AWS credentials.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
if (process.env.NODE_ENV === 'production') throw Error('Local preview only');
const require = createRequire(
  new URL('../../backend/package.json', import.meta.url),
);
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoCatalogRepository } = require('./dist/src/repository');
const { createHandler } = require('./dist/src/api');
const { catalogKeys } = require('./dist/src/keys');
const { ADMIN_GROUP } = require('./dist/src/admin-auth');
const raw = new DynamoDBClient({
  endpoint: 'http://127.0.0.1:18765',
  region: 'us-east-2',
  credentials: { accessKeyId: 'LOCALONLY', secretAccessKey: 'LOCALONLY' },
  maxAttempts: 1,
});
raw.middlewareStack.add(
  (next) => async (a) => {
    if (a.request.hostname !== '127.0.0.1' || a.request.port !== 18765)
      throw Error('Loopback only');
    return next(a);
  },
  { step: 'finalizeRequest', name: 'loopbackOnly' },
);
const table = 'bb-weekly-preview-' + randomUUID(),
  client = DynamoDBDocumentClient.from(raw);
await raw.send(
  new CreateTableCommand({
    TableName: table,
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  }),
);
for (let i = 1; i <= 3; i++) {
  const id = '01K0000000000000000000000' + i;
  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...catalogKeys.product(id),
        productId: id,
        name: ['Chocolate chip', 'Brown butter', 'Lemon sugar'][i - 1],
        slug: 'synthetic-' + i,
        description: 'Synthetic local cookie',
        ingredients: [],
        allergens: [],
        active: true,
        createdAt: '2026-10-01T12:00:00.000Z',
        updatedAt: '2026-10-01T12:00:00.000Z',
      },
    }),
  );
}
await client.send(
  new PutCommand({
    TableName: table,
    Item: {
      PK: 'PRODUCT_INTEGRITY#V1',
      SK: 'STATE',
      version: 1,
      state: 'READY',
    },
  }),
);
const handler = createHandler(() => new DynamoCatalogRepository(client, table));
const web = resolve(new URL('..', import.meta.url).pathname),
  root = await mkdtemp(join(tmpdir(), 'bb-weekly-preview-'));
await writeFile(
  join(root, 'index.html'),
  '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/preview.tsx"></script></body></html>',
);
await writeFile(
  join(root, 'preview.tsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import {WeeklyDrops} from '/@fs/${web}/src/components/admin/weekly-drops.tsx';import '/@fs/${web}/src/app/globals.css';import '/@fs/${web}/src/app/admin/admin.css';createRoot(document.getElementById('root')).render(<><p role="note">SYNTHETIC LOCAL ACCEPTANCE — isolated DynamoDB Local. No AWS. Scheduling unavailable.</p><WeeklyDrops expiresAt={Date.now()+900000}/></>);`,
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
    port: 4176,
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
            const path = url.pathname.replace('/api', ''),
              parts = path.split('/');
            let route = path;
            const params = {};
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
console.log('Local weekly preview http://127.0.0.1:4176');
process.on('SIGINT', async () => {
  await server.close();
  await raw.send(new DeleteTableCommand({ TableName: table }));
  raw.destroy();
  process.exit(0);
});
