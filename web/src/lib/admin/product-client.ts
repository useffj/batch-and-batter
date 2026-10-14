import { ClientFailure } from './client';
export async function productRequest(
  path = '',
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
  creationKey?: string,
) {
  const response = await transport('/api/admin/products' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      ...(creationKey ? { 'Idempotency-Key': creationKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ClientFailure(
      response.status,
      typeof data.code === 'string' ? data.code : 'UNAVAILABLE',
      typeof data.message === 'string'
        ? data.message
        : 'Product services are unavailable.',
    );
  return data;
}
// Synchronous guard also covers two submits before React renders disabled state.
export function submissionGate() {
  let busy = false;
  return async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
  };
}
