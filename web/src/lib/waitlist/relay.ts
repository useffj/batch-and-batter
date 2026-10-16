import { NextResponse } from 'next/server';
import { publicEndpoint } from '../storefront/client';
export async function boundedBody(request: Request, max = 2048) {
  const reader = request.body?.getReader();
  if (!reader) throw Error('Missing body');
  let size = 0,
    text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw Error('Body too large');
      }
      text += decoder.decode(r.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}
export async function waitlistRelay(
  request: Request,
  action: string,
  config: Parameters<typeof publicEndpoint>[0],
  fetcher: typeof fetch = fetch,
) {
  const output = (message: string, status: number) =>
    NextResponse.json(
      { message },
      {
        status,
        headers: {
          'Cache-Control': 'no-store, private',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  try {
    const url = new URL(request.url);
    if (request.method !== 'POST' || !['join', 'unsubscribe'].includes(action))
      return output('Unsupported request.', 405);
    if (
      url.search ||
      request.headers.get('origin') !== url.origin ||
      (request.headers.has('sec-fetch-site') &&
        request.headers.get('sec-fetch-site') !== 'same-origin') ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return output('Request not allowed.', 403);
    const body = await boundedBody(request);
    JSON.parse(body);
    const endpoint = publicEndpoint(config);
    endpoint.pathname = endpoint.pathname.replace(
      /\/drops\/current$/,
      '/waitlists' + (action === 'unsubscribe' ? '/unsubscribe' : ''),
    );
    const r = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    // No upstream contact data or error details are exposed through this public boundary.
    if (!r.ok)
      return output(
        r.status === 429
          ? 'Please wait a minute before trying again.'
          : r.status === 409
            ? 'This cookie is no longer eligible. Refresh availability before trying again.'
            : 'Unable to complete this request. Please check your details and retry.',
        [400, 409, 429].includes(r.status) ? r.status : 503,
      );
    return output(
      action === 'join'
        ? 'Your availability-alert request has been received. Cookies are first-come, first-served; joining does not reserve or guarantee availability.'
        : 'Availability alerts for this cookie and Drop are now stopped.',
      200,
    );
  } catch {
    return output(
      'Waitlist services are temporarily unavailable. Please retry.',
      503,
    );
  }
}
