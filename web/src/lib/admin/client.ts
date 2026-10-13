import type { Overview } from './contract';
export interface Snapshot {
  overview: Overview | null;
  loadedAt: string;
  expiresAt: number;
}
export class ClientFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function adminRequest(
  action: 'dashboard' | 'login' | 'challenge' | 'logout',
  body?: unknown,
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
) {
  const response = await transport(`/api/admin/${action}`, {
    method: action === 'dashboard' ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ClientFailure(
      response.status,
      typeof result.code === 'string' ? result.code : 'UNAVAILABLE',
      typeof result.message === 'string'
        ? result.message
        : 'Unable to load administrative information.',
    );
  return result;
}
