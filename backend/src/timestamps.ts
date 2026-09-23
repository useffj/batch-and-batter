// Advance revision markers even within one millisecond or after clock regression.
export function updatedAt(previous?: string): string {
  return new Date(
    Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0),
  ).toISOString();
}
