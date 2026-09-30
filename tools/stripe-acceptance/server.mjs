import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  API,
  ORIGIN,
  setup,
  startRequest,
  preview,
  requireValue,
} from './contract.mjs';

export function configuration(env) {
  requireValue(env.NODE_ENV === 'development');
  requireValue(
    /^pk_test_[A-Za-z0-9]+$/.test(env.STRIPE_ACCEPTANCE_PUBLISHABLE_KEY ?? ''),
  );
  return {
    publishableKey: env.STRIPE_ACCEPTANCE_PUBLISHABLE_KEY,
    allowStart: env.STRIPE_ACCEPTANCE_ALLOW_START === 'true',
  };
}
export function handler(config, upstream = fetch) {
  async function call(path, options) {
    const response = await upstream(API + path, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    return response;
  }
  return async (req, res) => {
    const reply = (status, body, type = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; connect-src 'self' https://*.stripe.com; img-src https://*.stripe.com; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (
        req.headers.host !== '127.0.0.1:4242' ||
        !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      )
        return reply(403, { error: 'Local access required.' });
      if (req.headers.origin && req.headers.origin !== ORIGIN)
        return reply(403, { error: 'Local origin required.' });
      if (req.headers['sec-fetch-site'] === 'cross-site')
        return reply(403, { error: 'Local origin required.' });
      const files = {
        '/': 'index.html',
        '/browser.mjs': 'browser.mjs',
        '/flow.mjs': 'flow.mjs',
        '/contract.mjs': 'contract.mjs',
      };
      if (req.method === 'GET' && Object.hasOwn(files, req.url))
        return reply(
          200,
          await readFile(new URL(files[req.url], import.meta.url), 'utf8'),
          req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript',
        );
      if (req.method === 'GET' && req.url === '/config')
        return reply(200, config);
      if (req.method !== 'POST' || !['/cart', '/start'].includes(req.url))
        return reply(404, { error: 'Not found.' });
      if (
        req.headers.origin !== ORIGIN ||
        req.headers['x-acceptance-client'] !== 'loopback' ||
        req.headers['content-type'] !== 'application/json'
      )
        return reply(403, { error: 'Local JSON request required.' });
      if (req.url === '/start' && !config.allowStart)
        return reply(403, { error: 'Local payment submission disabled.' });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) return reply(413, { error: 'Request too large.' });
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/cart') {
        const { cartId, capability } = setup(value);
        const response = await call(`/carts/${cartId}`, {
          headers: { 'X-Cart-Token': capability },
        });
        if (!response.ok)
          return reply(400, {
            error: 'Cart unavailable. Verify capability and reservation.',
          });
        const cart = preview(
          await response.json(),
          response.headers.get('etag'),
          cartId,
        );
        const dropResponse = await call(`/drops/${cart.dropId}`, {});
        requireValue(dropResponse.ok);
        const { drop } = await dropResponse.json();
        requireValue(
          drop?.id === cart.dropId &&
            drop.status === 'OPEN' &&
            Array.isArray(drop.pickupDates),
        );
        cart.pickups = drop.pickupDates.map((p) => {
          requireValue(
            /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
              /^\d{2}:\d{2}$/.test(p.startTime) &&
              /^\d{2}:\d{2}$/.test(p.endTime) &&
              typeof p.timezone === 'string' &&
              p.timezone.length < 100,
          );
          return {
            date: p.date,
            startTime: p.startTime,
            endTime: p.endTime,
            timezone: p.timezone,
          };
        });
        requireValue(cart.pickups.length > 0);
        return reply(200, cart);
      }
      const request = startRequest(value);
      // Construct the upstream payload/headers explicitly: no arbitrary forwarding.
      const response = await call(`/carts/${request.cartId}/payment/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cart-Token': request.capability,
          'If-Match': request.etag,
          'Idempotency-Key': request.key,
        },
        body: JSON.stringify(request.body),
      });
      // Never forward raw provider/backend error payloads, secrets or customer data.
      return reply(200, {
        accepted: response.status === 201 || response.status === 200,
        status: response.status,
      });
    } catch {
      return reply(400, { error: 'Request could not be completed safely.' });
    }
  };
}
export function start(env = process.env) {
  const config = configuration(env);
  const server = createServer(handler(config));
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.on('error', () => {
    process.stderr.write('Local acceptance server failed.\n');
    process.exitCode = 1;
  });
  server.listen(4242, '127.0.0.1', () =>
    process.stdout.write(
      'DEV / STRIPE SANDBOX ACCEPTANCE ONLY: http://127.0.0.1:4242\n',
    ),
  );
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    start();
  } catch {
    process.stderr.write(
      'Local harness requires NODE_ENV=development and a sandbox publishable key.\n',
    );
    process.exitCode = 1;
  }
}
