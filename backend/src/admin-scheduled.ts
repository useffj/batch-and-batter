import { z } from 'zod';
import type { ApiEvent } from './api';
import { AdminError } from './admin-auth';
import { body, dropDto, validate } from './admin-writes';
import { idSchema } from './domain';
import type { CatalogRepository } from './repository';
import type { OpeningSchedules } from './opening-schedules';
import { scheduledPatchSchema } from './scheduled-input';

export const scheduledRoutes = [
  'PATCH /admin/drops/{dropId}',
  'POST /admin/drops/{dropId}/cancel',
];
export async function adminScheduled(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
  getSchedules: () => OpeningSchedules,
  actor: string,
) {
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  const headers = Object.entries(event.headers ?? {}).filter(
    ([k]) => k.toLowerCase() === 'if-match',
  );
  if (headers.length !== 1 || !headers[0][1]?.match(/^"[^"]+"$/))
    throw new AdminError(
      400,
      'VALIDATION_ERROR',
      'A single quoted Drop updatedAt If-Match is required.',
    );
  const revision = validate(z.iso.datetime(), headers[0][1]!.slice(1, -1));
  if (Buffer.byteLength(event.body ?? '', 'utf8') > 32_768)
    throw new AdminError(400, 'VALIDATION_ERROR', 'Request body is too large.');
  const editing = event.routeKey === scheduledRoutes[0];
  const patch = editing ? validate(scheduledPatchSchema, body(event)) : null;
  if (!editing && event.body !== undefined && event.body !== '')
    validate(z.strictObject({}), body(event));
  const drop = await getRepository().changeScheduled(
    dropId,
    revision,
    actor,
    patch,
  );
  if (editing) {
    try {
      await getSchedules().ensure(drop);
    } catch {
      throw new AdminError(
        503,
        'OPENING_SCHEDULE_UNCONFIRMED',
        'Drop was edited, but automatic opening could not be confirmed. Read the Drop and reconcile automatic opening.',
      );
    }
  }
  return { status: 200, body: { drop: dropDto(drop) } };
}
