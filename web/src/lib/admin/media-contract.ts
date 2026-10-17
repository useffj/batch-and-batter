import { id, record } from './contract';
export type MediaTarget = {
  productId: string;
  kind: 'manifest' | 'uploads' | 'status' | 'complete' | 'asset' | 'ready';
  after?: string;
  itemId?: string;
};
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error('Invalid media fields');
};
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER - 1) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error('Invalid media integer');
  return v;
};
export function mediaPath(t: MediaTarget, method: string) {
  let path = `/admin/products/${id(t.productId)}/media`;
  if (
    !{
      manifest: ['GET', 'PUT'],
      ready: ['GET'],
      uploads: ['POST'],
      status: ['GET'],
      complete: ['POST'],
      asset: ['GET'],
    }[t.kind].includes(method)
  )
    throw new Error('Invalid media method');
  if (t.kind === 'ready') {
    if (
      t.after !== undefined &&
      (t.after.split('.').length !== 2 ||
        t.after.split('.')[0] !== t.productId ||
        id(t.after.split('.')[1]) !== t.after.split('.')[1])
    )
      throw new Error('Invalid cursor');
    return (
      path +
      '?view=ready' +
      (t.after ? '&after=' + encodeURIComponent(t.after) : '')
    );
  }
  if (t.kind === 'uploads') return path + '/uploads';
  if (t.kind === 'asset') return path + '/assets/' + id(t.itemId);
  if (t.kind === 'status' || t.kind === 'complete') {
    if (!/^[a-f0-9]{64}$/.test(t.itemId ?? ''))
      throw new Error('Invalid upload');
    path += '/uploads/' + t.itemId;
    if (t.kind === 'complete') path += '/complete';
  }
  return path;
}
export function mediaInput(value: unknown, kind: MediaTarget['kind']) {
  const v = record(value);
  if (kind === 'complete') {
    exact(v, []);
    return {};
  }
  if (kind === 'uploads') {
    exact(v, ['contentType', 'bytes', 'sha256']);
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(
        String(v.contentType),
      ) ||
      typeof v.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(v.sha256)
    )
      throw new Error('Invalid upload');
    return {
      contentType: v.contentType,
      bytes: integer(v.bytes, 1, 8 * 1024 * 1024),
      sha256: v.sha256,
    };
  }
  exact(v, ['expectedRevision', 'images']);
  return {
    expectedRevision: integer(v.expectedRevision),
    images: images(v.images),
  };
}
function images(value: unknown) {
  if (!Array.isArray(value) || value.length > 6)
    throw new Error('Invalid images');
  const result = value.map((x) => {
    const v = record(x);
    exact(v, ['mediaId', 'alt']);
    if (typeof v.alt !== 'string' || !v.alt.trim() || v.alt.trim().length > 160)
      throw new Error('Invalid alt');
    return { mediaId: id(v.mediaId), alt: v.alt.trim() };
  });
  if (new Set(result.map((x) => x.mediaId)).size !== result.length)
    throw new Error('Duplicate image');
  return result;
}
function asset(value: unknown, productId: string) {
  const a = record(value);
  exact(a, [
    'productId',
    'mediaId',
    'revision',
    'state',
    'width',
    'height',
    'variants',
  ]);
  if (
    a.productId !== productId ||
    !['READY', 'ATTACHED', 'RETIRED', 'DELETING', 'DELETED'].includes(
      String(a.state),
    ) ||
    !Array.isArray(a.variants) ||
    a.variants.length < 2 ||
    a.variants.length > 6
  )
    throw new Error('Invalid asset');
  return {
    productId: id(a.productId),
    mediaId: id(a.mediaId),
    revision: integer(a.revision, 1),
    state: a.state,
    width: integer(a.width, 480, 8000),
    height: integer(a.height, 480, 8000),
    variants: a.variants.map((x) => {
      const v = record(x);
      exact(v, ['size', 'format', 'width', 'height', 'bytes']);
      if (
        ![480, 960, 1600].includes(Number(v.size)) ||
        !['jpeg', 'webp'].includes(String(v.format))
      )
        throw new Error('Invalid variant');
      return {
        size: integer(v.size),
        format: v.format,
        width: integer(v.width, 1, 1600),
        height: integer(v.height, 1, 1600),
        bytes: integer(v.bytes, 1, 1048576),
      };
    }),
  };
}
export function mediaResponse(
  value: unknown,
  t: MediaTarget,
  isolated = false,
) {
  const v = record(value);
  if (t.kind === 'ready') {
    exact(v, ['assets', 'nextCursor']);
    if (!Array.isArray(v.assets) || v.assets.length > 12)
      throw new Error('Invalid discovery');
    const assets = v.assets.map((x) => asset(x, t.productId));
    if (
      assets.some((a) => a.state !== 'READY') ||
      new Set(assets.map((a) => a.mediaId)).size !== assets.length
    )
      throw new Error('Invalid discovery');
    if (v.nextCursor !== null) {
      if (typeof v.nextCursor !== 'string') throw new Error('Invalid cursor');
      mediaPath({ ...t, after: v.nextCursor }, 'GET');
    }
    return { assets, nextCursor: v.nextCursor as string | null };
  }
  if (t.kind === 'manifest') {
    exact(v, ['manifest']);
    const m = record(v.manifest);
    exact(m, ['version', 'productId', 'revision', 'images']);
    if (m.version !== 1 || m.productId !== t.productId)
      throw new Error('Invalid manifest');
    return {
      manifest: {
        version: 1,
        productId: id(m.productId),
        revision: integer(m.revision),
        images: images(m.images),
      },
    };
  }
  if (t.kind === 'asset') {
    exact(v, ['asset']);
    const a = asset(v.asset, t.productId);
    if (a.mediaId !== t.itemId) throw new Error('Invalid asset');
    return { asset: a };
  }
  exact(v, ['upload', 'authorization']);
  const u = record(v.upload);
  exact(u, [
    'productId',
    'uploadId',
    'mediaId',
    'state',
    'expiresAt',
    'result',
  ]);
  if (
    u.productId !== t.productId ||
    typeof u.uploadId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(u.uploadId) ||
    (t.itemId && u.uploadId !== t.itemId) ||
    !['PENDING', 'QUEUED', 'PROCESSING', 'READY', 'FAILED'].includes(
      String(u.state),
    )
  )
    throw new Error('Invalid upload');
  const result = u.result ? asset(u.result, t.productId) : undefined;
  if (
    (u.state === 'READY') !== !!result ||
    (result && result.mediaId !== u.mediaId)
  )
    throw new Error('Invalid result');
  const authorization =
    v.authorization === undefined
      ? undefined
      : uploadAuthorization(v.authorization, t.productId, u.uploadId, isolated);
  if (authorization && (t.kind !== 'uploads' || u.state !== 'PENDING'))
    throw new Error('Unexpected authorization');
  return {
    ...(authorization ? { authorization } : {}),
    upload: {
      productId: id(u.productId),
      uploadId: u.uploadId,
      mediaId: id(u.mediaId),
      state: u.state,
      expiresAt: integer(u.expiresAt),
      ...(result ? { result } : {}),
    },
  };
}
export const mediaErrorCodes = [
  'INVALID_MEDIA_CURSOR',
  'PRODUCT_NOT_FOUND',
  'ASSET_NOT_FOUND',
  'UPLOAD_NOT_FOUND',
  'PRODUCT_WRITES_NOT_READY',
  'MEDIA_STORAGE_UNAVAILABLE',
  'MEDIA_RECORD_INVALID',
  'UPLOAD_AUTHORIZATION_EXPIRED',
  'ATTEMPTS_EXHAUSTED',
  'UPLOAD_EXPIRED',
  'UPLOAD_RESULT_EXPIRED',
  'UPLOAD_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'MEDIA_REVISION_CONFLICT',
  'ASSET_STATE_CONFLICT',
  'PRODUCT_CONFLICT',
  'PRODUCT_INTEGRITY_CONFLICT',
  'PROCESSING_CONFLICT',
  'MEDIA_UPLOAD_UNAVAILABLE',
  'MEDIA_PROCESSOR_UNAVAILABLE',
  'MEDIA_PAYLOAD_TOO_LARGE',
  'VALIDATION_ERROR',
];

function uploadAuthorization(
  value: unknown,
  productId: string,
  uploadId: string,
  isolated = false,
) {
  const a = record(value);
  exact(a, ['url', 'fields', 'expiresAt']);
  const bucket = isolated
    ? 'batch-and-batter-dev-isolated-media-302154194958-us-east-2'
    : 'batch-and-batter-dev-product-media-302154194958-us-east-2';
  const destination = `https://${bucket}.s3.us-east-2.amazonaws.com/`;
  if (a.url !== destination) throw new Error('Invalid upload destination');
  const fields = record(a.fields),
    allowed = [
      'Content-Type',
      'x-amz-checksum-algorithm',
      'x-amz-checksum-sha256',
      'x-amz-server-side-encryption',
      'success_action_status',
      'bucket',
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Security-Token',
      'key',
      'Policy',
      'X-Amz-Signature',
    ];
  exact(fields, allowed);
  if (
    allowed.some(
      (k) =>
        typeof fields[k] !== 'string' ||
        !fields[k] ||
        (fields[k] as string).length > 12000,
    )
  )
    throw new Error('Invalid authorization fields');
  if (
    fields.key !== `staging/products/${productId}/${uploadId}/source` ||
    fields.bucket !== bucket ||
    fields['x-amz-checksum-algorithm'] !== 'SHA256' ||
    fields['x-amz-server-side-encryption'] !== 'AES256' ||
    fields.success_action_status !== '204' ||
    fields['X-Amz-Algorithm'] !== 'AWS4-HMAC-SHA256' ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(
      String(fields['Content-Type']),
    ) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(String(fields['x-amz-checksum-sha256']))
  )
    throw new Error('Invalid upload policy fields');
  const policy = record(JSON.parse(atob(fields.Policy as string)));
  if (
    !Array.isArray(policy.conditions) ||
    Date.parse(String(policy.expiration)) !== a.expiresAt
  )
    throw new Error('Invalid upload policy');
  const conditions = policy.conditions as unknown[];
  for (const field of allowed.filter(
    (k) => k !== 'Policy' && k !== 'X-Amz-Signature',
  ))
    if (
      !conditions.some(
        (v) =>
          v !== null &&
          typeof v === 'object' &&
          !Array.isArray(v) &&
          (v as Record<string, unknown>)[field] === fields[field],
      )
    )
      throw new Error('Unsigned upload field');
  if (
    !conditions.some(
      (v) =>
        Array.isArray(v) &&
        v.length === 3 &&
        v[0] === 'content-length-range' &&
        Number.isSafeInteger(v[1]) &&
        v[1] >= 1 &&
        v[1] <= 8388608 &&
        v[1] === v[2],
    )
  )
    throw new Error('Invalid upload size restriction');
  const expiresAt = integer(a.expiresAt);
  if (expiresAt <= Date.now() || expiresAt > Date.now() + 300000)
    throw new Error('Expired authorization');
  return {
    url: destination,
    fields: fields as Record<string, string>,
    expiresAt,
  };
}
