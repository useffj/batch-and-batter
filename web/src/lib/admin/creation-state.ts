// Nonsecret, tab-local recovery references only. Payloads and authentication data
// are never persisted here. The scope is supplied by the authenticated server.
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function pendingCreation(
  storage: Pick<Storage, 'getItem'>,
  scope: string,
) {
  const value = storage.getItem(scope);
  if (value !== null && !uuid.test(value))
    throw new Error('Invalid pending creation reference');
  return value;
}
export function rememberCreation(
  storage: Pick<Storage, 'setItem'>,
  scope: string,
  key: string,
) {
  if (!uuid.test(key)) throw new Error('Invalid creation reference');
  storage.setItem(scope, key);
}

// A later rejected retry cannot prove that an earlier ambiguous attempt failed.
// Keep its identity until a successful result is reconciled.
export function canReleaseCreation(hadUnknownOutcome: boolean, code: string) {
  return (
    !hadUnknownOutcome &&
    [
      'VALIDATION_ERROR',
      'SLUG_CONFLICT',
      'PRODUCT_TOO_LARGE',
      'PRODUCT_WRITES_NOT_READY',
      'PRODUCT_CONFLICT',
      'IDEMPOTENCY_KEY_INVALID',
    ].includes(code)
  );
}
