import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PreviewMediaStore,
  inspectImage,
  FILE_LIMIT,
  type ImageRuntime,
} from './media-preview';
const png = (name = 'synthetic.png') =>
  new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
    name,
    { type: 'image/png' },
  );
function setup() {
  let n = 0;
  const close = vi.fn();
  const runtime: ImageRuntime = {
    decode: vi.fn(async () => ({ width: 640, height: 480, close })),
    create: vi.fn(() => `blob:synthetic-${++n}`),
    revoke: vi.fn(),
  };
  return { runtime, close, store: new PreviewMediaStore(runtime) };
}
describe('synthetic media lifecycle', () => {
  it('selects images with stable previews and isolates Product IDs', async () => {
    const { store } = setup();
    await store.select('a', [png(), png('second.png')]);
    expect(store.get('a')).toHaveLength(2);
    expect(store.get('b')).toEqual([]);
    expect(store.get('a')[0]).toMatchObject({
      url: 'blob:synthetic-1',
      alt: '',
      width: 640,
    });
  });
  it('uses ordered first image as primary and preserves IDs and descriptions', async () => {
    const { store } = setup();
    await store.select('a', [png(), png('second.png'), png('third.png')]);
    const id = store.get('a')[2].id;
    store.alt('a', id, 'A synthetic test view');
    store.move('a', id, 0);
    expect(store.get('a')[0]).toMatchObject({
      id,
      alt: 'A synthetic test view',
    });
    store.move('a', id, 1);
    expect(store.get('a')[1].id).toBe(id);
    store.move('a', id, -1);
    expect(store.get('a')[1].id).toBe(id);
  });
  it('replaces only after validation, retaining position and alt and revoking the old URL', async () => {
    const { store, runtime } = setup();
    await store.select('a', [png()]);
    const first = store.get('a')[0];
    store.alt('a', first.id, 'Description');
    await store.select('a', [png('new.png')], first.id);
    expect(store.get('a')[0]).toMatchObject({
      id: first.id,
      alt: 'Description',
      name: 'new.png',
    });
    expect(runtime.revoke).toHaveBeenCalledWith(first.url);
  });
  it('invalid replacement leaves original intact', async () => {
    const { store, runtime } = setup();
    await store.select('a', [png()]);
    const original = store.get('a');
    await expect(
      store.select(
        'a',
        [new File(['bad'], 'bad.svg', { type: 'image/svg+xml' })],
        original[0].id,
      ),
    ).rejects.toThrow('JPEG');
    expect(store.get('a')).toBe(original);
    expect(runtime.revoke).not.toHaveBeenCalled();
  });
  it('removes and promotes the next image; disposes remaining URLs once', async () => {
    const { store, runtime } = setup();
    await store.select('a', [png(), png()]);
    const [a, b] = store.get('a');
    store.remove('a', a.id);
    expect(store.get('a')[0]).toBe(b);
    store.dispose();
    store.dispose();
    expect(vi.mocked(runtime.revoke).mock.calls).toEqual([[a.url], [b.url]]);
    await expect(store.select('a', [png()])).rejects.toThrow('closed');
  });
  it('rejects unsupported, empty, oversized and spoofed files before decoding', async () => {
    const { runtime } = setup();
    for (const file of [
      new File(['x'], 'x.svg', { type: 'image/svg+xml' }),
      new File([], 'empty.png', { type: 'image/png' }),
      new File([new Uint8Array(FILE_LIMIT + 1)], 'large.png', {
        type: 'image/png',
      }),
      new File(['<svg/>'], 'spoof.png', { type: 'image/png' }),
    ])
      await expect(inspectImage(file, runtime)).rejects.toThrow();
    expect(runtime.decode).not.toHaveBeenCalled();
  });
  it('rejects corrupt decodes and invalid dimensions, closing decoded images', async () => {
    const { runtime, close } = setup();
    runtime.decode = vi.fn(async () => {
      throw Error('corrupt');
    });
    await expect(inspectImage(png(), runtime)).rejects.toThrow(
      'could not be opened',
    );
    for (const [width, height] of [
      [0, 1],
      [8001, 1],
      [5000, 5000],
    ]) {
      runtime.decode = vi.fn(async () => ({ width, height, close }));
      await expect(inspectImage(png(), runtime)).rejects.toThrow('megapixels');
    }
    expect(close).toHaveBeenCalledTimes(3);
  });
  it('rolls back a multi-file selection when any image fails', async () => {
    const { store, runtime } = setup();
    await expect(
      store.select('a', [
        png(),
        new File(['bad'], 'bad.png', { type: 'image/png' }),
      ]),
    ).rejects.toThrow();
    expect(store.get('a')).toEqual([]);
    expect(runtime.revoke).toHaveBeenCalledWith('blob:synthetic-1');
  });
  it('enforces six-image limit and leaves existing images unchanged', async () => {
    const { store } = setup();
    await store.select(
      'a',
      Array.from({ length: 6 }, () => png()),
    );
    const before = store.get('a');
    await expect(store.select('a', [png()])).rejects.toThrow('six');
    expect(store.get('a')).toBe(before);
  });
  it('releases decoded resources when the preview closes during selection', async () => {
    const { store, runtime, close } = setup();
    let finish!: (v: {
      width: number;
      height: number;
      close: () => void;
    }) => void;
    runtime.decode = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = store.select('a', [png()]);
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.dispose();
    finish({ width: 100, height: 100, close });
    await expect(pending).rejects.toThrow('closed');
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.create).not.toHaveBeenCalled();
  });
  it('rejects racing selection if the catalog changed, releasing its staged URL', async () => {
    const { store, runtime } = setup();
    await store.select('a', [png()]);
    let finish!: (v: {
      width: number;
      height: number;
      close: () => void;
    }) => void;
    runtime.decode = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = store.select('a', [png()]);
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.remove('a', store.get('a')[0].id);
    finish({ width: 100, height: 100, close: () => {} });
    await expect(pending).rejects.toThrow('changed');
    expect(store.get('a')).toEqual([]);
    expect(runtime.revoke).toHaveBeenCalledWith('blob:synthetic-2');
  });
  it('retains images across view subscriptions without browser persistence', async () => {
    const { store } = setup();
    await store.select('a', [png()]);
    const before = store.get('a');
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    expect(store.get('a')).toBe(before);
    store.alt('a', before[0].id, 'x'.repeat(300));
    expect(store.get('a')[0].alt).toHaveLength(250);
  });
  it('keeps synthetic media outside deployed route wiring and has no network or browser-storage writer', () => {
    const code = readFileSync(
      new URL('./media-preview.ts', import.meta.url),
      'utf8',
    );
    expect(code).not.toMatch(/\b(fetch|localStorage|sessionStorage)\s*[.(]/);
    const page = readFileSync(
      new URL('../../app/admin/products/page.tsx', import.meta.url),
      'utf8',
    );
    expect(page).not.toMatch(
      /SyntheticProductMedia|PreviewMediaStore|renderMedia/,
    );
  });
});
