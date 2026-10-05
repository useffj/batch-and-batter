import { z } from 'zod';
import { idSchema } from './domain';
import { CatalogWriteError, type CatalogRepository } from './repository';
import { schedulerSource } from './opening-schedules';
import type { InvocationContext } from './request-logging';

const internalEvent = z.strictObject({
  source: z.literal(schedulerSource),
  operation: z.literal('openDrop'),
  dropId: idSchema,
  openingRevision: z.iso.datetime().optional(),
});
function log(
  context: InvocationContext | undefined,
  result: string,
  code?: string,
) {
  try {
    const record = JSON.stringify({
      event: 'automatic_open.completed',
      lambdaRequestId:
        context?.awsRequestId &&
        /^[A-Za-z0-9_+=.-]{1,128}$/.test(context.awsRequestId)
          ? context.awsRequestId
          : undefined,
      operation: 'autoOpenDrop',
      source: schedulerSource,
      result,
      ...(code ? { code } : {}),
    });
    if (result === 'retryable' || result === 'rejected') console.error(record);
    else console.info(record);
  } catch {
    /* Logging cannot change transaction outcomes. */
  }
}
export function createAutoOpenHandler(getRepository: () => CatalogRepository) {
  return async (event: unknown, context?: InvocationContext) => {
    const parsed = internalEvent.safeParse(event);
    if (!parsed.success) {
      log(context, 'rejected', 'INVALID_INTERNAL_EVENT');
      return { result: 'rejected' };
    }
    let code = 'INTERNAL_ERROR';
    try {
      await getRepository().openScheduled(parsed.data.dropId, {
        openingRevision: parsed.data.openingRevision,
      });
      log(context, 'opened');
      return { result: 'opened' };
    } catch (error) {
      if (error instanceof CatalogWriteError) {
        code = error.code;
        if (
          [
            'STALE_OPENING',
            'DROP_NOT_EDITABLE',
            'DROP_NOT_FOUND',
            'STOREFRONT_CONFLICT',
          ].includes(code)
        ) {
          log(context, 'terminal', code);
          return { result: 'terminal', code };
        }
        if (code === 'DROP_NOT_READY') {
          // Distinguish early delivery from invalid readiness without changing the
          // authoritative opening operation or trusting a caller-supplied timestamp.
          try {
            const current = await getRepository().getDrop(parsed.data.dropId);
            if (
              current?.status === 'SCHEDULED' &&
              Date.now() < Date.parse(current.opensAt)
            )
              code = 'OPENING_TOO_EARLY';
            else {
              log(context, 'rejected', 'DROP_NOT_READY');
              return { result: 'rejected', code: 'DROP_NOT_READY' };
            }
          } catch {
            code = 'INTERNAL_ERROR';
          }
        }
      }
    }
    log(context, 'retryable', code);
    // Sanitized error triggers Lambda async retries, NOT Scheduler delivery retries.
    throw new Error(`Automatic opening retry required: ${code}`);
  };
}
