// A deliberately small presentation DTO, projected from protected composition.
export interface Overview {
  drop: {
    dropId: string;
    name: string;
    status: string;
    timezone: string;
    pickupLocation: string;
    pickupInstructions: string;
  };
  products: {
    id: string;
    name: string | null;
    active: boolean | null;
    assignedActive: boolean;
  }[];
  inventory: {
    productId: string;
    total: number;
    reserved: number;
    sold: number;
    available: number;
  }[];
  pickupDates: {
    date: string;
    startTime: string;
    endTime: string;
    timezone: string;
    active: boolean;
  }[];
}
export function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Invalid response');
  return v as Record<string, unknown>;
}
export function text(v: unknown, max = 4000): string {
  if (typeof v !== 'string' || v.length > max)
    throw new Error('Invalid response');
  return v;
}
export function id(v: unknown): string {
  const s = text(v, 26);
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(s))
    throw new Error('Invalid identifier');
  return s;
}
function flag(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('Invalid response');
  return v;
}
function list(v: unknown): unknown[] {
  if (!Array.isArray(v) || v.length > 500) throw new Error('Invalid response');
  return v;
}
function zone(v: unknown): string {
  const s = text(v, 100);
  new Intl.DateTimeFormat('en-US', { timeZone: s }).format(0);
  return s;
}
function quantity(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0)
    throw new Error('Invalid inventory');
  return v as number;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length)
    throw new Error('Duplicate records');
}
export function composition(value: unknown, assignedId: string): Overview {
  const root = record(value),
    d = record(root.drop);
  if (
    id(d.dropId) !== assignedId ||
    ![
      'DRAFT',
      'SCHEDULED',
      'OPEN',
      'PAUSED',
      'SOLD_OUT',
      'CLOSED',
      'COMPLETED',
    ].includes(text(d.status))
  )
    throw new Error('Inconsistent Drop');
  const products = list(root.products).map((value) => {
    const entry = record(value),
      relation = record(entry.dropProduct);
    const productId = id(relation.productId);
    if (id(relation.dropId) !== assignedId)
      throw new Error('Inconsistent relation');
    const product = entry.product === null ? null : record(entry.product);
    if (product && id(product.productId) !== productId)
      throw new Error('Inconsistent product');
    return {
      id: productId,
      name: product ? text(product.name) : null,
      active: product ? flag(product.active) : null,
      assignedActive: flag(relation.active),
    };
  });
  const inventory = list(root.inventory).map((value) => {
    const row = record(value);
    if (id(row.dropId) !== assignedId)
      throw new Error('Inconsistent inventory');
    const total = quantity(row.total),
      reserved = quantity(row.reserved),
      sold = quantity(row.sold),
      available = quantity(row.available);
    if (reserved > total - sold || available !== total - reserved - sold)
      throw new Error('Inconsistent inventory');
    return { productId: id(row.productId), total, reserved, sold, available };
  });
  const pickupDates = list(root.pickupDates).map((value) => {
    const p = record(value),
      date = text(p.date, 10),
      startTime = text(p.startTime, 5),
      endTime = text(p.endTime, 5);
    if (
      id(p.dropId) !== assignedId ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
      endTime <= startTime
    )
      throw new Error('Invalid pickup');
    return {
      date,
      startTime,
      endTime,
      timezone: zone(p.timezone),
      active: flag(p.active),
    };
  });
  unique(products.map((p) => p.id));
  unique(inventory.map((p) => p.productId));
  unique(pickupDates.map((p) => p.date));
  return {
    drop: {
      dropId: assignedId,
      name: text(d.name),
      status: text(d.status),
      timezone: zone(d.timezone),
      pickupLocation: text(d.pickupLocation),
      pickupInstructions: text(d.pickupInstructions),
    },
    products,
    inventory,
    pickupDates,
  };
}
