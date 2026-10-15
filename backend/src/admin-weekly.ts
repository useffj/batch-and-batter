import { z } from 'zod';
import { AdminError } from './admin-auth';
import { summaryText } from './admin-catalog';
import type { ApiEvent } from './api';
import type { CatalogRepository } from './repository';
import { body, validate, dropDto } from './admin-writes';
import { weeklyDraftSchema } from './weekly-draft';
import { idSchema } from './domain';
export const weeklyRoutes = [
  'GET /admin/drops',
  'PUT /admin/drops/{dropId}/draft',
];
export async function adminWeekly(
  event: ApiEvent,
  getRepository: () => CatalogRepository,
) {
  const repo = getRepository();
  if (event.requestContext.http.method === 'GET') {
    const encoded = event.queryStringParameters?.cursor;
    let cursor;
    try {
      cursor =
        encoded === undefined
          ? undefined
          : validate(
              z.strictObject({
                PK: z.string().max(2048),
                SK: z.string().max(1024),
              }),
              JSON.parse(
                Buffer.from(
                  validate(
                    z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/),
                    encoded,
                  ),
                  'base64url',
                ).toString(),
              ),
            );
    } catch {
      throw new AdminError(400, 'VALIDATION_ERROR', 'Invalid Drop cursor.');
    }
    const page = await repo.listDrops!(cursor);
    return {
      status: 200,
      body: {
        drops: page.drops.map((d) => ({
          dropId: d.dropId,
          name: summaryText(d.name, 512).text,
          status: d.status,
          opensAt: d.opensAt,
        })),
        nextCursor: page.cursor
          ? Buffer.from(JSON.stringify(page.cursor)).toString('base64url')
          : null,
      },
    };
  }
  const input = validate(weeklyDraftSchema, body(event));
  const dropId = validate(idSchema, event.pathParameters?.dropId);
  validate(z.literal(dropId), input.drop.dropId);
  return {
    status: 200,
    body: { drop: dropDto(await repo.saveWeeklyDraft!(input)) },
  };
}
