import { ExpiryReconciler, reconcileEventSchema } from './expiry-reconciler';
import { expiryDocumentClient, expiryDispatch } from './expiry-runtime';
let reconciler: ExpiryReconciler | undefined;
export const handler = (
  event: unknown,
  context?: { awsRequestId?: string; getRemainingTimeInMillis?: () => number },
) => {
  if (!reconcileEventSchema.safeParse(event).success)
    throw new Error('Invalid reconciliation event');
  reconciler ??= new ExpiryReconciler(
    expiryDocumentClient(),
    process.env.OPERATIONS_TABLE_NAME ?? '',
    expiryDispatch(),
  );
  return reconciler.run(context);
};
