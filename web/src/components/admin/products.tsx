'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminNavigation } from './navigation';
import { adminRequest, ClientFailure } from '../../lib/admin/client';
import { productRequest, submissionGate } from '../../lib/admin/product-client';
import {
  catalogPage,
  summaryOf,
  mergeCatalog,
  nameChange,
  needsDeactivationConfirmation,
  type CatalogSummary,
  catalogProduct,
  fieldErrors,
  fieldsOf,
  newProduct,
  type CatalogProduct,
  type ProductFields,
} from '../../lib/admin/products';

export function Products({ expiresAt }: { expiresAt: number }) {
  const [products, setProducts] = useState<CatalogSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(''),
    [editing, setEditing] = useState<CatalogProduct | 'new' | null>(null),
    [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null),
    locked = useRef(false),
    dirty = useRef(false);
  function failure(e: unknown) {
    if (e instanceof ClientFailure && [401, 403].includes(e.status)) {
      locked.current = true;
      dirty.current = false;
      controller.current?.abort();
      setProducts([]);
      setEditing(null);
      window.location.replace(
        '/admin/login?reason=' + (e.status === 403 ? 'forbidden' : 'expired'),
      );
      return;
    }
    setError(
      e instanceof ClientFailure
        ? e.message
        : 'Unable to reach product services. Try refreshing.',
    );
  }
  const load = useCallback(async (next?: string) => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError('');
    try {
      const response = await productRequest(
        next ? '?cursor=' + encodeURIComponent(next) : '',
        'GET',
        undefined,
        c.signal,
      );
      const page = catalogPage(response);
      if (c.signal.aborted || locked.current) return;
      setProducts((old) =>
        next ? mergeCatalog(old, page.products) : page.products,
      );
      setCursor(page.nextCursor);
      setLoaded(response.loadedAt);
    } catch (e) {
      if (!c.signal.aborted) failure(e);
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const expire = () => {
      if (Date.now() >= expiresAt) {
        locked.current = true;
        controller.current?.abort();
        setProducts([]);
        setEditing(null);
        window.location.replace('/admin/login?reason=expired');
      }
    };
    const timer = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    const visible = () => {
      if (document.visibilityState === 'visible') expire();
    };
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty.current && !locked.current && Date.now() < expiresAt) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.current?.abort();
      clearTimeout(timer);
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('pageshow', restored);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load, expiresAt]);
  function discard() {
    return !dirty.current || window.confirm('Discard unsaved product changes?');
  }
  async function select(id?: string) {
    if (!discard()) return;
    dirty.current = false;
    setEditing(null);
    setNotice('');
    setError('');
    if (!id) {
      setEditing('new');
      return;
    }
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    try {
      const p = catalogProduct(
        (await productRequest('/' + id, 'GET', undefined, c.signal)).product,
      );
      if (!c.signal.aborted && !locked.current) setEditing(p);
    } catch (e) {
      if (!c.signal.aborted) failure(e);
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  async function logout() {
    if (!discard()) return;
    dirty.current = false;
    locked.current = true;
    controller.current?.abort();
    setProducts([]);
    setEditing(null);
    setBusy(true);
    try {
      const r = await adminRequest('logout');
      window.location.replace(
        '/admin/login?reason=' +
          (r.revocationConfirmed ? 'signed-out' : 'local-sign-out'),
      );
    } catch {
      setError('Sign-out could not be confirmed. Please try Sign out again.');
      setBusy(false);
    }
  }
  return (
    <div className="admin-shell">
      <a className="admin-skip" href="#admin-content">
        Skip to products
      </a>
      <AdminNavigation current="products" />
      <main id="admin-content" className="admin-main" tabIndex={-1}>
        <header className="admin-heading">
          <div>
            <p className="admin-eyebrow">Your cookie collection</p>
            <h1>Products</h1>
            <p className="admin-muted">
              Reusable cookie details. Price set per Drop.
            </p>
          </div>
          <div className="admin-actions">
            <button
              disabled={busy || saving || locked.current}
              onClick={() => {
                if (discard()) {
                  dirty.current = false;
                  setEditing(null);
                  setNotice('');
                  void load();
                }
              }}
            >
              Refresh
            </button>
            <button
              disabled={busy || saving || locked.current}
              onClick={() => void select()}
            >
              Add Cookie
            </button>
            <button disabled={saving} onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <div role="status" aria-live="polite">
          {busy ? (
            'Loading products…'
          ) : loaded ? (
            <>
              Last loaded:{' '}
              <time dateTime={loaded}>
                {new Intl.DateTimeFormat('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                  timeZone: 'America/Denver',
                }).format(new Date(loaded))}
              </time>{' '}
              (America/Denver)
            </>
          ) : null}
          {notice && <p>{notice}</p>}
        </div>
        {error && (
          <p className="admin-card admin-error" role="alert">
            {error}
          </p>
        )}
        {editing && (
          <ProductEditor
            onBusy={setSaving}
            onUnauthorized={failure}
            key={
              editing === 'new' ? 'new' : editing.productId + editing.updatedAt
            }
            product={editing === 'new' ? undefined : editing}
            onDirty={(v) => {
              dirty.current = v;
            }}
            onClose={() => {
              if (discard()) {
                dirty.current = false;
                setEditing(null);
              }
            }}
            onSaved={(p) => {
              if (locked.current || Date.now() >= expiresAt) return;
              dirty.current = false;
              setEditing(p);
              setProducts((old) => [
                summaryOf(p),
                ...old.filter((x) => x.productId !== p.productId),
              ]);
              setNotice('Cookie saved.');
            }}
          />
        )}
        {!busy && !error && loaded && !products.length && (
          <section className="admin-card">
            <h2>{cursor ? 'No products on this page' : 'No cookies yet'}</h2>
            <p>
              {cursor
                ? 'Other catalog records were scanned. Continue to look for products.'
                : 'Add your first cookie to start the reusable catalog. New cookies are not assigned to a Drop automatically.'}
            </p>
          </section>
        )}
        <div className="admin-products">
          {products.map((p) => (
            <article className="admin-card" key={p.productId}>
              <p className="admin-eyebrow">
                {p.active ? 'Active' : 'Inactive'}
              </p>
              <h2>
                {p.name}
                {p.nameTruncated ? '…' : ''}
              </h2>
              <p className="admin-description">
                {p.description || 'No description provided.'}
                {p.descriptionTruncated ? '…' : ''}
              </p>
              <p className="admin-muted">Price set per Drop</p>
              <button
                disabled={busy || saving || locked.current}
                onClick={() => void select(p.productId)}
                aria-label={'Edit ' + p.name}
              >
                View / Edit
              </button>
            </article>
          ))}
        </div>
        {cursor && (
          <button
            disabled={busy || saving || locked.current}
            onClick={() => void load(cursor)}
          >
            Load more products
          </button>
        )}
      </main>
    </div>
  );
}

export function ProductEditor({
  product,
  onSaved,
  onClose,
  onDirty,
  onBusy,
  onUnauthorized,
}: {
  product?: CatalogProduct;
  onSaved: (p: CatalogProduct) => void;
  onClose: () => void;
  onDirty: (v: boolean) => void;
  onBusy?: (v: boolean) => void;
  onUnauthorized?: (e: ClientFailure) => void;
}) {
  const initial = product ? fieldsOf(product) : { ...newProduct };
  const [fields, setFields] = useState<ProductFields>(initial),
    [ingredients, setIngredients] = useState(initial.ingredients.join('\n')),
    [allergens, setAllergens] = useState(initial.allergens.join('\n')),
    [errors, setErrors] = useState<
      Partial<Record<keyof ProductFields, string>>
    >({}),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [manualSlug, setManualSlug] = useState(false);
  const gate = useRef(submissionGate()),
    alive = useRef(true),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    alive.current = true;
    heading.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const changed =
    JSON.stringify(fields) !== JSON.stringify(initial) ||
    ingredients !== initial.ingredients.join('\n') ||
    allergens !== initial.allergens.join('\n');
  useEffect(() => {
    onDirty(changed);
  }, [changed, onDirty]);
  function update(key: keyof ProductFields, value: string | boolean) {
    if (key === 'slug') setManualSlug(true);
    setFields((old) =>
      key === 'name'
        ? nameChange(old, String(value), !product && !manualSlug)
        : { ...old, [key]: value },
    );
  }
  async function submit() {
    await gate.current(async () => {
      if (uncertain) return;
      // Preserve unchanged arrays exactly; split only edited text into explicit entries.
      const parse = (value: string) =>
        value === '' ? [] : value.split('\n').map((x) => x.trim());
      const data = {
        ...fields,
        ingredients:
          ingredients === initial.ingredients.join('\n')
            ? initial.ingredients
            : parse(ingredients),
        allergens:
          allergens === initial.allergens.join('\n')
            ? initial.allergens
            : parse(allergens),
      };
      const invalid = fieldErrors(data);
      setErrors(invalid);
      if (Object.keys(invalid).length) {
        if (invalid.slug) setAdvanced(true);
        setMessage('Check the highlighted fields.');
        return;
      }
      if (
        needsDeactivationConfirmation(product, data) &&
        !window.confirm(
          'Deactivate this cookie? It may immediately disappear from assigned live Drops and become unavailable for cart updates. Inventory and historical orders are not deleted. Reactivating can restore visibility where its Drop association remains active.',
        )
      )
        return;
      setBusy(true);
      setMessage('');
      try {
        const r = await productRequest(
          product ? '/' + product.productId : '',
          product ? 'PUT' : 'POST',
          { ...data, ...(product ? { revision: product.updatedAt } : {}) },
        );
        const saved = catalogProduct(r.product);
        if (alive.current) onSaved(saved);
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof ClientFailure && [401, 403].includes(e.status)) {
          if (onUnauthorized) onUnauthorized(e);
          else {
            onDirty(false);
            window.location.replace('/admin/login?reason=expired');
          }
          return;
        }
        const ambiguous = !(e instanceof ClientFailure) || e.status >= 500;
        setUncertain(
          ambiguous || (e instanceof ClientFailure && e.status === 409),
        );
        setMessage(
          ambiguous
            ? 'Save outcome is unknown. Close this form and refresh the catalog before attempting another save.'
            : e instanceof ClientFailure
              ? e.message
              : 'Save failed.',
        );
      } finally {
        if (alive.current) setBusy(false);
      }
    });
  }
  return (
    <section
      className="admin-card admin-product-editor"
      aria-labelledby="product-editor-title"
    >
      <h2 id="product-editor-title" ref={heading} tabIndex={-1}>
        {product ? 'Edit cookie' : 'Add Cookie'}
      </h2>
      <p className="admin-muted">
        {changed ? 'Unsaved changes' : 'No unsaved changes'} · Price set per
        Drop. Images will be managed in a later milestone.
      </p>
      {product && (
        <details>
          <summary>Technical details</summary>
          <p>Product ID: {product.productId}</p>
        </details>
      )}
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy || uncertain}>
          {(['name', 'description'] as const).map((key) => (
            <label key={key} htmlFor={'product-' + key}>
              {key === 'name' ? 'Cookie name' : 'Description'}
              {key === 'description' ? (
                <textarea
                  id={'product-' + key}
                  value={fields[key]}
                  onChange={(e) => update(key, e.target.value)}
                />
              ) : (
                <input
                  id={'product-' + key}
                  value={fields[key]}
                  required
                  aria-invalid={!!errors[key]}
                  aria-describedby={errors[key] ? 'error-' + key : undefined}
                  onChange={(e) => update(key, e.target.value)}
                />
              )}{' '}
              {errors[key] && (
                <span id={'error-' + key} className="admin-field-error">
                  {errors[key]}
                </span>
              )}
            </label>
          ))}
          <details
            open={advanced}
            onToggle={(e) => setAdvanced(e.currentTarget.open)}
          >
            <summary>Advanced Details</summary>
            <label htmlFor="product-slug">
              Slug
              <input
                id="product-slug"
                value={fields.slug}
                aria-invalid={!!errors.slug}
                aria-describedby="slug-help error-slug"
                onChange={(e) => update('slug', e.target.value)}
              />
            </label>
            <p id="slug-help" className="admin-muted">
              A short system label generated from the cookie name. You usually
              do not need to change it. Saved labels stay unchanged when
              renaming a cookie. This is not a product web address; uniqueness
              is not guaranteed.
            </p>
            {errors.slug && (
              <span id="error-slug" className="admin-field-error">
                {errors.slug}
              </span>
            )}
          </details>
          {(['ingredients', 'allergens'] as const).map((key) => (
            <label key={key} htmlFor={'product-' + key}>
              {key === 'ingredients' ? 'Ingredients' : 'Allergens'} (one per
              line)
              <textarea
                id={'product-' + key}
                value={key === 'ingredients' ? ingredients : allergens}
                aria-invalid={!!errors[key]}
                aria-describedby={errors[key] ? 'error-' + key : undefined}
                onChange={(e) =>
                  (key === 'ingredients' ? setIngredients : setAllergens)(
                    e.target.value,
                  )
                }
              />
              {errors[key] && (
                <span id={'error-' + key} className="admin-field-error">
                  {errors[key]}
                </span>
              )}
            </label>
          ))}
          <label htmlFor="product-active">
            Catalog status
            <select
              id="product-active"
              value={fields.active ? 'active' : 'inactive'}
              onChange={(e) => update('active', e.target.value === 'active')}
            >
              <option value="inactive">Inactive</option>
              <option value="active">Active</option>
            </select>
          </label>
          <p className="admin-muted">
            Deactivating a cookie may immediately hide it from assigned live
            Drops and prevent cart updates containing it. Reactivating can
            restore visibility where its Drop association remains active.
            Inventory and historical orders are not deleted. Saving does not
            assign it to a Drop or change inventory.
          </p>
        </fieldset>
        {message && <p role="alert">{message}</p>}
        <div className="admin-actions">
          <button
            type="submit"
            disabled={busy || uncertain || (!!product && !changed)}
          >
            {busy ? 'Saving…' : 'Save cookie'}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </section>
  );
}
