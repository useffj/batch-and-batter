import { z } from 'zod';
import type { ApiEvent } from './api';
import { idSchema } from './domain';
import { body, validate, dropDto } from './admin-writes';
import type { CatalogRepository } from './repository';

export const openRoute = 'POST /admin/drops/{dropId}/open';
export async function adminOpen(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
) {
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  if (event.body !== undefined && event.body !== '')
    validate(z.strictObject({}), body(event));
  const drop = await getRepository().openScheduled(dropId);
  return { status: 200, body: { drop: dropDto(drop) } };
}
