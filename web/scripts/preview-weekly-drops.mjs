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
const { isolatedCatalog } = require('./dist/src/isolated-catalog');
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
const handler = isolatedCatalog(
  () => new DynamoCatalogRepository(client, table),
);
const web = resolve(new URL('..', import.meta.url).pathname),
  root = await mkdtemp(join(tmpdir(), 'bb-weekly-preview-'));
await writeFile(
  join(root, 'index.html'),
  '<html><link rel="icon" href="/brand/favicon-light.ico"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/preview.tsx"></script></body></html>',
);
await writeFile(
  join(root, 'preview.tsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import {WeeklyDrops} from '/@fs/${web}/src/components/admin/weekly-drops.tsx';import {DraftPreview} from '/@fs/${web}/src/components/storefront/draft-preview.tsx';import {previewData} from '/@fs/${web}/src/lib/admin/preview.ts';import '/@fs/${web}/src/app/globals.css';import '/@fs/${web}/src/app/customer.css';import '/@fs/${web}/src/app/admin/admin.css';
function App(){const [data,setData]=React.useState(null);const id=location.pathname.match(/^\\/admin\\/drops\\/([^/]+)\\/preview$/)?.[1];React.useEffect(()=>{if(id)fetch('/api/admin/drops/'+id+'/preview').then(r=>r.json()).then(d=>setData(previewData(d,id)));},[id]);return <><p role="note">SYNTHETIC LOCAL ACCEPTANCE — DynamoDB Local. No real authentication or AWS.</p>{id?(data?<DraftPreview data={data}/>:<p>Loading saved preview</p>):<WeeklyDrops isolated expiresAt={Date.now()+900000}/>}</>;}createRoot(document.getElementById('root')).render(<App/>);`,
);
await writeFile(
  join(root, 'image.tsx'),
  `import React from 'react';export default function Image({priority, sizes, ...props}){return <img {...props}/>;}`,
);
const server = await createServer({
  publicDir: resolve(web, 'public'),
  configFile: false,
  root,
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      'next/image': join(root, 'image.tsx'),
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
