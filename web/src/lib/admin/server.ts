import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { composition, id, record, text } from './contract';

// Runtime-only configuration. ADMIN_SESSION_KEY is a shared random 32-byte hex
// key, never NEXT_PUBLIC_ or a build artifact. Rotating it invalidates all local
// sessions. AES-GCM seals an access token (no refresh/ID token) for <=15 minutes;
// it does not replace Gateway validation or provide immediate replay revocation.
export interface AdminConfig {
  NODE_ENV?: string;
  ADMIN_ORIGIN?: string;
  ADMIN_API_BASE_URL?: string;
  ADMIN_COGNITO_REGION?: string;
  ADMIN_COGNITO_CLIENT_ID?: string;
  ADMIN_SESSION_KEY?: string;
}
export const messages = {
  UNAUTHENTICATED: 'Sign in to view the administrative dashboard.',
  EXPIRED: 'Your session has expired. Please sign in again.',
  FORBIDDEN: 'This account does not have administrator access.',
  UNAVAILABLE: 'Administrative services are unavailable. Please try again.',
  CONFIGURATION:
    'Administrator sign-in is not configured. Contact the site operator.',
  INVALID:
    'The administrative response is inconsistent. Refresh or contact the site operator.',
  BROKEN_ASSIGNMENT:
    'The assigned Drop could not be found. Contact the site operator.',
  CREDENTIALS:
    'Sign-in was unsuccessful. Check your credentials or contact the site operator.',
  CHALLENGE:
    'This sign-in requires an unsupported setup step. Contact the site operator.',
  CODE: 'The verification code is incorrect or expired. Try again or restart sign-in.',
  PASSWORD: 'The new password does not meet the account requirements.',
  REQUEST: 'This request could not be accepted. Reload and try again.',
};
export class AdminFailure extends Error {
  constructor(
    public code: keyof typeof messages,
    public status = 503,
  ) {
    super(messages[code]);
  }
}
type Session = { token: string; expiresAt: number };
type Challenge = {
  session: string;
  username: string;
  name: string;
  expiresAt: number;
};
const challenges = ['NEW_PASSWORD_REQUIRED', 'SMS_MFA', 'SOFTWARE_TOKEN_MFA'];
const name = (c: AdminConfig, challenge = false) =>
  `${c.NODE_ENV === 'production' ? '__Host-' : ''}bb-admin${challenge ? '-challenge' : ''}`;
function settings(c: AdminConfig) {
  try {
    const origin = new URL(c.ADMIN_ORIGIN ?? ''),
      api = new URL(c.ADMIN_API_BASE_URL ?? '');
    for (const u of [origin, api]) {
      const local =
        c.NODE_ENV === 'development' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (
        (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw new Error();
    }
    if (
      origin.pathname !== '/' ||
      !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(c.ADMIN_COGNITO_REGION ?? '') ||
      !/^[a-zA-Z0-9]{1,128}$/.test(c.ADMIN_COGNITO_CLIENT_ID ?? '') ||
      !/^[a-f0-9]{64}$/i.test(c.ADMIN_SESSION_KEY ?? '')
    )
      throw new Error();
    return {
      origin: origin.origin,
      api: api.href.replace(/\/$/, ''),
      key: Buffer.from(c.ADMIN_SESSION_KEY!, 'hex'),
      cognito: `https://cognito-idp.${c.ADMIN_COGNITO_REGION}.amazonaws.com/`,
    };
  } catch {
    throw new AdminFailure('CONFIGURATION');
  }
}
function seal(value: Session | Challenge, c: AdminConfig, purpose: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', settings(c).key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  const result = Buffer.concat([iv, cipher.getAuthTag(), data]).toString(
    'base64url',
  );
  if (result.length > 3800) throw new AdminFailure('UNAVAILABLE');
  return result;
}
function read(
  cookie: string,
  c: AdminConfig,
  challenge = false,
): Record<string, unknown> {
  const cookieName = name(c, challenge),
    values = cookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(cookieName + '='));
  if (!values.length) throw new AdminFailure('UNAUTHENTICATED', 401);
  try {
    if (values.length !== 1) throw new Error();
    const raw = values[0].slice(cookieName.length + 1);
    if (raw.length > 3800 || !/^[\w-]+$/.test(raw)) throw new Error();
    const bytes = Buffer.from(raw, 'base64url'),
      decipher = createDecipheriv(
        'aes-256-gcm',
        settings(c).key,
        bytes.subarray(0, 12),
      );
    decipher.setAAD(Buffer.from(cookieName));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const result = record(
      JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString('utf8'),
      ),
    );
    if (
      !Number.isSafeInteger(result.expiresAt) ||
      (result.expiresAt as number) <= Date.now()
    )
      throw new AdminFailure('EXPIRED', 401);
    return result;
  } catch (e) {
    if (e instanceof AdminFailure) throw e;
    throw new AdminFailure('UNAUTHENTICATED', 401);
  }
}
function output(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, private',
      Vary: 'Cookie',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
function save(
  response: NextResponse,
  c: AdminConfig,
  value?: Session | Challenge,
  challenge = false,
) {
  response.cookies.set(
    name(c, challenge),
    value ? seal(value, c, name(c, challenge)) : '',
    {
      httpOnly: true,
      secure:
        c.NODE_ENV === 'production' || c.ADMIN_ORIGIN?.startsWith('https:'),
      sameSite: 'strict',
      path: '/',
      maxAge: value
        ? Math.max(0, Math.floor((value.expiresAt - Date.now()) / 1000))
        : 0,
    },
  );
  return response;
}
async function json(response: Request | Response, max = 262144) {
  if (
    !/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)|^application\/x-amz-json-1\.1(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    ) ||
    !response.body
  )
    throw new AdminFailure('INVALID', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new AdminFailure('INVALID', 502);
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
async function api(
  path: string,
  token: string,
  c: AdminConfig,
  fetcher: typeof fetch,
) {
  const response = await fetcher(settings(c).api + path, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new AdminFailure('EXPIRED', 401);
  if (response.status === 403) throw new AdminFailure('FORBIDDEN', 403);
  if (response.status === 409 && path === '/admin/storefront/assignment') {
    const body = await json(response);
    if (body.code === 'BROKEN_STOREFRONT_ASSIGNMENT')
      throw new AdminFailure('BROKEN_ASSIGNMENT', 409);
  }
  if (!response.ok) throw new AdminFailure('UNAVAILABLE', 502);
  return json(response);
}
async function identity(token: string, c: AdminConfig, fetcher: typeof fetch) {
  const body = await api('/admin/me', token, c, fetcher);
  if (
    body.authenticated !== true ||
    !text(body.subject, 256) ||
    !text(body.username, 256)
  )
    throw new AdminFailure('INVALID', 502);
}
export async function authorize(
  cookie: string,
  c: AdminConfig,
  fetcher: typeof fetch = fetch,
): Promise<Session> {
  settings(c);
  const value = read(cookie, c),
    token = text(value.token, 3600);
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
    throw new AdminFailure('UNAUTHENTICATED', 401);
  await identity(token, c, fetcher);
  return { token, expiresAt: value.expiresAt as number };
}
async function cognito(
  action: string,
  body: unknown,
  c: AdminConfig,
  fetcher: typeof fetch,
) {
  const response = await fetcher(settings(c).cognito, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });
  if (action === 'GlobalSignOut') {
    // Cognito documents HTTP 200 with an empty body. Do not interpret other
    // statuses or unexpected payloads as confirmed revocation.
    if (response.status !== 200) throw new AdminFailure('UNAVAILABLE', 502);
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength) throw new AdminFailure('INVALID', 502);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
    return {};
  }
  const result = await json(response, 16384);
  if (!response.ok) {
    const code = String(result.__type ?? '')
      .split('#')
      .pop();
    throw new AdminFailure(
      code === 'CodeMismatchException' || code === 'ExpiredCodeException'
        ? 'CODE'
        : code === 'InvalidPasswordException'
          ? 'PASSWORD'
          : 'CREDENTIALS',
      400,
    );
  }
  return result;
}
export async function adminRelay(
  request: Request,
  action: 'login' | 'challenge' | 'logout' | 'dashboard',
  c: AdminConfig,
  fetcher: typeof fetch = fetch,
): Promise<NextResponse> {
  try {
    const config = settings(c);
    if (request.method !== (action === 'dashboard' ? 'GET' : 'POST'))
      throw new AdminFailure('REQUEST', 405);
    if (
      action !== 'dashboard' &&
      (request.headers.get('origin') !== config.origin ||
        (request.headers.has('sec-fetch-site') &&
          request.headers.get('sec-fetch-site') !== 'same-origin'))
    )
      throw new AdminFailure('REQUEST', 403);
    const cookie = request.headers.get('cookie') ?? '';
    if (action === 'logout') {
      let revoked = false;
      try {
        const s = read(cookie, c);
        await cognito(
          'GlobalSignOut',
          { AccessToken: text(s.token, 3600) },
          c,
          fetcher,
        );
        revoked = true;
      } catch {
        /* Local sign-out always completes, including expired sessions. */
      }
      return save(
        save(output({ signedOut: true, revocationConfirmed: revoked }), c),
        c,
        undefined,
        true,
      );
    }
    if (action === 'dashboard') {
      const session = await authorize(cookie, c, fetcher);
      const assignment = await api(
        '/admin/storefront/assignment',
        session.token,
        c,
        fetcher,
      );
      let overview = null;
      if (assignment.dropId !== null) {
        const dropId = id(assignment.dropId);
        overview = composition(
          await api(
            `/admin/drops/${dropId}/composition`,
            session.token,
            c,
            fetcher,
          ),
          dropId,
        );
      }
      if (session.expiresAt <= Date.now())
        throw new AdminFailure('EXPIRED', 401);
      return output({
        overview,
        loadedAt: new Date().toISOString(),
        expiresAt: session.expiresAt,
      });
    }
    const input = await json(request, 8192);
    let result: Record<string, unknown>, username: string;
    if (action === 'login') {
      username = text(input.username, 128).trim();
      const password = text(input.password, 256);
      if (!username || !password) throw new AdminFailure('CREDENTIALS', 400);
      result = await cognito(
        'InitiateAuth',
        {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: c.ADMIN_COGNITO_CLIENT_ID,
          AuthParameters: { USERNAME: username, PASSWORD: password },
        },
        c,
        fetcher,
      );
    } else {
      const pending = read(cookie, c, true);
      username = text(pending.username, 128);
      const challenge = text(pending.name, 64);
      if (!challenges.includes(challenge))
        throw new AdminFailure('CHALLENGE', 400);
      const answer = text(input.answer, 256);
      if (
        !answer ||
        (challenge !== 'NEW_PASSWORD_REQUIRED' && !/^\d{6}$/.test(answer))
      )
        throw new AdminFailure('CODE', 400);
      result = await cognito(
        'RespondToAuthChallenge',
        {
          ClientId: c.ADMIN_COGNITO_CLIENT_ID,
          ChallengeName: challenge,
          Session: text(pending.session, 2048),
          ChallengeResponses: {
            USERNAME: username,
            [challenge === 'NEW_PASSWORD_REQUIRED'
              ? 'NEW_PASSWORD'
              : challenge === 'SMS_MFA'
                ? 'SMS_MFA_CODE'
                : 'SOFTWARE_TOKEN_MFA_CODE']: answer,
          },
        },
        c,
        fetcher,
      );
    }
    if (result.AuthenticationResult) {
      const auth = record(result.AuthenticationResult),
        token = text(auth.AccessToken, 2600);
      if (
        !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ||
        !Number.isSafeInteger(auth.ExpiresIn) ||
        (auth.ExpiresIn as number) <= 0
      )
        throw new AdminFailure('INVALID', 502);
      // Only Gateway + requireAdmin grant access. No decoded JWT claim grants it here.
      await identity(token, c, fetcher);
      const expiresAt =
        Date.now() + Math.min(auth.ExpiresIn as number, 900) * 1000;
      return save(
        save(output({ authenticated: true }), c, { token, expiresAt }),
        c,
        undefined,
        true,
      );
    }
    const challenge = text(result.ChallengeName, 64),
      parameters = record(result.ChallengeParameters ?? {});
    if (
      !challenges.includes(challenge) ||
      (challenge === 'NEW_PASSWORD_REQUIRED' &&
        parameters.requiredAttributes &&
        parameters.requiredAttributes !== '[]')
    )
      throw new AdminFailure('CHALLENGE', 400);
    const canonicalUsername =
      parameters.USER_ID_FOR_SRP ?? parameters.USERNAME ?? username;
    const pending = {
      session: text(result.Session, 2048),
      username: text(canonicalUsername, 128),
      name: challenge,
      expiresAt: Date.now() + 180000,
    };
    return save(save(output({ challenge }), c), c, pending, true);
  } catch (error) {
    const failure =
      error instanceof AdminFailure
        ? error
        : new AdminFailure(
            error instanceof TypeError ||
              (error instanceof DOMException &&
                ['TimeoutError', 'AbortError'].includes(error.name))
              ? 'UNAVAILABLE'
              : 'INVALID',
            502,
          );
    const response = output(
      { code: failure.code, message: failure.message },
      failure.status,
    );
    if (failure.code === 'REQUEST') return response;
    if (
      failure.status === 401 ||
      failure.code === 'FORBIDDEN' ||
      action === 'login'
    )
      save(response, c);
    if (
      action === 'login' ||
      failure.status === 401 ||
      failure.code === 'CHALLENGE'
    )
      save(response, c, undefined, true);
    return response;
  }
}
