import { it, expect, vi } from 'vitest';
import { GalleryModel, mediaClient, type MediaCall } from './gallery-client';
import { GalleryUpload } from './gallery-upload';
import { mediaFixture } from '../../../scripts/media-fixture';
import { ClientFailure } from './client';
const productId = '01K00000000000000000000001';
function setup() {
  const fixture = mediaFixture();
  const requests: { url: string; init: RequestInit }[] = [];
  const transport: typeof fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const result = await fixture.handle(
      new URL(String(url), 'https://local.test'),
      init,
    );
    if (!result) throw new Error('Unmocked request');
    return result;
  };
  const call = mediaClient(transport);
  return { fixture, requests, call, model: new GalleryModel(productId, call) };
}
it('loads persisted order/IDs/alt, saves primary and retrieves same result on remount', async () => {
  const s = setup();
  await s.model.load();
  const original = s.model.state.draft;
  s.model.edit([...original].reverse());
  await s.model.save();
  expect(s.model.state.manifest?.revision).toBe(2);
  const remount = new GalleryModel(productId, s.call);
  await remount.load();
  expect(remount.state.draft).toEqual([...original].reverse());
});
it('alt edits/removal persist, cancel restores authoritative data', async () => {
  const s = setup();
  await s.model.load();
  s.model.edit([{ ...s.model.state.draft[1], alt: 'New alt' }]);
  await s.model.save();
  await s.model.load();
  expect(s.model.state.draft).toHaveLength(1);
  expect(s.model.state.draft[0].alt).toBe('New alt');
  s.model.edit([]);
  s.model.cancel();
  expect(s.model.state.draft).toHaveLength(1);
});
it('empty manifest is valid and does not invent images', async () => {
  const s = setup();
  await s.model.load();
  s.model.edit([]);
  await s.model.save();
  await s.model.load();
  expect(s.model.state.draft).toEqual([]);
});
it('conflict preserves edits and blocks overwrite until explicit reload', async () => {
  const s = setup();
  await s.model.load();
  s.model.edit([...s.model.state.draft].reverse());
  const draft = s.model.state.draft;
  s.fixture.conflict();
  await s.model.save();
  expect(s.model.state.blocked).toBe(true);
  expect(s.model.state.draft).toEqual(draft);
  const count = s.requests.length;
  await s.model.save();
  expect(s.requests).toHaveLength(count);
  await s.model.load();
  expect(s.requests).toHaveLength(count);
  await s.model.load(true);
  expect(s.model.state.blocked).toBe(false);
  expect(s.model.state.draft[0].alt).toContain('another');
});
it('lost response reconciles durable manifest without another PUT', async () => {
  const s = setup();
  await s.model.load();
  s.model.edit([...s.model.state.draft].reverse());
  s.fixture.lost();
  await s.model.save();
  expect(s.model.state.message).toBe('Gallery saved.');
  expect(s.requests.filter((r) => r.init.method === 'PUT')).toHaveLength(1);
  expect(s.model.dirty).toBe(false);
});
it('failed reconciliation blocks retries until authoritative read succeeds', async () => {
  const s = setup();
  let failed = false;
  const call: MediaCall = async (...args) => {
    if (args[1] === 'PUT') {
      failed = true;
      throw new Error('lost');
    }
    if (failed) throw new Error('offline');
    return s.call(...args);
  };
  const m = new GalleryModel(productId, call);
  await m.load();
  m.edit([]);
  await m.save();
  expect(m.uncertain).toBe(true);
  expect(m.state.blocked).toBe(true);
  m.cancel();
  expect(m.state.draft).toEqual([]);
  failed = false;
  await m.recover();
  expect(m.state.blocked).toBe(false);
  expect(m.dirty).toBe(true);
});
it('ambiguous save with differing authoritative result stays blocked', async () => {
  const s = setup();
  await s.model.load();
  s.model.edit([]);
  s.fixture.conflict();
  const call: MediaCall = async (...args) => {
    if (args[1] === 'PUT') {
      try {
        await s.call(...args);
      } catch {
        throw new Error('lost conflict');
      }
    }
    return s.call(...args);
  };
  const m = new GalleryModel(productId, call);
  await m.load();
  m.edit([]);
  await m.save();
  expect(m.state.blocked).toBe(true);
  expect(m.state.draft).toEqual([]);
});
it('synchronous guard prevents double save', async () => {
  const s = setup();
  await s.model.load();
  s.model.edit([]);
  await Promise.all([s.model.save(), s.model.save()]);
  expect(s.requests.filter((r) => r.init.method === 'PUT')).toHaveLength(1);
});
it('blank or overlong alt cannot save; gallery cannot exceed six or duplicate IDs', async () => {
  const s = setup();
  await s.model.load();
  for (const alt of [' ', 'x'.repeat(161)]) {
    s.model.edit([{ ...s.model.state.draft[0], alt }]);
    await s.model.save();
  }
  expect(s.requests.filter((r) => r.init.method === 'PUT')).toHaveLength(0);
  const before = s.model.state.draft;
  s.model.edit(Array(7).fill(before[0]));
  expect(s.model.state.draft).toBe(before);
  s.model.edit([before[0], before[0]]);
  expect(s.model.state.draft).toBe(before);
});
it('client uses fixed same-origin routes and no-store; errors do not echo provider text', async () => {
  const s = setup();
  await s.model.load();
  expect(s.requests[0].url).toBe(`/api/admin/products/${productId}/media`);
  expect(s.requests[0].init).toMatchObject({
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  s.fixture.deny();
  await s.model.load(true);
  expect(s.model.state.message).toContain('Sign in');
});
it('client rejects arbitrary paths, private response fields and oversized responses', async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          manifest: {
            version: 1,
            productId,
            revision: 0,
            images: [],
            token: 'private',
          },
        }),
      ),
  );
  const call = mediaClient(transport);
  await expect(
    call({ productId: '../escape', kind: 'manifest' }),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  await expect(call({ productId, kind: 'manifest' })).rejects.toThrow();
  await expect(
    mediaClient(async () => new Response('x'.repeat(33000)))({
      productId,
      kind: 'manifest',
    }),
  ).rejects.toThrow();
});
const file = () =>
  new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
    'synthetic.png',
    { type: 'image/png' },
  );
const runtime = {
  decode: async () => ({ width: 640, height: 480, close: () => {} }),
  create: () => '',
  revoke: () => {},
};
it('upload unavailable retains one identity across explicit retries and duplicate clicks', async () => {
  const s = setup();
  const u = new GalleryUpload(productId, s.call);
  await u.select(file(), runtime);
  await Promise.all([u.run(), u.run()]);
  expect(u.state.phase).toBe('unavailable');
  await u.run();
  const posts = s.requests.filter((r) => r.init.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(
    new Set(
      posts.map((r) => new Headers(r.init.headers).get('Idempotency-Key')),
    ).size,
  ).toBe(1);
});
it('production never transfers bytes even if authorization is returned', async () => {
  const s = setup();
  s.fixture.enable();
  const u = new GalleryUpload(productId, s.call);
  await u.select(file(), runtime);
  await u.run();
  expect(u.state.phase).toBe('unavailable');
  expect(s.requests.every((r) => r.url.startsWith('/api/admin/'))).toBe(true);
  expect(JSON.stringify(u.state)).not.toMatch(/Policy|Signature|LOCALONLY/);
  expect(s.requests.some((r) => r.url.endsWith('/complete'))).toBe(false);
});
it('isolated transfer exposes progress, processing and ready without attachment', async () => {
  const s = setup();
  s.fixture.enable();
  const transfer = vi.fn(async () => {});
  const u = new GalleryUpload(productId, s.call, transfer);
  const phases: string[] = [];
  u.subscribe(() => phases.push(u.state.phase));
  await u.select(file(), runtime);
  await u.run();
  expect(u.state.phase).toBe('processing');
  await u.run();
  await u.run();
  expect(u.state.phase).toBe('ready');
  expect(transfer).toHaveBeenCalledOnce();
  expect(phases).toEqual(
    expect.arrayContaining([
      'selected',
      'authorizing',
      'uploading',
      'requested',
      'processing',
      'ready',
    ]),
  );
  expect(s.requests.some((r) => r.init.method === 'PUT')).toBe(false);
  await u.run();
  expect(transfer).toHaveBeenCalledOnce();
});
for (const [status, code, phase] of [
  [410, 'UPLOAD_EXPIRED', 'expired'],
  [422, 'UPLOAD_FAILED', 'failed'],
  [503, 'MEDIA_PROCESSOR_UNAVAILABLE', 'unavailable'],
] as const)
  it(`upload handles ${code} without success`, async () => {
    const u = new GalleryUpload(productId, async () => {
      throw new ClientFailure(status, code, 'private');
    });
    await u.select(file(), runtime);
    await u.run();
    expect(u.state.phase).toBe(phase);
    expect(u.state.mediaId).toBeUndefined();
    expect(u.state.message).not.toContain('private');
  });
it('new file cannot silently replace pending upload identity', async () => {
  const s = setup();
  const u = new GalleryUpload(productId, s.call);
  await u.select(file(), runtime);
  await u.run();
  await u.select(
    new File(['bad'], 'another.png', { type: 'image/png' }),
    runtime,
  );
  expect(u.state.name).toBe('synthetic.png');
  u.reset();
  expect(u.state.name).toBe('');
});
it('file validation enforces minimum dimensions before intent reservation', async () => {
  const s = setup();
  const u = new GalleryUpload(productId, s.call);
  await u.select(file(), {
    ...runtime,
    decode: async () => ({ width: 479, height: 480, close: () => {} }),
  });
  expect(u.state.phase).toBe('failed');
  await u.run();
  expect(s.requests).toHaveLength(0);
});

function recoveryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
const recoveryKey = 'bb-gallery-upload:' + productId;
it('empty reload does not issue an upload request', async () => {
  const s = setup(),
    storage = recoveryStorage();
  const u = new GalleryUpload(productId, s.call);
  await u.restore(storage, 'administrator:session-one');
  await u.run();
  expect(s.requests).toHaveLength(0);
  expect(u.state.name).toBe('');
});
it('known-ID reload reads protected status, requires original file, rejects changed bytes and preserves UUID', async () => {
  const s = setup(),
    storage = recoveryStorage();
  s.fixture.enable();
  const first = new GalleryUpload(productId, s.call);
  await first.restore(storage, 'session-one');
  await first.select(file(), runtime);
  await first.run();
  const original = storage.getItem(recoveryKey)!;
  const next = new GalleryUpload(productId, s.call);
  const before = s.requests.length;
  await next.restore(storage, 'session-one');
  expect(s.requests.slice(before)).toHaveLength(1);
  expect(s.requests[before].init.method).toBe('GET');
  expect(s.requests[before].url).toContain(JSON.parse(original).uploadId);
  expect(next.needsFile).toBe(true);
  await next.run();
  expect(next.state.message).toContain('Reselect');
  const different = new File(
    [await file().arrayBuffer(), new Uint8Array([1])],
    'different.png',
    { type: 'image/png' },
  );
  await next.select(different, runtime);
  expect(next.state.message).toContain('different file');
  expect(storage.getItem(recoveryKey)).toBe(original);
  await next.select(file(), runtime);
  await next.run();
  expect(JSON.parse(storage.getItem(recoveryKey)!).key).toBe(
    JSON.parse(original).key,
  );
  expect(
    new Set(
      s.requests
        .filter((r) => r.url.endsWith('/uploads'))
        .map((r) => new Headers(r.init.headers).get('Idempotency-Key')),
    ).size,
  ).toBe(1);
});
it('ambiguous intent reload never invents another identity or retries without matching file', async () => {
  const s = setup(),
    storage = recoveryStorage();
  s.fixture.enable();
  let lost = true;
  const call: MediaCall = async (...args) => {
    const result = await s.call(...args);
    if (lost && args[0].kind === 'uploads') {
      lost = false;
      throw new Error('lost');
    }
    return result;
  };
  const first = new GalleryUpload(productId, call);
  await first.restore(storage, 'one');
  await first.select(file(), runtime);
  await first.run();
  const original = JSON.parse(storage.getItem(recoveryKey)!);
  expect(original.uploadId).toBeNull();
  const next = new GalleryUpload(productId, call);
  await next.restore(storage, 'one');
  await next.run();
  expect(s.requests).toHaveLength(1);
  await next.select(file(), runtime);
  await Promise.all([next.run(), next.run()]);
  expect(s.requests).toHaveLength(2);
  expect(JSON.parse(storage.getItem(recoveryKey)!).key).toBe(original.key);
  expect(new Headers(s.requests[1].init.headers).get('Idempotency-Key')).toBe(
    original.key,
  );
});
it('processing reload uses status only; READY clears recovery without attachment or another transfer', async () => {
  const s = setup(),
    storage = recoveryStorage();
  s.fixture.enable();
  const transfer = vi.fn(async () => {});
  const first = new GalleryUpload(productId, s.call, transfer);
  await first.restore(storage, 'one');
  await first.select(file(), runtime);
  await first.run();
  const next = new GalleryUpload(productId, s.call, transfer);
  const before = s.requests.length;
  await next.restore(storage, 'one');
  expect(next.state.phase).toBe('processing');
  await next.run();
  expect(next.state.phase).toBe('ready');
  expect(storage.getItem(recoveryKey)).toBeNull();
  expect(s.requests.slice(before).every((r) => r.init.method === 'GET')).toBe(
    true,
  );
  expect(transfer).toHaveBeenCalledOnce();
  expect(s.requests.some((r) => r.init.method === 'PUT')).toBe(false);
});
for (const [status, code, terminal] of [
  [410, 'UPLOAD_EXPIRED', true],
  [422, 'UPLOAD_FAILED', true],
  [503, 'MEDIA_UPLOAD_UNAVAILABLE', false],
  [503, 'MEDIA_PROCESSOR_UNAVAILABLE', false],
  [401, 'UNAUTHORIZED', true],
  [403, 'FORBIDDEN', true],
] as const)
  it(`reload handles ${code} without success or a new identity`, async () => {
    const s = setup(),
      storage = recoveryStorage();
    s.fixture.enable();
    const first = new GalleryUpload(productId, s.call);
    await first.restore(storage, 'one');
    await first.select(file(), runtime);
    await first.run();
    const original = storage.getItem(recoveryKey);
    const call = vi.fn<MediaCall>(async () => {
      throw new ClientFailure(status, code, 'private');
    });
    const next = new GalleryUpload(productId, call);
    await next.restore(storage, 'one');
    expect(next.state.mediaId).toBeUndefined();
    expect(next.state.message).not.toContain('private');
    expect(storage.getItem(recoveryKey)).toBe(terminal ? null : original);
    if (terminal) {
      await next.run();
      expect(call).toHaveBeenCalledOnce();
    }
  });
it('invalid, oversized and extra-field records block requests instead of trusting stored claims', async () => {
  for (const raw of [
    '{',
    'x'.repeat(1025),
    JSON.stringify({ version: 1, token: 'forbidden' }),
  ]) {
    const storage = recoveryStorage(),
      call = vi.fn<MediaCall>();
    storage.setItem('bb-gallery-upload:context', 'one');
    storage.setItem(recoveryKey, raw);
    const u = new GalleryUpload(productId, call);
    await u.restore(storage, 'one');
    await u.select(file(), runtime);
    await u.run();
    u.reset();
    expect(call).not.toHaveBeenCalled();
    expect(u.state.message).toContain('blocked');
  }
});
it('unavailable browser storage fails closed before an intent request', async () => {
  const storage = recoveryStorage(),
    call = vi.fn<MediaCall>();
  storage.setItem = () => {
    throw new Error('disabled');
  };
  const u = new GalleryUpload(productId, call);
  await u.restore(storage, 'one');
  await u.select(file(), runtime);
  await u.run();
  expect(call).not.toHaveBeenCalled();
});
it('storage quota failure after file selection prevents a new intent', async () => {
  const storage = recoveryStorage(),
    call = vi.fn<MediaCall>();
  const u = new GalleryUpload(productId, call);
  await u.restore(storage, 'one');
  await u.select(file(), runtime);
  storage.setItem = () => {
    throw new Error('quota');
  };
  await u.run();
  expect(call).not.toHaveBeenCalled();
  expect(u.state.message).toContain('blocked');
});
it('sign-out invalidates pending recovery and different administrator/session clears records', async () => {
  const { clearGalleryRecovery } = await import('./gallery-upload');
  const s = setup(),
    storage = recoveryStorage();
  const u = new GalleryUpload(productId, s.call);
  await u.restore(storage, 'one');
  await u.select(file(), runtime);
  await u.run();
  clearGalleryRecovery(storage);
  const count = s.requests.length;
  await u.run();
  expect(s.requests).toHaveLength(count);
  const next = new GalleryUpload(productId, s.call);
  await next.restore(storage, 'two');
  expect(next.state.name).toBe('');
  expect(storage.getItem(recoveryKey)).toBeNull();
});
it('recovery record contains only bounded identity metadata, never names, files, forms or credentials', async () => {
  const s = setup(),
    storage = recoveryStorage();
  s.fixture.enable();
  const u = new GalleryUpload(productId, s.call);
  await u.restore(storage, 'one');
  await u.select(file(), runtime);
  await u.run();
  const raw = storage.getItem(recoveryKey)!;
  const data = JSON.parse(raw);
  expect(Object.keys(data).sort()).toEqual([
    'key',
    'request',
    'uploadId',
    'version',
  ]);
  expect(Object.keys(data.request).sort()).toEqual([
    'bytes',
    'contentType',
    'sha256',
  ]);
  expect(raw.length).toBeLessThan(1024);
  expect(raw).not.toMatch(
    /synthetic.png|Policy|Signature|LOCALONLY|cookie|token|base64|data:/i,
  );
});
it('different session context invalidates existing recovery without making a request', async () => {
  const s = setup(),
    storage = recoveryStorage();
  const first = new GalleryUpload(productId, s.call);
  await first.restore(storage, 'one');
  await first.select(file(), runtime);
  await first.run();
  expect(storage.getItem(recoveryKey)).not.toBeNull();
  const count = s.requests.length;
  const next = new GalleryUpload(productId, s.call);
  await next.restore(storage, 'two');
  expect(storage.getItem(recoveryKey)).toBeNull();
  expect(next.state.name).toBe('');
  expect(s.requests).toHaveLength(count);
});
it('known queued recovery only reads status until an explicit processing retry', async () => {
  const s = setup(),
    storage = recoveryStorage();
  s.fixture.enable();
  const first = new GalleryUpload(productId, s.call);
  await first.restore(storage, 'one');
  await first.select(file(), runtime);
  await first.run();
  const call = vi.fn<MediaCall>(async (target) => ({
    upload: {
      uploadId: target.itemId,
      mediaId: '01K00000000000000000000003',
      state: 'QUEUED',
    },
  }));
  const next = new GalleryUpload(productId, call);
  await next.restore(storage, 'one');
  expect(call).toHaveBeenCalledOnce();
  expect(call.mock.calls[0][0].kind).toBe('status');
  await next.run();
  expect(call.mock.calls.at(-1)?.[0].kind).toBe('complete');
});
it('expired recovery cannot renew a deadline or create a replacement intent', async () => {
  const s = setup(),
    storage = recoveryStorage();
  s.fixture.enable();
  const first = new GalleryUpload(productId, s.call);
  await first.restore(storage, 'one');
  await first.select(file(), runtime);
  await first.run();
  const now = Date.now(),
    clock = vi.spyOn(Date, 'now').mockReturnValue(now + 900001);
  try {
    const next = new GalleryUpload(productId, s.call);
    await next.restore(storage, 'one');
    expect(next.state.phase).toBe('expired');
    expect(storage.getItem(recoveryKey)).toBeNull();
    await next.run();
    expect(s.requests.filter((r) => r.init.method === 'POST')).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});
it('storage failure after authorization blocks transfer and preserves the unresolved original identity', async () => {
  const s = setup(),
    storage = recoveryStorage();
  s.fixture.enable();
  const transfer = vi.fn(async () => {});
  const call: MediaCall = async (...args) => {
    const reply = await s.call(...args);
    storage.setItem = () => {
      throw new Error('quota');
    };
    return reply;
  };
  const u = new GalleryUpload(productId, call, transfer);
  await u.restore(storage, 'one');
  await u.select(file(), runtime);
  await u.run();
  expect(transfer).not.toHaveBeenCalled();
  expect(u.state.message).toContain('blocked');
  expect(JSON.parse(storage.getItem(recoveryKey)!).key).toMatch(
    /^[0-9a-f-]{36}$/,
  );
  await u.run();
  expect(s.requests).toHaveLength(1);
});

it('READY discovery survives new clients without browser storage, and attachment stays explicit', async () => {
  const { ReadyDiscovery } = await import('./gallery-client');
  const s = setup();
  const first = new ReadyDiscovery(productId, s.call);
  await first.load();
  expect(first.state.assets).toHaveLength(1);
  const id = first.state.assets[0].mediaId;
  const fresh = new ReadyDiscovery(productId, s.call);
  await fresh.load();
  expect(fresh.state.assets[0].mediaId).toBe(id);
  expect(s.requests.every((r) => r.init.method === 'GET')).toBe(true);
  await s.model.load();
  expect(s.model.state.draft.some((a) => a.mediaId === id)).toBe(false);
  s.model.edit([
    ...s.model.state.draft,
    { mediaId: id, alt: 'Recovered synthetic cookie' },
  ]);
  expect(s.requests.every((r) => r.init.method === 'GET')).toBe(true);
  await s.model.save();
  await fresh.load();
  expect(fresh.state.assets).toHaveLength(0);
  s.model.edit(s.model.state.draft.filter((a) => a.mediaId !== id));
  await s.model.save();
  await fresh.load();
  expect(fresh.state.assets).toHaveLength(0);
  expect(s.requests.some((r) => r.url.includes('/uploads'))).toBe(false);
});
it('READY discovery uses no browser state and clears results on authorization failure', async () => {
  const { ReadyDiscovery } = await import('./gallery-client');
  const s = setup();
  const d = new ReadyDiscovery(productId, s.call);
  await d.load();
  s.fixture.deny();
  await d.load();
  expect(d.state.assets).toEqual([]);
  expect(d.state.message).toContain('Sign in');
});
it('READY discovery rejects unsafe metadata, foreign products and invalid cursors', async () => {
  const { mediaResponse, mediaPath } = await import('./media-contract');
  const t = { productId, kind: 'ready' as const };
  expect(() =>
    mediaPath(
      { ...t, after: '01K00000000000000000000002.01K00000000000000000000003' },
      'GET',
    ),
  ).toThrow();
  expect(() =>
    mediaResponse({ assets: [], nextCursor: 'invalid' }, t),
  ).toThrow();
  expect(() =>
    mediaResponse({ assets: [], nextCursor: null, objectKey: 'private' }, t),
  ).toThrow();
  const s = setup();
  const v = (await s.call(t)) as {
    assets: Record<string, unknown>[];
    nextCursor: null;
  };
  for (const patch of [
    { productId: '01K00000000000000000000002' },
    { state: 'DELETING' },
    { key: 'private' },
  ])
    expect(() =>
      mediaResponse({ ...v, assets: [{ ...v.assets[0], ...patch }] }, t),
    ).toThrow();
});

it('READY discovery follows empty bounded pages without looping or accumulating results', async () => {
  const { ReadyDiscovery } = await import('./gallery-client');
  const cursor = productId + '.01K00000000000000000000005';
  const call = vi
    .fn()
    .mockResolvedValueOnce({ assets: [], nextCursor: cursor })
    .mockResolvedValueOnce({ assets: [], nextCursor: null });
  const d = new ReadyDiscovery(productId, call);
  await d.load();
  expect(d.state.nextCursor).toBe(cursor);
  expect(call).toHaveBeenCalledTimes(1);
  await d.load(true);
  expect(call.mock.calls[1][0].after).toBe(cursor);
  expect(d.state.nextCursor).toBeNull();
  await d.load(true);
  expect(call).toHaveBeenCalledTimes(2);
  call.mockResolvedValue({ assets: [], nextCursor: cursor });
  await d.load();
  await d.load(true);
  expect(d.state.message).not.toBe('');
  expect(d.state.nextCursor).toBeNull();
});
