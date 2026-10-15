import { ClientFailure } from './client';
import { inspectImage, type ImageRuntime } from './media-preview';
import { type MediaCall, mediaMessage } from './gallery-client';
export type UploadPhase =
  | 'selected'
  | 'authorizing'
  | 'uploading'
  | 'requested'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'expired'
  | 'unavailable';
type Upload = { uploadId: string; mediaId: string; state: string };
type RecoveryStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;
const prefix = 'bb-gallery-upload:';
export function clearGalleryRecovery(storage: RecoveryStorage) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) storage.removeItem(key);
  }
}

type Reply = {
  upload: Upload;
  authorization?: {
    url: string;
    fields: Record<string, string>;
    expiresAt: number;
  };
};
// Only the isolated preview injects a transfer. Production has no binary transport.
export type PreviewTransfer = (
  file: File,
  authorization: NonNullable<Reply['authorization']>,
) => Promise<void>;
export class GalleryUpload {
  state: {
    phase: UploadPhase;
    name: string;
    message: string;
    mediaId?: string;
    busy: boolean;
  } = { phase: 'selected', name: '', message: '', busy: false };
  private storage?: RecoveryStorage;
  private scope?: string;
  private recoveryBlocked = false;
  get needsFile() {
    return !!this.key && !this.file;
  }
  private storageKey() {
    return prefix + this.productId;
  }
  // Called after hydration. Scope is supplied by the authenticated page, never restored.
  async restore(storage: RecoveryStorage, scope: string) {
    if (this.scope) return;
    this.storage = storage;
    this.scope = scope;
    try {
      if (storage.length > 10000) throw new Error();
      const contextKey = prefix + 'context';
      if (storage.getItem(contextKey) !== scope) {
        clearGalleryRecovery(storage);
        storage.setItem(contextKey, scope);
      }
      const raw = storage.getItem(this.storageKey());
      if (!raw) return;
      if (raw.length > 1024) throw new Error();
      const r = JSON.parse(raw);
      if (
        Object.keys(r).sort().join() !== 'key,request,uploadId,version' ||
        r.version !== 1 ||
        typeof r.key !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          r.key,
        ) ||
        !(
          r.uploadId === null ||
          (typeof r.uploadId === 'string' && /^[0-9a-f]{64}$/.test(r.uploadId))
        ) ||
        !r.request ||
        Object.keys(r.request).sort().join() !== 'bytes,contentType,sha256' ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(
          r.request.contentType,
        ) ||
        !Number.isSafeInteger(r.request.bytes) ||
        r.request.bytes < 1 ||
        r.request.bytes > 8388608 ||
        typeof r.request.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(r.request.sha256)
      )
        throw new Error();
      this.key = r.key;
      this.request = r.request;
      this.uploadId = r.uploadId ?? undefined;
      this.update({
        name: 'Recovered upload',
        phase: 'unavailable',
        message:
          'Check this original operation. Reselect the original file if requested; no file bytes were retained.',
      });
      if (this.uploadId) await this.run(true);
    } catch {
      this.blockRecovery();
    }
  }
  blockRecovery() {
    this.recoveryBlocked = true;
    this.update({
      phase: 'unavailable',
      message:
        'Browser recovery storage is unavailable or invalid. Uploads are blocked; reconcile the unfinished operation before starting another.',
    });
  }
  private persist() {
    if (!this.storage) return; // Isolated model tests; production always initializes storage.
    if (this.storage.getItem(prefix + 'context') !== this.scope)
      throw new Error('Session changed');
    let count = 0;
    for (let i = 0; i < this.storage.length; i++)
      if (this.storage.key(i)?.startsWith(prefix)) count++;
    if (count >= 33 && !this.storage.getItem(this.storageKey()))
      throw new Error('Recovery limit');
    this.storage.setItem(
      this.storageKey(),
      JSON.stringify({
        version: 1,
        key: this.key,
        request: this.request,
        uploadId: this.uploadId ?? null,
      }),
    );
  }
  private clear() {
    try {
      this.storage?.removeItem(this.storageKey());
    } catch {
      this.blockRecovery();
    }
  }
  private listeners = new Set<() => void>();
  private file?: File;
  private key?: string;
  private uploadId?: string;
  private request?: { contentType: string; bytes: number; sha256: string };
  constructor(
    private productId: string,
    private call: MediaCall,
    private transfer?: PreviewTransfer,
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
  async select(file: File, runtime: ImageRuntime) {
    if (this.recoveryBlocked || this.state.busy || this.file) return; // New identity requires explicit reset.
    this.update({ busy: true, message: '' });
    try {
      const d = await inspectImage(file, runtime);
      if (Math.min(d.width, d.height) < 480)
        throw new Error('Choose an image at least 480 pixels on both sides.');
      const digest = await crypto.subtle.digest(
        'SHA-256',
        await file.arrayBuffer(),
      );
      const request = {
        contentType: file.type,
        bytes: file.size,
        sha256: Array.from(new Uint8Array(digest), (n) =>
          n.toString(16).padStart(2, '0'),
        ).join(''),
      };
      if (
        this.request &&
        (this.request.contentType !== request.contentType ||
          this.request.bytes !== request.bytes ||
          this.request.sha256 !== request.sha256)
      ) {
        this.update({
          message:
            'This is a different file. Reselect the original file; the existing operation identity is unchanged.',
        });
        return;
      }
      const resumed = !!this.key;
      this.request = request;
      this.file = file;
      this.key ??= crypto.randomUUID();
      this.update({
        phase: 'selected',
        name: file.name,
        mediaId: undefined,
        message: resumed
          ? 'Original file matched. Check the existing operation before retrying.'
          : 'File selected. Nothing has been uploaded.',
      });
    } catch (e) {
      this.update({
        phase: 'failed',
        message: e instanceof Error ? e.message : 'Unable to read image.',
      });
    } finally {
      this.update({ busy: false });
    }
  }
  reset() {
    if (this.state.busy || this.recoveryBlocked) return;
    this.clear();
    if (this.recoveryBlocked) return;
    this.file = undefined;
    this.key = undefined;
    this.uploadId = undefined;
    this.request = undefined;
    this.update({
      phase: 'selected',
      name: '',
      message: '',
      mediaId: undefined,
    });
  }
  private status(u: Upload) {
    this.uploadId = u.uploadId;
    const phase: UploadPhase =
      u.state === 'READY'
        ? 'ready'
        : u.state === 'FAILED'
          ? 'failed'
          : u.state === 'PROCESSING'
            ? 'processing'
            : u.state === 'QUEUED'
              ? 'requested'
              : 'selected';
    if (phase === 'ready' || phase === 'failed') this.clear();
    else {
      try {
        this.persist();
      } catch {
        this.blockRecovery();
      }
    }
    if (this.recoveryBlocked) return;
    this.update({
      phase,
      mediaId: phase === 'ready' ? u.mediaId : undefined,
      message:
        phase === 'ready'
          ? 'Processing complete. Add this image to the draft gallery, then Save to attach it.'
          : phase === 'failed'
            ? 'Image processing failed. Select a new file explicitly.'
            : phase === 'selected'
              ? 'Upload is pending.'
              : 'Processing is pending. Check status again; the gallery has not changed.',
    });
  }
  async run(statusOnly = false) {
    if (
      this.recoveryBlocked ||
      this.state.busy ||
      !this.request ||
      !this.key ||
      ['ready', 'failed', 'expired'].includes(this.state.phase)
    )
      return;
    this.update({ busy: true, message: '' });
    try {
      if (
        this.storage &&
        this.storage.getItem(prefix + 'context') !== this.scope
      ) {
        this.blockRecovery();
        return;
      }
      if (this.uploadId) {
        const r = (await this.call({
          productId: this.productId,
          kind: 'status',
          itemId: this.uploadId,
        })) as Reply;
        this.status(r.upload);
        if (statusOnly || this.recoveryBlocked) return;
        if (r.upload.state === 'QUEUED') {
          await this.complete();
          return;
        }
        if (r.upload.state !== 'PENDING' || this.recoveryBlocked) return;
      }
      if (!this.file) {
        this.update({
          message:
            'Reselect the original file to reconcile this same operation. Its MIME type, size and SHA-256 must match.',
        });
        return;
      }
      try {
        this.persist();
      } catch {
        this.blockRecovery();
        return;
      }
      this.update({ phase: 'authorizing' });
      const r = (await this.call(
        { productId: this.productId, kind: 'uploads' },
        'POST',
        this.request,
        this.key,
      )) as Reply;
      this.status(r.upload);
      if (r.upload.state !== 'PENDING' || this.recoveryBlocked) return;
      if (!r.authorization || !this.transfer) {
        this.update({
          phase: 'unavailable',
          message:
            'Binary image transfer is not enabled. No file was uploaded. Contact the operator.',
        });
        return;
      }
      this.update({ phase: 'uploading' });
      await this.transfer(this.file, r.authorization);
      await this.complete();
    } catch (e) {
      if (e instanceof ClientFailure && [401, 403].includes(e.status)) {
        this.clear();
        this.recoveryBlocked = true;
        this.file = undefined;
        this.update({
          phase: 'unavailable',
          mediaId: undefined,
          message: mediaMessage(e),
        });
        return;
      }
      const phase =
        e instanceof ClientFailure && e.status === 410
          ? 'expired'
          : e instanceof ClientFailure && e.status === 422
            ? 'failed'
            : 'unavailable';
      if (phase === 'expired' || phase === 'failed') this.clear();
      const message =
        e instanceof ClientFailure && e.code === 'MEDIA_UPLOAD_UNAVAILABLE'
          ? 'Image uploads are not enabled yet. This operation identity is retained; contact the operator.'
          : e instanceof ClientFailure &&
              e.code === 'MEDIA_PROCESSOR_UNAVAILABLE'
            ? 'Image processing is unavailable. Check this same upload again later.'
            : phase === 'expired'
              ? 'This upload expired. Select a new file explicitly to start another upload.'
              : mediaMessage(e) +
                ' Check this same upload again; no success is assumed.';
      this.update({ phase, message });
    } finally {
      this.update({ busy: false });
    }
  }
  private async complete() {
    this.update({ phase: 'requested' });
    const r = (await this.call(
      { productId: this.productId, kind: 'complete', itemId: this.uploadId },
      'POST',
      {},
    )) as Reply;
    this.status(r.upload);
  }
}
