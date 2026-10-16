import { NextResponse } from 'next/server';
import { sameOrigin } from '../cart/relay';
import { publicEndpoint } from '../storefront/client';
export async function guestRelay(
  request: Request,
  action: string,
  config: Parameters<typeof publicEndpoint>[0],
  fetcher: typeof fetch = fetch,
) {
  const output = (value: unknown, status: number) =>
    NextResponse.json(value, {
      status,
      headers: {
        'Cache-Control': 'no-store, private',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  try {
    if (
      request.method !== 'POST' ||
      !['view', 'pickup', 'request'].includes(action)
    )
      return output({ message: 'Unsupported request.' }, 405);
    const url = new URL(request.url);
    if (
      url.search ||
      !sameOrigin(request) ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return output({ message: 'Request not allowed.' }, 403);
    const reader = request.body?.getReader();
    if (!reader) return output({ message: 'Invalid request.' }, 400);
    let bytes = 0,
      text = '';
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2048) {
          await reader.cancel();
          return output({ message: 'Invalid request.' }, 400);
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.token) ||
      Object.keys(body).some(
        (k) =>
          !(
            action === 'view'
              ? ['token']
              : action === 'request'
                ? ['token', 'request']
                : ['token', 'date', 'requestId', 'revision']
          ).includes(k),
      )
    )
      return output({ message: 'This order link is unavailable.' }, 400);
    const endpoint = publicEndpoint(config);
    endpoint.pathname = endpoint.pathname.replace(
      /\/drops\/current$/,
      '/orders/manage/' + action,
    );
    const r = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok)
      return output(
        {
          message:
            r.status === 403
              ? 'This order link is unavailable or expired. Contact the bakery.'
              : r.status === 429
                ? 'Please wait a minute before trying again.'
                : 'Unable to complete this action. Refresh your order or contact the bakery.',
        },
        [400, 403, 404, 409, 429].includes(r.status) ? r.status : 503,
      );
    const responseReader = r.body?.getReader();
    if (!responseReader) throw Error();
    let result = '',
      size = 0;
    const d = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await responseReader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await responseReader.cancel();
          throw Error();
        }
        result += d.decode(value, { stream: true });
      }
    } finally {
      responseReader.releaseLock();
    }
    result += d.decode();
    return output(JSON.parse(result), 200);
  } catch {
    return output(
      { message: 'Order management is temporarily unavailable. Please retry.' },
      503,
    );
  }
}
