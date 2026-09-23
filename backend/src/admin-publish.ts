import { z } from 'zod';
import type { ApiEvent } from './api';
import { idSchema } from './domain';
import { body, validate, dropDto } from './admin-writes';
import type { CatalogRepository } from './repository';

export const publishRoute = 'POST /admin/drops/{dropId}/publish';
export async function adminPublish(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
) {
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  // An absent/empty HTTP body or a strict empty JSON object carries no publication fields.
  if (event.body !== undefined && event.body !== '')
    validate(z.strictObject({}), body(event));
  const result = await getRepository().publishDraft(dropId);
  return {
    status: 200,
    body: {
      drop: dropDto(result.drop),
      storefront: {
        storefrontDropId: result.storefront.storefrontDropId,
        updatedAt: result.storefront.updatedAt,
      },
    },
  };
}
