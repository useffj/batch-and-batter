// Explicit local-preview fixture. Never imported by a deployable route/component.
import type { Manifest } from '../src/lib/admin/gallery-client';
export function mediaFixture(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const retired = new Set<string>();
  const saved = storage?.getItem('bb-synthetic-media-manifests');
  const manifests = new Map<string, Manifest>(saved ? JSON.parse(saved) : []);
  const uploads = new Map<
    string,
    {
      uploadId: string;
      mediaId: string;
      state: string;
      productId: string;
      expiresAt: number;
      polls: number;
      request: string;
      authorizationExpiresAt: number;
    }
  >(JSON.parse(storage?.getItem('bb-synthetic-media-uploads') ?? '[]'));
  let conflict = false,
    lost = false,
    enabled = false,
    unauthorized = false,
    counter = 10 + uploads.size;
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const manifest = (productId: string) => {
    if (!manifests.has(productId))
      manifests.set(productId, {
        version: 1,
        productId,
        revision: 1,
        images: [
          {
            mediaId: '01K00000000000000000000003',
            alt: 'Synthetic front view',
          },
          {
            mediaId: '01K00000000000000000000004',
            alt: 'Synthetic crumb view',
          },
        ],
      });
    return manifests.get(productId)!;
  };
  const persist = () =>
    storage?.setItem(
      'bb-synthetic-media-manifests',
      JSON.stringify([...manifests]),
    );
  const persistUploads = () =>
    storage?.setItem(
      'bb-synthetic-media-uploads',
      JSON.stringify([...uploads]),
    );
  const dto = (u: NonNullable<ReturnType<typeof uploads.get>>) => ({
    productId: u.productId,
    uploadId: u.uploadId,
    mediaId: u.mediaId,
    state: u.state,
    expiresAt: u.expiresAt,
    ...(u.state === 'READY'
      ? {
          result: {
            productId: u.productId,
            mediaId: u.mediaId,
            revision: 1,
            state: 'READY',
            width: 480,
            height: 480,
            variants: ['jpeg', 'webp'].map((format) => ({
              size: 480,
              format,
              width: 480,
              height: 480,
              bytes: 100,
            })),
          },
        }
      : {}),
  });
  return {
    conflict: () => {
      conflict = true;
    },
    lost: () => {
      lost = true;
    },
    enable: () => {
      enabled = true;
    },
    deny: () => {
      unauthorized = true;
    },
    async handle(url: URL, init: RequestInit): Promise<Response | undefined> {
      const match = url.pathname.match(
        /^\/api\/admin\/products\/([^/]+)\/media(.*)$/,
      );
      if (!match) return;
      if (unauthorized) return reply({ code: 'UNAUTHENTICATED' }, 401);
      const [, productId, suffix] = match,
        method = init.method ?? 'GET';
      if (!suffix && url.searchParams.get('view') === 'ready') {
        const m = manifest(productId);
        const candidates = [
          {
            productId,
            mediaId: '01K00000000000000000000005',
            state: 'READY',
            uploadId: 'f'.repeat(64),
            expiresAt: 0,
            polls: 0,
          },
          ...[...uploads.values()].filter(
            (u) => u.productId === productId && u.state === 'READY',
          ),
        ]
          .filter(
            (u) =>
              !m.images.some((i) => i.mediaId === u.mediaId) &&
              !retired.has(productId + ':' + u.mediaId),
          )
          .sort((a, b) => a.mediaId.localeCompare(b.mediaId));
        const after = url.searchParams.get('after')?.split('.')[1];
        const available = candidates.filter((a) => !after || a.mediaId > after);
        const page = available.slice(0, 12);
        return reply({
          assets: page.map(
            (a) => dto(a as NonNullable<ReturnType<typeof uploads.get>>).result,
          ),
          nextCursor:
            available.length > 12
              ? productId + '.' + page.at(-1)!.mediaId
              : null,
        });
      }
      if (!suffix) {
        const m = manifest(productId);
        if (method === 'GET') return reply({ manifest: m });
        const req = JSON.parse(String(init.body));
        if (conflict) {
          conflict = false;
          m.revision++;
          m.images[0].alt = 'Changed by another synthetic administrator';
          persist();
        }
        if (req.expectedRevision !== m.revision)
          return reply({ code: 'MEDIA_REVISION_CONFLICT' }, 409);
        for (const old of m.images)
          if (
            !req.images.some(
              (i: { mediaId: string }) => i.mediaId === old.mediaId,
            )
          )
            retired.add(productId + ':' + old.mediaId);
        m.revision++;
        m.images = structuredClone(req.images);
        persist();
        if (lost) {
          lost = false;
          throw new Error('Synthetic lost acknowledgement');
        }
        return reply({ manifest: m });
      }
      if (suffix === '/uploads') {
        if (!enabled) return reply({ code: 'MEDIA_UPLOAD_UNAVAILABLE' }, 503);
        const key = new Headers(init.headers).get('Idempotency-Key')!;
        let u = uploads.get(key);
        if (!u) {
          u = {
            productId,
            uploadId: (++counter).toString(16).padStart(64, '0'),
            mediaId: '01K000000000000000' + String(counter).padStart(8, '0'),
            state: 'PENDING',
            expiresAt: Date.now() + 900000,
            polls: 0,
            request: String(init.body),
            authorizationExpiresAt:
              Math.floor((Date.now() + 60000) / 1000) * 1000,
          };
          uploads.set(key, u);
          persistUploads();
        }
        if (u.productId !== productId || u.request !== String(init.body))
          return reply({ code: 'UPLOAD_CONFLICT' }, 409);
        if (u.state === 'READY') return reply({ upload: dto(u) });
        if (Date.now() >= u.expiresAt)
          return reply({ code: 'UPLOAD_EXPIRED' }, 410);
        if (u.state !== 'PENDING')
          return reply({ code: 'UPLOAD_PENDING' }, 409);
        const req = JSON.parse(String(init.body)),
          expiresAt = u.authorizationExpiresAt;
        const fields: Record<string, string> = {
          'Content-Type': req.contentType,
          'x-amz-checksum-algorithm': 'SHA256',
          'x-amz-checksum-sha256': btoa(
            String.fromCharCode(
              ...req.sha256.match(/../g).map((v: string) => parseInt(v, 16)),
            ),
          ),
          'x-amz-server-side-encryption': 'AES256',
          success_action_status: '204',
          bucket: 'batch-and-batter-dev-product-media-302154194958-us-east-2',
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Credential': 'LOCALONLY',
          'X-Amz-Date': '20261015T000000Z',
          'X-Amz-Security-Token': 'LOCALONLY',
          key: `staging/products/${productId}/${u.uploadId}/source`,
        };
        fields.Policy = btoa(
          JSON.stringify({
            expiration: new Date(expiresAt).toISOString(),
            conditions: [
              ...Object.entries(fields).map(([k, v]) => ({ [k]: v })),
              ['content-length-range', req.bytes, req.bytes],
            ],
          }),
        );
        fields['X-Amz-Signature'] = 'synthetic-only';
        return reply({
          upload: dto(u),
          authorization: {
            url: 'https://batch-and-batter-dev-product-media-302154194958-us-east-2.s3.us-east-2.amazonaws.com/',
            fields,
            expiresAt,
          },
        });
      }
      const u = [...uploads.values()].find(
        (u) => suffix.includes(u.uploadId) && u.productId === productId,
      );
      if (!u) return reply({ code: 'UPLOAD_NOT_FOUND' }, 404);
      if (!['READY', 'FAILED'].includes(u.state) && Date.now() >= u.expiresAt)
        return reply({ code: 'UPLOAD_EXPIRED' }, 410);
      if (suffix.endsWith('/complete')) {
        if (Date.now() >= u.expiresAt)
          return reply({ code: 'UPLOAD_EXPIRED' }, 410);
        u.state = 'PROCESSING';
        persistUploads();
        return reply({ upload: dto(u) }, 202);
      }
      if (u.state === 'PROCESSING' && ++u.polls >= 2) u.state = 'READY';
      persistUploads();
      return reply({ upload: dto(u) });
    },
  };
}
