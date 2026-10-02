// Public DTO presentation boundary; no backend runtime or credentials are imported.
export type DropState = 'SCHEDULED' | 'OPEN' | 'PAUSED' | 'SOLD_OUT' | 'CLOSED';
export interface StorefrontDrop {
  name: string;
  description: string;
  status: DropState;
  opensAt: string;
  timezone: string;
  pickupLocation: string;
  pickupInstructions: string;
  products: { name: string; priceCents: number; available: number }[];
  pickupDates: {
    date: string;
    startTime: string;
    endTime: string;
    timezone: string;
  }[];
}
export type StorefrontResult =
  | { kind: 'ready'; drop: StorefrontDrop | null }
  | { kind: 'unavailable' | 'invalid' };
const MAX_BYTES = 262144;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid public data');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4000, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw new Error('Invalid public data');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid public data');
  return value as number;
}
function zone(value: unknown): string {
  const result = text(value, 100);
  new Intl.DateTimeFormat('en-US', { timeZone: result }).format(0);
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Invalid public data');
  return value;
}
export function parseDropResponse(value: unknown): StorefrontDrop | null {
  const root = record(value);
  if (root.drop === null) return null;
  const d = record(root.drop);
  if (
    !['SCHEDULED', 'OPEN', 'PAUSED', 'SOLD_OUT', 'CLOSED'].includes(
      String(d.status),
    )
  )
    throw new Error('Invalid public data');
  const opensAt = text(d.opensAt, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(opensAt) ||
    !Number.isFinite(Date.parse(opensAt)) ||
    new Date(opensAt).toISOString().slice(0, 10) !== opensAt.slice(0, 10)
  )
    throw new Error('Invalid public data');
  return {
    name: text(d.name, 300),
    description: text(d.description, 4000, true),
    status: d.status as DropState,
    opensAt,
    timezone: zone(d.timezone),
    pickupLocation: text(d.pickupLocation),
    pickupInstructions: text(d.pickupInstructions, 4000, true),
    products: list(d.products).map((value) => {
      const p = record(value),
        a = record(p.availability);
      const total = integer(a.total),
        reserved = integer(a.reserved),
        sold = integer(a.sold),
        available = integer(a.available);
      if (reserved > total - sold || available !== total - reserved - sold)
        throw new Error('Invalid public data');
      return {
        name: text(p.name, 300),
        priceCents: integer(p.priceCents),
        available,
      };
    }),
    pickupDates: list(d.pickupDates).map((value) => {
      const p = record(value),
        date = text(p.date, 10),
        startTime = text(p.startTime, 5),
        endTime = text(p.endTime, 5);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
        endTime <= startTime
      )
        throw new Error('Invalid public data');
      return { date, startTime, endTime, timezone: zone(p.timezone) };
    }),
  };
}
export function publicEndpoint(source: {
  STOREFRONT_API_BASE_URL?: string;
  STOREFRONT_CURRENCY?: string;
  NODE_ENV?: string;
}): URL {
  // The public contract supplies cents but no currency. Require explicit USD setup.
  if (source.STOREFRONT_CURRENCY !== 'USD' || !source.STOREFRONT_API_BASE_URL)
    throw new Error('Invalid storefront configuration');
  const url = new URL(source.STOREFRONT_API_BASE_URL);
  const local =
    source.NODE_ENV === 'development' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid storefront configuration');
  url.pathname = url.pathname.replace(/\/$/, '') + '/drops/current';
  return url;
}
export async function loadStorefront(
  source: Parameters<typeof publicEndpoint>[0],
  request: typeof fetch = fetch,
): Promise<StorefrontResult> {
  let endpoint: URL;
  try {
    endpoint = publicEndpoint(source);
  } catch {
    return { kind: 'unavailable' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await request(endpoint, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { kind: 'unavailable' };
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      ) ||
      !response.body
    )
      return { kind: 'invalid' };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return { kind: 'invalid' };
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return {
        kind: 'ready',
        drop: parseDropResponse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ),
      };
    } catch {
      return { kind: 'invalid' };
    }
  } catch {
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => undefined);
  }
}
