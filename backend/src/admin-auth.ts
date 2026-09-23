import type { ApiEvent } from './api';

export const ADMIN_GROUP = 'batch-and-batter-admins';
export class AdminError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function groups(value: unknown): string[] {
  if (Array.isArray(value))
    return value.every((entry) => typeof entry === 'string' && entry.length > 0)
      ? value
      : [];
  if (typeof value !== 'string') return [];
  // Accept a JSON array, a single group, or Gateway's bracketed space-separated list.
  // Do not split arbitrary strings on commas or search for substrings.
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? groups(parsed) : [];
    } catch {
      if (/^\[[A-Za-z0-9_+=.@-]+(?: [A-Za-z0-9_+=.@-]+)*\]$/.test(value))
        return value.slice(1, -1).split(' ');
      return [];
    }
  }
  return [value];
}

export function requireAdmin(event: ApiEvent) {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims))
    throw new AdminError(401, 'UNAUTHORIZED', 'Authentication required.');
  if (claims.token_use !== 'access')
    throw new AdminError(403, 'FORBIDDEN', 'An access token is required.');
  const { sub, username } = claims;
  if (
    typeof sub !== 'string' ||
    !sub.trim() ||
    typeof username !== 'string' ||
    !username.trim()
  )
    throw new AdminError(401, 'UNAUTHORIZED', 'Authentication required.');
  if (!groups(claims['cognito:groups']).includes(ADMIN_GROUP))
    throw new AdminError(
      403,
      'FORBIDDEN',
      'Administrator membership required.',
    );
  return { authenticated: true as const, subject: sub, username };
}
