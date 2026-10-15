import { randomInt } from 'node:crypto';
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const orderReferencePattern =
  /^BB-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
export function newOrderReference() {
  return (
    'BB-' +
    Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join(
      '',
    )
  );
}
export const referenceKey = (reference: string) => {
  if (!orderReferencePattern.test(reference))
    throw Error('Invalid order reference');
  return { PK: 'ORDER_REFERENCE#' + reference, SK: 'META' };
};
export function orderIndexKeys(order: {
  dropId: string;
  orderId: string;
  createdAt: string;
  pickup: { date: string };
}) {
  return {
    GSI1PK: 'PICKUP#' + order.pickup.date,
    GSI1SK: `ORDER#${order.createdAt}#${order.orderId}`,
    GSI2PK: 'DROP#' + order.dropId,
    GSI2SK: `ORDER#${order.createdAt}#${order.orderId}`,
  };
}
