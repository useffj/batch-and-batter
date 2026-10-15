'use client';
import { useEffect, useState } from 'react';
import { AdminNavigation } from './navigation';
import './weekly-drops.css';
import {
  cents,
  priceText,
  denverLocal,
  denverUtc,
  weeklyDefaults,
  pickupDates,
  type WeeklyDrop,
  type WeeklyComposition,
  type WeeklyPickup,
} from '../../lib/admin/weekly';
async function request(path: string, method = 'GET', body?: unknown) {
  const r = await fetch('/api/admin/' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await r.json();
  if (r.status === 401 || r.status === 403) {
    window.location.replace('/admin/login?reason=expired');
    throw Error('Sign in again.');
  }
  if (!r.ok)
    throw Error(
      data.message ?? 'Request could not be confirmed. Reload before retrying.',
    );
  return data;
}
type Product = { productId: string; name: string; active: boolean };
type Selection = { productId: string; price: string; quantity: string };
export function WeeklyDrops({ expiresAt }: { expiresAt: number }) {
  useEffect(() => {
    const expire = () => {
      if (Date.now() >= expiresAt)
        window.location.replace('/admin/login?reason=expired');
    };
    const timer = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    window.addEventListener('focus', expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', expire);
    };
  }, [expiresAt]);
  const [drops, setDrops] = useState<WeeklyDrop[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [catalog, setCatalog] = useState<Product[]>([]),
    [catalogCursor, setCatalogCursor] = useState<string | null>(null),
    [current, setCurrent] = useState<WeeklyComposition | null>(null),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [opening, setOpening] = useState(weeklyDefaults()),
    [location, setLocation] = useState(''),
    [instructions, setInstructions] = useState(''),
    [selected, setSelected] = useState<Selection[]>([]),
    [pickups, setPickups] = useState<WeeklyPickup[]>([]),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false);
  const editable = creating || current?.drop.status === 'DRAFT';
  const dirty =
    !!current &&
    (name !== current.drop.name ||
      opening !== denverLocal(current.drop.opensAt) ||
      location !== current.drop.pickupLocation ||
      instructions !== current.drop.pickupInstructions ||
      JSON.stringify(pickups) !== JSON.stringify(current.pickupDates) ||
      JSON.stringify(selected) !==
        JSON.stringify(
          current.products.map((p) => ({
            productId: p.dropProduct.productId,
            price: priceText(p.dropProduct.priceCents),
            quantity: String(
              current.inventory.find(
                (i) => i.productId === p.dropProduct.productId,
              )?.total ?? 0,
            ),
          })),
        ));
  useEffect(() => {
    if (!dirty && !creating) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, creating]);
  const canDiscard = () =>
    (!dirty && !creating) || window.confirm('Discard unsaved Drop edits?');

  async function list(more = false) {
    const data = await request(
      'drops' + (more && cursor ? '?cursor=' + cursor : ''),
    );
    setDrops((old) => (more ? [...old, ...data.drops] : data.drops));
    setCursor(data.nextCursor);
  }
  async function products(more = false) {
    const data = await request(
      'products' + (more && catalogCursor ? '?cursor=' + catalogCursor : ''),
    );
    setCatalog((old) => {
      const all = more ? [...old, ...data.products] : data.products;
      return [
        ...new Map<string, Product>(
          all.map((p: Product) => [p.productId, p]),
        ).values(),
      ];
    });
    setCatalogCursor(data.nextCursor);
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : 'Unable to save. Reload before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([request('drops'), request('products')])
      .then(([d, p]) => {
        if (active) {
          setDrops(d.drops);
          setCursor(d.nextCursor);
          setCatalog(p.products);
          setCatalogCursor(p.nextCursor);
        }
      })
      .catch(() => {
        if (active) setMessage('Unable to load Drops. Sign in again or retry.');
      });
    return () => {
      active = false;
    };
  }, []);

  function populate(data: WeeklyComposition) {
    setCreating(false);
    setCurrent(data);
    setName(data.drop.name);
    setOpening(denverLocal(data.drop.opensAt));
    setLocation(data.drop.pickupLocation);
    setInstructions(data.drop.pickupInstructions);
    setSelected(
      data.products.map((p) => ({
        productId: p.dropProduct.productId,
        price: priceText(p.dropProduct.priceCents),
        quantity: String(
          data.inventory.find((i) => i.productId === p.dropProduct.productId)
            ?.total ?? 0,
        ),
      })),
    );
    setPickups(data.pickupDates);
    setPreview(false);
  }
  function fresh() {
    setCurrent(null);
    setCreating(true);
    setName('');
    setOpening(weeklyDefaults());
    setLocation('');
    setInstructions('');
    setSelected([]);
    setPickups([]);
    setPreview(false);
    setMessage('');
  }
  async function load(id: string) {
    populate(await request('drops/' + id + '/composition'));
  }
  function configurePickup() {
    setPickups(
      pickupDates(opening).map((date) => ({
        dropId: current?.drop.dropId ?? '',
        date,
        startTime: '16:00',
        endTime: '19:00',
        timezone: 'America/Denver',
        active: true,
      })),
    );
  }
  async function save() {
    const opensAt = denverUtc(opening);
    if (!name.trim() || !location.trim())
      throw Error('Enter a Drop name and pickup location.');
    const prices = selected.map((s) => {
      if (
        !/^\d+$/.test(s.quantity) ||
        !Number.isSafeInteger(Number(s.quantity))
      )
        throw Error('Inventory must be a nonnegative whole number.');
      return {
        productId: s.productId,
        priceCents: cents(s.price),
        inventoryTotal: Number(s.quantity),
      };
    });
    for (const p of pickups) {
      const minutes = (x: string) =>
        Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
      const duration = minutes(p.endTime) - minutes(p.startTime);
      if (
        duration < 120 ||
        duration > 180 ||
        !pickupDates(opening).includes(p.date)
      )
        throw Error(
          'Use Thursday–Saturday pickup windows lasting 2–3 hours after this opening.',
        );
    }
    let drop = current?.drop;
    if (!drop) {
      const result = await request('drops', 'POST', {
        name,
        description: '',
        opensAt,
        quantityLimit: 12,
        timezone: 'America/Denver',
        pickupLocation: location,
        pickupInstructions: instructions,
      }).catch(async () => {
        setCreating(false);
        await list();
        throw Error(
          'Creation could not be confirmed. Check the saved Drops before creating another.',
        );
      });
      drop = result.drop;
      setCurrent({ drop: drop!, products: [], inventory: [], pickupDates: [] });
      setCreating(false);
    }
    const updated = {
      ...drop!,
      name,
      opensAt,
      pickupLocation: location,
      pickupInstructions: instructions,
    };
    await request('drops/' + drop!.dropId + '/draft', 'PUT', {
      revision: drop!.updatedAt,
      drop: updated,
      products: prices,
      pickups: pickups.map((p) => ({ ...p, dropId: drop!.dropId })),
    });
    await load(drop!.dropId);
    await list();
    setMessage('Draft saved.');
  }
  async function transition(operation: string) {
    if (!current) return;
    if (dirty)
      throw Error(
        'Save or reload your edits before changing publication status.',
      );
    if (
      !window.confirm(
        operation === 'publish'
          ? 'Publish this saved Drop? It becomes customer-visible. Scheduling must be operational before automatic opening can be relied upon.'
          : `Confirm ${operation} for this Drop?`,
      )
    )
      return;
    try {
      await request(
        'drops/' + current.drop.dropId + '/' + operation,
        'POST',
        {},
      );
    } finally {
      await load(current.drop.dropId);
      await list();
    }
  }
  return (
    <div className="admin-shell">
      <AdminNavigation current="drops" />
      <main className="admin-main weekly-drops">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-stone-500">
              Batch &amp; Batter · Administration
            </p>
            <h1 className="text-3xl font-semibold">Weekly Drops</h1>
          </div>
          <button
            disabled={busy}
            onClick={() => {
              if (canDiscard()) fresh();
            }}
            className="rounded bg-stone-900 px-5 py-3 text-white"
          >
            Create Drop
          </button>
        </header>
        <p role="status" aria-live="polite">
          {message}
        </p>
        <section aria-label="Saved Drops" className="flex flex-wrap gap-3">
          {drops.map((d) => (
            <button
              key={d.dropId}
              disabled={busy}
              onClick={() => {
                if (canDiscard()) void action(() => load(d.dropId));
              }}
              className="rounded border border-stone-300 bg-white p-4 text-left"
            >
              <strong>{d.name}</strong>
              <br />
              {d.status} · {denverLocal(d.opensAt).replace('T', ' ')} Denver
            </button>
          ))}
          {cursor && (
            <button onClick={() => void action(() => list(true))}>
              Load more Drops
            </button>
          )}
        </section>
        {(creating || current) && (
          <section className="space-y-6 rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="text-2xl font-medium">
              {creating ? 'New weekly Drop' : current?.drop.name}
            </h2>
            <p>
              {current?.drop.status ?? 'DRAFT'} · Ordering remains available
              until sold out. Maximum 12 cookies by default; cart reservations
              remain 8 minutes.
            </p>
            <fieldset
              disabled={!editable || busy || preview}
              className="space-y-5"
            >
              <legend className="sr-only">Draft configuration</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <label>
                  Drop name
                  <input
                    className="block w-full rounded border p-3"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  Opening · Denver time
                  <input
                    type="datetime-local"
                    className="block w-full rounded border p-3"
                    value={opening}
                    onChange={(e) => setOpening(e.target.value)}
                  />
                </label>
                <label>
                  Pickup location
                  <input
                    className="block w-full rounded border p-3"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                  />
                </label>
                <label>
                  Pickup instructions
                  <textarea
                    className="block w-full rounded border p-3"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                  />
                </label>
              </div>
              <h3 className="text-xl">Cookies, prices and planned inventory</h3>
              <p>
                Select up to 24 cookies. Prices apply only to this Drop.
                Reservations and sales cannot be overwritten.
              </p>
              {[
                ...new Map(
                  [
                    ...catalog,
                    ...(current?.products.flatMap((p) =>
                      p.product ? [p.product] : [],
                    ) ?? []),
                  ].map((p) => [p.productId, p]),
                ).values(),
              ].map((p) => {
                const row = selected.find((s) => s.productId === p.productId);
                return (
                  <div
                    key={p.productId}
                    className="grid gap-3 border-b py-4 sm:grid-cols-3"
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={!!row}
                        disabled={(!p.active || selected.length >= 24) && !row}
                        onChange={(e) =>
                          setSelected((old) =>
                            e.target.checked
                              ? [
                                  ...old,
                                  {
                                    productId: p.productId,
                                    price: '',
                                    quantity: '0',
                                  },
                                ]
                              : old.filter((x) => x.productId !== p.productId),
                          )
                        }
                      />{' '}
                      {p.name}
                      {!p.active ? ' (inactive)' : ''}
                    </label>
                    {row && (
                      <>
                        <label>
                          Price ($)
                          <input
                            className="block w-full rounded border p-2"
                            inputMode="decimal"
                            value={row.price}
                            onChange={(e) =>
                              setSelected((old) =>
                                old.map((s) =>
                                  s.productId === p.productId
                                    ? { ...s, price: e.target.value }
                                    : s,
                                ),
                              )
                            }
                          />
                        </label>
                        <label>
                          Planned cookies
                          <input
                            className="block w-full rounded border p-2"
                            inputMode="numeric"
                            value={row.quantity}
                            onChange={(e) =>
                              setSelected((old) =>
                                old.map((s) =>
                                  s.productId === p.productId
                                    ? { ...s, quantity: e.target.value }
                                    : s,
                                ),
                              )
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                );
              })}
              {catalogCursor && (
                <button onClick={() => void action(() => products(true))}>
                  Load more cookies
                </button>
              )}
              <h3 className="text-xl">Pickup dates and hours</h3>
              <button
                className="rounded border px-4 py-2"
                onClick={configurePickup}
              >
                Use following Thursday–Saturday
              </button>
              <p>
                Each pickup window must last 2–3 hours. No pickup capacity
                limit.
              </p>
              {pickups.map((p, i) => (
                <div key={p.date} className="flex flex-wrap gap-4">
                  <strong>{p.date}</strong>
                  <label>
                    From
                    <input
                      aria-label={`Pickup start ${p.date}`}
                      type="time"
                      value={p.startTime}
                      onChange={(e) =>
                        setPickups((old) =>
                          old.map((x, j) =>
                            i === j ? { ...x, startTime: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Until
                    <input
                      aria-label={`Pickup end ${p.date}`}
                      type="time"
                      value={p.endTime}
                      onChange={(e) =>
                        setPickups((old) =>
                          old.map((x, j) =>
                            i === j ? { ...x, endTime: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
              ))}
            </fieldset>
            {preview && (
              <section
                aria-label="Drop preview"
                className="rounded bg-stone-50 p-4"
              >
                <h3>{name}</h3>
                <p>
                  {opening.replace('T', ' ')} America/Denver · {location}
                </p>
                {selected.map((s) => (
                  <p key={s.productId}>
                    {catalog.find((p) => p.productId === s.productId)?.name ??
                      current?.products.find(
                        (p) => p.product?.productId === s.productId,
                      )?.product?.name ??
                      'Unavailable cookie'}{' '}
                    — ${s.price} · {s.quantity} planned
                  </p>
                ))}
                {pickups.map((p) => (
                  <p key={p.date}>
                    {p.date}: {p.startTime}–{p.endTime}
                  </p>
                ))}
                <p>{instructions}</p>
              </section>
            )}
            <div className="flex flex-wrap gap-4">
              <button
                className="rounded border px-4 py-3"
                onClick={() => setPreview(!preview)}
              >
                {preview ? 'Return to editor' : 'Preview Drop'}
              </button>
              {editable && (
                <button
                  disabled={busy}
                  className="rounded bg-stone-900 px-5 py-3 text-white"
                  onClick={() => void action(save)}
                >
                  Save draft
                </button>
              )}
              {current && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (canDiscard())
                      void action(() => load(current.drop.dropId));
                  }}
                >
                  Reload saved values
                </button>
              )}
            </div>
            {current && (
              <section className="space-y-3 border-t pt-4">
                <h3>Publication and status</h3>
                <p>
                  Actions apply to saved values. Publishing validates cookies,
                  inventory and pickup configuration. A scheduling failure may
                  leave the Drop published; reload to reconcile its status.
                </p>
                <div className="flex flex-wrap gap-4">
                  {(current.drop.status === 'DRAFT'
                    ? ['publish']
                    : current.drop.status === 'SCHEDULED'
                      ? ['open', 'close']
                      : current.drop.status === 'OPEN'
                        ? ['pause', 'close']
                        : current.drop.status === 'PAUSED'
                          ? ['resume', 'close']
                          : []
                  ).map((op) => (
                    <button
                      className="rounded border px-4 py-2 capitalize"
                      disabled={busy}
                      key={op}
                      onClick={() => void action(() => transition(op))}
                    >
                      {op}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
