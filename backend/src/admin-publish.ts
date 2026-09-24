import { z } from 'zod';
import type { ApiEvent } from './api';
import { idSchema } from './domain';
import { body, validate, dropDto } from './admin-writes';
import type { CatalogRepository } from './repository';
import type { OpeningSchedules } from './opening-schedules';
import { AdminError } from './admin-auth';

export const publishRoute = 'POST /admin/drops/{dropId}/publish';
export async function adminPublish(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
  getSchedules: () => OpeningSchedules,
) {
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  // An absent/empty HTTP body or a strict empty JSON object carries no publication fields.
  if (event.body !== undefined && event.body !== '')
    validate(z.strictObject({}), body(event));
  const result = await getRepository().publishDraft(dropId);
  try {
    await getSchedules().ensure(result.drop);
  } catch {
    throw new AdminError(
      503,
      'PUBLICATION_SCHEDULING_FAILED',
      'Drop was published, but automatic opening could not be confirmed. Reconcile automatic opening.',
    );
  }
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
