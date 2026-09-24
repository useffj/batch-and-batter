import type { ApiEvent, ApiResponse } from './api';

export interface InvocationContext {
  awsRequestId: string;
}

// Never derive operation names from paths, parameters, bodies or claims.
const operations = new Map([
  ['GET /health', 'health'],
  ['GET /drops/current', 'getCurrentDrop'],
  ['GET /drops/{dropId}', 'getDrop'],
  ['GET /admin/me', 'getAdminIdentity'],
  ['POST /admin/products', 'createProduct'],
  ['PUT /admin/products/{productId}', 'replaceProduct'],
  ['POST /admin/drops', 'createDraftDrop'],
  ['PUT /admin/drops/{dropId}', 'replaceDraftDrop'],
  ['GET /admin/drops/{dropId}/composition', 'getDropComposition'],
  ['POST /admin/drops/{dropId}/products', 'attachDropProduct'],
  ['PUT /admin/drops/{dropId}/products/{productId}', 'replaceDropProduct'],
  ['DELETE /admin/drops/{dropId}/products/{productId}', 'removeDropProduct'],
  ['PUT /admin/drops/{dropId}/pickups/{date}', 'putPickup'],
  ['DELETE /admin/drops/{dropId}/pickups/{date}', 'removePickup'],
  ['POST /admin/drops/{dropId}/publish', 'publishDrop'],
]);

const errorCodes = new Set([
  'NOT_FOUND',
  'INVALID_DROP_ID',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
  'DROP_NOT_READY',
  'STOREFRONT_OCCUPIED',
  'DROP_PRODUCT_NOT_FOUND',
  'PICKUP_NOT_FOUND',
  'DROP_PRODUCT_CONFLICT',
  'INVENTORY_NOT_EDITABLE',
  'COMPOSITION_CONFLICT',
  'PRODUCT_NOT_FOUND',
  'DROP_NOT_FOUND',
  'PRODUCT_CONFLICT',
  'DROP_CONFLICT',
  'DROP_NOT_EDITABLE',
]);

function requestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_+=.-]{1,128}$/.test(value)
    ? value
    : undefined;
}

export function logCompletion(
  event: ApiEvent,
  context: InvocationContext | undefined,
  response: ApiResponse,
  code?: string,
): void {
  // Logging must not turn a committed write into an apparent HTTP failure.
  try {
    const operation = operations.get(event.routeKey);
    const record = JSON.stringify({
      event: 'request.completed',
      requestId: requestId(event.requestContext.requestId),
      lambdaRequestId: requestId(context?.awsRequestId),
      routeKey: operation ? event.routeKey : 'unmatched',
      operation: operation ?? 'unmatched',
      statusCode: response.statusCode,
      ...(code && errorCodes.has(code) ? { code } : {}),
    });
    if (response.statusCode >= 500) console.error(record);
    else console.info(record);
  } catch {
    // No fallback event/error dump: the transport may be unavailable.
  }
}
