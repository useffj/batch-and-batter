export const refundLabels: Record<string, string> = {
  AUTHORIZED: 'Refund authorized — not yet sent',
  DISPATCHED: 'Refund processing',
  PENDING: 'Refund processing',
  SUCCEEDED: 'Refund completed',
  FAILED: 'Refund failed — contact the bakery',
  CANCELED: 'Refund canceled — contact the bakery',
  RECONCILIATION_REQUIRED: 'Refund requires reconciliation',
};
export function refundCents(value: string) {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return result > 0 && result <= 99999999 ? result : null;
}
