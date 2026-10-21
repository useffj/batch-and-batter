'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  GalleryModel,
  ReadyDiscovery,
  mediaClient,
} from '../../lib/admin/gallery-client';
import {
  GalleryUpload,
  type PreviewTransfer,
} from '../../lib/admin/gallery-upload';
import './gallery.css';
import { transferImage } from '../../lib/admin/image-transfer';
import { PrivateImage } from './private-image';
export function ProductGallery({
  productId,
  name,
  onDirty,
  transfer,
  recoveryScope,
  mediaEnabled = false,
}: {
  productId: string;
  name: string;
  onDirty?: (dirty: boolean) => void;
  transfer?: PreviewTransfer;
  recoveryScope?: string;
  mediaEnabled?: boolean;
}) {
  const [model] = useState(() => new GalleryModel(productId, mediaClient()));
  const [upload] = useState(
    () =>
      new GalleryUpload(
        productId,
        mediaClient(fetch, mediaEnabled),
        transfer ?? (mediaEnabled ? transferImage : undefined),
      ),
  );
  const s = useSyncExternalStore(
    model.subscribe,
    model.snapshot,
    model.snapshot,
  );
  const u = useSyncExternalStore(
    upload.subscribe,
    upload.snapshot,
    upload.snapshot,
  );
  const [discovery] = useState(
    () => new ReadyDiscovery(productId, mediaClient()),
  );
  const ready = useSyncExternalStore(
    discovery.subscribe,
    discovery.snapshot,
    discovery.snapshot,
  );
  const [candidate, setCandidate] = useState('');
  const [recoveryAlt, setRecoveryAlt] = useState('');
  useEffect(() => {
    void discovery.load();
  }, [discovery, s.manifest?.revision]);
  const [selected, setSelected] = useState('');
  const [replace, setReplace] = useState<string>();
  const current = s.draft.find((i) => i.mediaId === selected) ?? s.draft[0];
  const index = current ? s.draft.indexOf(current) : -1;
  useEffect(() => {
    try {
      if (recoveryScope) void upload.restore(sessionStorage, recoveryScope);
      else upload.blockRecovery();
    } catch {
      upload.blockRecovery();
    }
    void model.load();
  }, [model, upload, recoveryScope]);
  useEffect(() => {
    onDirty?.(model.dirty || s.blocked || u.busy || !!u.name);
    return () => onDirty?.(false);
  }, [model, s, onDirty, u.busy, u.name]);
  const disabled = s.busy || s.blocked;
  function move(to: number) {
    if (!current || to < 0 || to >= s.draft.length) return;
    const images = [...s.draft];
    images.splice(to, 0, images.splice(index, 1)[0]);
    model.edit(images);
    setSelected(current.mediaId);
  }
  function reload() {
    if (
      (model.dirty || s.blocked) &&
      !window.confirm(
        'Discard unsaved gallery edits and load the current saved gallery?',
      )
    )
      return;
    void model.load(true);
  }
  return (
    <section
      className="admin-card product-gallery"
      aria-label={`Images for ${name}`}
    >
      <div className="gallery-heading">
        <div>
          <p className="admin-eyebrow">Cookie photography</p>
          <h2>Images for {name}</h2>
        </div>
        <span>{s.draft.length} of 6 images</span>
      </div>
      <p className="admin-muted">
        The first image is primary.{' '}
        {mediaEnabled
          ? 'Processed images are private to administrators.'
          : 'Image previews are unavailable until private image delivery is enabled.'}
      </p>
      {s.busy && <p role="status">Loading or saving gallery…</p>}
      {s.message && <p role={s.blocked ? 'alert' : 'status'}>{s.message}</p>}
      {!s.manifest && !s.busy && (
        <button type="button" onClick={() => void model.load()}>
          Retry loading gallery
        </button>
      )}
      {s.manifest && (
        <>
          {!s.draft.length && <p>No images attached to this cookie.</p>}
          <div className="gallery-layout">
            <ol className="gallery-tiles">
              {s.draft.map((image, n) => (
                <li key={image.mediaId}>
                  <button
                    type="button"
                    aria-pressed={current?.mediaId === image.mediaId}
                    onClick={() => setSelected(image.mediaId)}
                  >
                    {mediaEnabled ? (
                      <PrivateImage
                        productId={productId}
                        mediaId={image.mediaId}
                        alt={image.alt}
                      />
                    ) : (
                      <span className="gallery-placeholder">
                        Preview unavailable
                      </span>
                    )}
                    <strong>
                      {n === 0 ? 'Primary image' : `Image ${n + 1}`}
                    </strong>
                    <span>{image.alt || 'Alternative text required'}</span>
                  </button>
                </li>
              ))}
            </ol>
            {current && (
              <div className="gallery-panel">
                <h3>
                  Image {index + 1}
                  {index === 0 ? ' · Primary' : ''}
                </h3>
                <label>
                  Alternative text
                  <textarea
                    maxLength={160}
                    value={current.alt}
                    disabled={disabled}
                    onChange={(e) =>
                      model.edit(
                        s.draft.map((i) =>
                          i.mediaId === current.mediaId
                            ? { ...i, alt: e.target.value }
                            : i,
                        ),
                      )
                    }
                  />
                </label>
                <p className="admin-muted">
                  Required · {current.alt.length}/160 characters
                </p>
                <div className="gallery-actions">
                  <button
                    type="button"
                    disabled={disabled || index === 0}
                    onClick={() => move(0)}
                  >
                    Make primary
                  </button>
                  <button
                    type="button"
                    disabled={disabled || index === 0}
                    onClick={() => move(index - 1)}
                  >
                    Move earlier
                  </button>
                  <button
                    type="button"
                    disabled={disabled || index === s.draft.length - 1}
                    onClick={() => move(index + 1)}
                  >
                    Move later
                  </button>
                  <button
                    type="button"
                    disabled={disabled || u.busy || !!u.name}
                    onClick={() => {
                      setReplace(current.mediaId);
                      document
                        .getElementById('gallery-file-' + productId)
                        ?.focus();
                    }}
                  >
                    Replace image
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      model.edit(
                        s.draft.filter((i) => i.mediaId !== current.mediaId),
                      )
                    }
                  >
                    Remove image
                  </button>
                </div>
                <p className="admin-muted">
                  Removal takes effect only after Save; it does not delete image
                  files.
                </p>
              </div>
            )}
          </div>
          <p role="status">
            {model.dirty
              ? 'Unsaved gallery changes.'
              : 'Gallery matches the last confirmed saved result.'}
          </p>
          <div className="gallery-actions">
            <button
              type="button"
              disabled={disabled || !model.dirty}
              onClick={() => void model.save()}
            >
              Save gallery
            </button>
            <button
              type="button"
              disabled={disabled || !model.dirty}
              onClick={() => model.cancel()}
            >
              Cancel changes
            </button>
            {model.uncertain ? (
              <button
                type="button"
                disabled={s.busy}
                onClick={() => void model.recover()}
              >
                Check saved gallery
              </button>
            ) : (
              <button type="button" disabled={s.busy} onClick={reload}>
                Reload current gallery
              </button>
            )}
          </div>
          <section
            className="gallery-upload"
            aria-label="Ready images awaiting attachment"
          >
            <h3>Ready images awaiting attachment</h3>
            <p>
              These private images are processed but not attached. Select an
              image, describe it, add it to the draft, then Save gallery.
            </p>
            {ready.busy && <p role="status">Loading ready images…</p>}
            {ready.message && <p role="alert">{ready.message}</p>}
            {!ready.busy &&
              !ready.message &&
              !ready.assets.some(
                (a) => !s.draft.some((i) => i.mediaId === a.mediaId),
              ) && <p>No unattached ready images on this page.</p>}
            <ul className="gallery-tiles">
              {ready.assets
                .filter((a) => !s.draft.some((i) => i.mediaId === a.mediaId))
                .map((a, n) => (
                  <li key={a.mediaId}>
                    <button
                      type="button"
                      aria-pressed={candidate === a.mediaId}
                      disabled={disabled || s.draft.length >= 6}
                      onClick={() => {
                        setCandidate(a.mediaId);
                        setRecoveryAlt('');
                      }}
                    >
                      {mediaEnabled ? (
                        <PrivateImage
                          productId={productId}
                          mediaId={a.mediaId}
                          alt="Unattached processed image"
                        />
                      ) : (
                        <span className="gallery-placeholder">
                          Preview unavailable
                        </span>
                      )}
                      <strong>Ready image {n + 1}</strong>
                      <span>
                        {a.width} × {a.height} · Not attached
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
            {candidate &&
              ready.assets.some((a) => a.mediaId === candidate) &&
              !s.draft.some((i) => i.mediaId === candidate) && (
                <div className="gallery-panel">
                  <label>
                    Alternative text for recovered image
                    <textarea
                      maxLength={160}
                      value={recoveryAlt}
                      disabled={disabled}
                      onChange={(e) => setRecoveryAlt(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={
                      disabled ||
                      s.draft.length >= 6 ||
                      !recoveryAlt.trim() ||
                      recoveryAlt.trim().length > 160
                    }
                    onClick={() => {
                      model.edit([
                        ...s.draft,
                        { mediaId: candidate, alt: recoveryAlt.trim() },
                      ]);
                      setSelected(candidate);
                      setCandidate('');
                      setRecoveryAlt('');
                    }}
                  >
                    Add recovered image to draft
                  </button>
                </div>
              )}
            {s.draft.length >= 6 && (
              <p>
                Gallery is full. Remove an image from the draft before adding
                another.
              </p>
            )}
            <div className="gallery-actions">
              <button
                type="button"
                disabled={ready.busy}
                onClick={() => {
                  setCandidate('');
                  void discovery.load();
                }}
              >
                Refresh ready images
              </button>
              {ready.nextCursor && (
                <button
                  type="button"
                  disabled={ready.busy}
                  onClick={() => {
                    setCandidate('');
                    void discovery.load(true);
                  }}
                >
                  Next ready images
                </button>
              )}
            </div>
          </section>
          <div className="gallery-upload">
            <h3>{replace ? 'Replace selected image' : 'Add an image'}</h3>
            <p>
              JPEG, PNG or WebP · Up to 8 MiB · At least 480 pixels per side ·
              Maximum 8,000 pixels per side and 20 megapixels.
            </p>
            <label htmlFor={'gallery-file-' + productId}>
              {upload.needsFile ? 'Reselect original image' : 'Choose image'}
            </label>
            <input
              id={'gallery-file-' + productId}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={
                disabled ||
                u.busy ||
                (!!u.name && !upload.needsFile) ||
                (!replace && s.draft.length >= 6)
              }
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file)
                  void upload.select(file, {
                    decode: (f) => createImageBitmap(f),
                    create: () => '',
                    revoke: () => {},
                  });
              }}
            />
            <p role="status">
              {u.name && `${u.name} · `}
              {u.name || u.message ? u.phase : ''} {u.message}
            </p>
            <div className="gallery-actions">
              {u.name && (
                <>
                  <button
                    type="button"
                    disabled={
                      disabled ||
                      u.busy ||
                      ['ready', 'failed', 'expired'].includes(u.phase)
                    }
                    onClick={() => void upload.run()}
                  >
                    {u.phase === 'selected'
                      ? 'Request upload'
                      : 'Check / resume this upload'}
                  </button>
                  <button
                    type="button"
                    disabled={u.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          'End this local upload workflow? An existing server intent is retained and will not be deleted.',
                        )
                      ) {
                        upload.reset();
                        setReplace(undefined);
                      }
                    }}
                  >
                    Choose a new file
                  </button>
                </>
              )}
              {u.phase === 'ready' && u.mediaId && (
                <button
                  type="button"
                  disabled={disabled || (!replace && s.draft.length >= 6)}
                  onClick={() => {
                    const image = { mediaId: u.mediaId!, alt: '' };
                    if (replace && !s.draft.some((i) => i.mediaId === replace))
                      return;
                    model.edit(
                      replace
                        ? s.draft.map((i) =>
                            i.mediaId === replace ? image : i,
                          )
                        : [...s.draft, image],
                    );
                    setSelected(image.mediaId);
                    upload.reset();
                    setReplace(undefined);
                  }}
                >
                  Add ready image to draft
                </button>
              )}
            </div>
            <p className="admin-muted">
              Processing never attaches an image automatically. Add it to the
              draft, describe it, then Save gallery.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
