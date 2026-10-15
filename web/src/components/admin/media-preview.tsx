'use client';
// Only imported by the local synthetic preview entry, not a deployed route.
import { useRef, useState, useSyncExternalStore } from 'react';
import { PreviewMediaStore, MEDIA_LIMIT } from '../../lib/admin/media-preview';
import './media-preview.css';
export function SyntheticProductMedia({
  productId,
  name,
  store,
}: {
  productId: string;
  name: string;
  store: PreviewMediaStore;
}) {
  const images = useSyncExternalStore(
    store.subscribe,
    () => store.get(productId),
    () => store.get(productId),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const gate = useRef(false),
    section = useRef<HTMLElement>(null);
  async function select(files: File[], replaceId?: string) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await store.select(productId, files, replaceId);
      if (files.length)
        setNotice(
          replaceId
            ? 'Image replaced. Description and position kept.'
            : 'Images added to this local preview.',
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open these images.');
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  function move(id: string, to: number) {
    store.move(productId, id, to);
    setNotice(to === 0 ? 'Primary image updated.' : 'Image order updated.');
  }
  return (
    <section
      className="admin-card media-preview"
      ref={section}
      tabIndex={-1}
      aria-label={`Images for ${name}`}
    >
      <p className="admin-eyebrow">Cookie photography · Synthetic preview</p>
      <h2>Images for {name}</h2>
      <p className="admin-muted">
        Choose the view that makes this cookie shine. The first image is
        primary; the rest follow in order.
      </p>
      <p className="media-preview-note">
        Local preview only — nothing is uploaded or saved to your catalog.
        Images remain while navigating this preview, then clear on reload or
        closing the tab. Use synthetic images only.
      </p>
      <label className="media-picker">
        Choose images
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy || images.length >= MEDIA_LIMIT}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void select(files);
          }}
          aria-describedby="media-limits"
        />
      </label>
      <p id="media-limits" className="admin-muted">
        {images.length} of 6 images · JPEG, PNG or WebP · Up to 8 MiB, 8,000
        pixels per side and 20 megapixels each. SVG is not supported.
      </p>
      <p role="status" aria-live="polite">
        {busy ? 'Opening images…' : notice}
      </p>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {!images.length && (
        <div className="media-empty">
          <h3>A little detail. A lot of appetite.</h3>
          <p>
            Add a front view, a close-up of the texture, or a look inside. No
            placeholder photography is used.
          </p>
        </div>
      )}
      <ol className="media-grid">
        {images.map((image, index) => (
          <li key={image.id} className="media-image-card">
            <div className="media-image-frame">
              {/* Blob URLs cannot use the server-side Next image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.alt || `Selected preview: ${image.name}`}
                onError={() =>
                  setError(
                    'An image preview is unavailable. Replace or remove that image.',
                  )
                }
              />
              <span className="media-badge">
                {index === 0 ? 'Primary' : `Image ${index + 1}`}
              </span>
            </div>
            <div className="media-image-details">
              <p className="media-filename">{image.name}</p>
              <p className="admin-muted">
                {image.width} × {image.height}
              </p>
              <label>
                Alternative text for image {index + 1}
                <textarea
                  maxLength={250}
                  value={image.alt}
                  disabled={busy}
                  onChange={(e) =>
                    store.alt(productId, image.id, e.target.value)
                  }
                  placeholder="Describe the cookie and details visible in this image."
                />
              </label>
              <p className="admin-muted">
                {image.alt.trim()
                  ? 'Description added.'
                  : 'Add a description before future publication.'}
              </p>
              <div className="media-actions">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => move(image.id, 0)}
                  aria-label={`Make image ${index + 1} primary`}
                >
                  Make primary
                </button>
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => move(image.id, index - 1)}
                  aria-label={`Move image ${index + 1} earlier`}
                >
                  Move earlier
                </button>
                <button
                  type="button"
                  disabled={busy || index === images.length - 1}
                  onClick={() => move(image.id, index + 1)}
                  aria-label={`Move image ${index + 1} later`}
                >
                  Move later
                </button>
              </div>
              <label className="media-picker">
                Replace image {index + 1}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void select(files, image.id);
                  }}
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  store.remove(productId, image.id);
                  setNotice(
                    'Image removed from this preview. The first remaining image is primary.',
                  );
                  section.current?.focus();
                }}
                aria-label={`Remove image ${index + 1}`}
              >
                Remove image
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
