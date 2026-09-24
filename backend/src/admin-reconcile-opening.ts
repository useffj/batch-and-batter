import { z } from 'zod';
import type { ApiEvent } from './api';
import { AdminError } from './admin-auth';
import { idSchema } from './domain';
import { body, validate } from './admin-writes';
import { CatalogWriteError, type CatalogRepository } from './repository';
import {
  OpeningScheduleError,
  type OpeningSchedules,
} from './opening-schedules';

export const reconcileOpeningRoute =
  'POST /admin/drops/{dropId}/reconcile-opening';
export async function adminReconcileOpening(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
  getSchedules: () => OpeningSchedules,
) {
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  if (event.body !== undefined && event.body !== '')
    validate(z.strictObject({}), body(event));
  const repository = getRepository();
  const drop = await repository.getDrop(dropId);
  if (!drop) throw new CatalogWriteError('DROP_NOT_FOUND');
  if (drop.status !== 'SCHEDULED')
    throw new AdminError(
      409,
      'DROP_NOT_EDITABLE',
      'Only SCHEDULED Drops can have automatic opening reconciled.',
    );
  if ((await repository.getStorefrontDropId()) !== dropId)
    throw new CatalogWriteError('STOREFRONT_CONFLICT');
  try {
    await getSchedules().ensure(drop);
  } catch (error) {
    if (error instanceof OpeningScheduleError) {
      if (error.code === 'OPENING_TIME_PASSED')
        throw new AdminError(
          409,
          error.code,
          'Opening time has passed. Use the manual open operation.',
        );
      throw new AdminError(
        409,
        error.code,
        'Automatic opening configuration conflicts with this Drop.',
      );
    }
    throw new AdminError(
      503,
      'OPENING_SCHEDULE_UNCONFIRMED',
      'Automatic opening could not be confirmed. Retry reconciliation.',
    );
  }
  return { status: 200, body: { reconciled: true } };
}
