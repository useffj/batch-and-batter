export function cents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw Error('Enter a nonnegative price with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw Error('Price is too large.');
  return n;
}
export function priceText(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid price.');
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
export function denverLocal(iso: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const p = (type: string) => parts.find((x) => x.type === type)!.value;
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
}
export function denverUtc(local: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local))
    throw Error('Enter an opening date and time.');
  const base = Date.parse(local + 'Z');
  const matches = [6, 7]
    .map((hours) => new Date(base + hours * 3600000).toISOString())
    .filter((x) => denverLocal(x) === local);
  if (matches.length !== 1)
    throw Error(
      'This Denver time is missing or ambiguous during daylight saving. Choose another time.',
    );
  return matches[0];
}
export function weeklyDefaults(now = new Date()) {
  const date = new Date(
    denverLocal(now.toISOString()).slice(0, 10) + 'T12:00:00Z',
  );
  date.setUTCDate(date.getUTCDate() + ((7 - date.getUTCDay()) % 7));
  let opening = date.toISOString().slice(0, 10) + 'T12:00';
  if (Date.parse(denverUtc(opening)) <= now.getTime()) {
    date.setUTCDate(date.getUTCDate() + 7);
    opening = date.toISOString().slice(0, 10) + 'T12:00';
  }
  return opening;
}
export function pickupDates(opening: string) {
  const d = new Date(opening.slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((4 - d.getUTCDay() + 7) % 7 || 7));
  return [0, 1, 2].map((n) =>
    new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10),
  );
}
export interface WeeklyDrop {
  dropId: string;
  name: string;
  description: string;
  status: string;
  opensAt: string;
  closesAt?: string;
  quantityLimit: number;
  timezone: string;
  pickupLocation: string;
  pickupInstructions: string;
  createdAt: string;
  updatedAt: string;
}
export interface WeeklyPickup {
  dropId: string;
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
  active: boolean;
}
export interface WeeklyComposition {
  drop: WeeklyDrop;
  products: {
    product: { productId: string; name: string; active: boolean } | null;
    dropProduct: {
      productId: string;
      priceCents: number;
      cookieUnits: number;
      active: boolean;
    };
  }[];
  inventory: {
    productId: string;
    total: number;
    reserved: number;
    sold: number;
  }[];
  pickupDates: WeeklyPickup[];
}
