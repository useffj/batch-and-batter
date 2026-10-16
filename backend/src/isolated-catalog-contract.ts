export const ISOLATED_TABLE = 'batch-and-batter-dev-isolated-catalog';
export const isolatedRoutes = [
  'GET /admin/me',
  'GET /admin/storefront/assignment',
  'GET /admin/products',
  'POST /admin/products',
  'GET /admin/products/{productId}',
  'PUT /admin/products/{productId}',
  'GET /admin/drops',
  'POST /admin/drops',
  'GET /admin/drops/{dropId}/composition',
  'PUT /admin/drops/{dropId}/draft',
  'GET /admin/drops/{dropId}/preview',
] as const;
