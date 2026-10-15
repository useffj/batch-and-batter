import { ClientFailure } from './client';
import { mediaPath, mediaResponse, type MediaTarget } from './media-contract';
export type GalleryImage = { mediaId: string; alt: string };
export type Manifest = {
  version: 1;
  productId: string;
  revision: number;
  images: GalleryImage[];
};
export type MediaCall = (
  target: MediaTarget,
  method?: string,
  body?: unknown,
  key?: string,
) => Promise<unknown>;
export function mediaClient(transport: typeof fetch = fetch): MediaCall {
  return async (target, method = 'GET', body, key) => {
    const response = await transport('/api' + mediaPath(target, method), {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Bound response accumulation, including unexpected provider errors.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 32768) throw new Error('Unavailable');
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok)
      throw new ClientFailure(
        response.status,
        typeof data.code === 'string' ? data.code : 'UNAVAILABLE',
        'Media request failed.',
      );
    return mediaResponse(data, target);
  };
}
export const mediaMessage = (e: unknown) =>
  e instanceof ClientFailure && [401, 403].includes(e.status)
    ? 'Your administrator session is unavailable. Sign in again before continuing.'
    : e instanceof ClientFailure && e.code === 'PRODUCT_WRITES_NOT_READY'
      ? 'Catalog changes are not enabled yet. Contact the operator.'
      : 'Gallery services are unavailable. Check your connection and try again.';
const same = (a: GalleryImage[], b: GalleryImage[]) =>
  JSON.stringify(a) === JSON.stringify(b);
export class GalleryModel {
  state: {
    manifest?: Manifest;
    draft: GalleryImage[];
    busy: boolean;
    blocked: boolean;
    message: string;
  } = { draft: [], busy: false, blocked: false, message: '' };
  private listeners = new Set<() => void>();
  private pending?: { revision: number; images: GalleryImage[] };
  constructor(
    readonly productId: string,
    private call: MediaCall,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private update(p: Partial<typeof this.state>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn());
  }
  get dirty() {
    return (
      !!this.state.manifest &&
      !same(this.state.draft, this.state.manifest.images)
    );
  }
  private async read() {
    return (
      (await this.call({ productId: this.productId, kind: 'manifest' })) as {
        manifest: Manifest;
      }
    ).manifest;
  }
  async load(discard = false) {
    if (this.state.busy || (this.dirty && !discard) || this.pending) return;
    this.update({ busy: true, message: '' });
    try {
      const manifest = await this.read();
      this.update({
        manifest,
        draft: structuredClone(manifest.images),
        blocked: false,
      });
    } catch (e) {
      this.update({ message: mediaMessage(e) });
    } finally {
      this.update({ busy: false });
    }
  }
  edit(images: GalleryImage[]) {
    if (
      !this.state.busy &&
      !this.state.blocked &&
      images.length <= 6 &&
      new Set(images.map((i) => i.mediaId)).size === images.length
    )
      this.update({ draft: structuredClone(images), message: '' });
  }
  cancel() {
    if (!this.state.busy && !this.state.blocked && this.state.manifest)
      this.update({
        draft: structuredClone(this.state.manifest.images),
        message: '',
      });
  }
  async save() {
    const { manifest, draft, busy, blocked } = this.state;
    if (!manifest || busy || blocked || !this.dirty) return;
    if (draft.some((i) => !i.alt.trim() || i.alt.trim().length > 160)) {
      this.update({
        message: 'Add alternative text of 1–160 characters for every image.',
      });
      return;
    }
    this.pending = {
      revision: manifest.revision,
      images: draft.map((i) => ({ ...i, alt: i.alt.trim() })),
    };
    this.update({ busy: true, message: '' });
    try {
      const result = (await this.call(
        { productId: this.productId, kind: 'manifest' },
        'PUT',
        {
          expectedRevision: this.pending.revision,
          images: this.pending.images,
        },
      )) as { manifest: Manifest };
      if (
        result.manifest.revision <= this.pending.revision ||
        !same(result.manifest.images, this.pending.images)
      )
        throw new Error('Uncertain result');
      this.accept(result.manifest);
    } catch (e) {
      if (e instanceof ClientFailure && e.code === 'MEDIA_REVISION_CONFLICT') {
        this.pending = undefined;
        this.update({
          blocked: true,
          message:
            'This gallery changed elsewhere. Your edits are retained. Reload the current gallery before editing again.',
        });
      } else {
        this.update({
          blocked: true,
          message:
            'Save outcome is uncertain. Your edits are retained. Check the saved gallery before retrying.',
        });
        await this.reconcile();
      }
    } finally {
      this.update({ busy: false });
    }
  }
  private accept(manifest: Manifest) {
    this.pending = undefined;
    this.update({
      manifest,
      draft: structuredClone(manifest.images),
      blocked: false,
      message: 'Gallery saved.',
    });
  }
  private async reconcile() {
    if (!this.pending) return;
    try {
      const current = await this.read();
      if (
        current.revision > this.pending.revision &&
        same(current.images, this.pending.images)
      )
        this.accept(current);
      else if (
        current.revision === this.pending.revision &&
        same(current.images, this.state.manifest!.images)
      ) {
        this.pending = undefined;
        this.update({
          blocked: false,
          message:
            'The saved gallery is unchanged. Your edits are retained; you may retry Save.',
        });
      } else {
        this.pending = undefined;
        this.update({
          blocked: true,
          message:
            'The saved gallery differs. Your edits are retained. Reload the current gallery to resolve this conflict.',
        });
      }
    } catch (e) {
      this.update({
        blocked: true,
        message:
          mediaMessage(e) +
          ' Save outcome remains uncertain; check again before retrying.',
      });
    }
  }
  async recover() {
    if (this.state.busy) return;
    this.update({ busy: true });
    try {
      await this.reconcile();
    } finally {
      this.update({ busy: false });
    }
  }
  get uncertain() {
    return !!this.pending;
  }
}

export type ReadyAsset = {
  productId: string;
  mediaId: string;
  state: unknown;
  width: number;
  height: number;
};
export class ReadyDiscovery {
  state: {
    assets: ReadyAsset[];
    nextCursor: string | null;
    busy: boolean;
    message: string;
  } = { assets: [], nextCursor: null, busy: false, message: '' };
  private listeners = new Set<() => void>();
  constructor(
    private productId: string,
    private call: MediaCall,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private update(p: Partial<typeof this.state>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn());
  }
  async load(more = false) {
    if (this.state.busy || (more && !this.state.nextCursor)) return;
    const after = more ? this.state.nextCursor! : undefined;
    this.update({ busy: true, message: '', assets: [] });
    try {
      const result = (await this.call({
        productId: this.productId,
        kind: 'ready',
        after,
      })) as { assets: ReadyAsset[]; nextCursor: string | null };
      if (result.nextCursor && result.nextCursor === after)
        throw new Error('Non-progressing cursor');
      this.update({ assets: result.assets, nextCursor: result.nextCursor });
    } catch (e) {
      this.update({ assets: [], nextCursor: null, message: mediaMessage(e) });
    } finally {
      this.update({ busy: false });
    }
  }
}
