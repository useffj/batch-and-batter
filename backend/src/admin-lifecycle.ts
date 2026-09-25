import { z } from 'zod';
import type { ApiEvent } from './api';
import { idSchema } from './domain';
import { body, validate, dropDto } from './admin-writes';
import type { CatalogRepository } from './repository';

const operations = {
  'POST /admin/drops/{dropId}/pause': 'pauseDrop',
  'POST /admin/drops/{dropId}/resume': 'resumeDrop',
  'POST /admin/drops/{dropId}/close': 'closeDrop',
} as const;
export const lifecycleRoutes = Object.keys(operations);
export async function adminLifecycle(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
) {
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  if (event.body !== undefined && event.body !== '')
    validate(z.strictObject({}), body(event));
  const operation = operations[event.routeKey as keyof typeof operations];
  const drop = await getRepository()[operation](dropId);
  return { status: 200, body: { drop: dropDto(drop) } };
}
