import {
  mediaPath,
  mediaInput,
  mediaResponse,
  mediaErrorCodes,
  type MediaTarget,
} from './media-contract';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import {
  catalogPage,
  catalogProduct,
  productFields,
  type ProductFields,
} from './products';
import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto';
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
type Session = { token: string; expiresAt: number; catalogScope?: string };
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
async function json(
  response: Request | Response,
  max = 262144,
  sizeError?: Error,
) {
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
      if (size > max) throw sizeError ?? new AdminFailure('INVALID', 502);
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
  return createHash('sha256')
    .update('product-create:' + body.subject)
    .digest('hex');
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
  const catalogScope = await identity(token, c, fetcher);
  return { token, expiresAt: value.expiresAt as number, catalogScope };
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
// Validate logout before key retrieval or cookie changes. Local cleanup does
// not need the encryption key; provider-wide revocation remains best effort.
export async function logout(
  request: Request,
  c: AdminConfig,
  fetcher: typeof fetch = fetch,
  resolveConfig: () => Promise<AdminConfig> = async () => c,
): Promise<NextResponse> {
  if (request.method !== 'POST')
    return output({ code: 'REQUEST', message: messages.REQUEST }, 405);
  let origin: URL;
  try {
    origin = new URL(c.ADMIN_ORIGIN ?? '');
    const local =
      c.NODE_ENV === 'development' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (
      (origin.protocol !== 'https:' &&
        !(local && origin.protocol === 'http:')) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    )
      throw new Error();
  } catch {
    return output(
      { code: 'CONFIGURATION', message: messages.CONFIGURATION },
      503,
    );
  }
  if (
    request.headers.get('origin') !== origin.origin ||
    (request.headers.has('sec-fetch-site') &&
      request.headers.get('sec-fetch-site') !== 'same-origin')
  )
    return output({ code: 'REQUEST', message: messages.REQUEST }, 403);
  let revoked = false;
  try {
    const configured = await resolveConfig();
    const session = read(request.headers.get('cookie') ?? '', configured);
    await cognito(
      'GlobalSignOut',
      { AccessToken: text(session.token, 3600) },
      configured,
      fetcher,
    );
    revoked = true;
  } catch {
    // SSM, decryption and Cognito failures never prevent local cookie removal.
  }
  return save(
    save(output({ signedOut: true, revocationConfirmed: revoked }), c),
    c,
    undefined,
    true,
  );
}

export async function adminRelay(
  request: Request,
  action: 'login' | 'challenge' | 'logout' | 'dashboard',
  c: AdminConfig,
  fetcher: typeof fetch = fetch,
): Promise<NextResponse> {
  if (action === 'logout') return logout(request, c, fetcher);
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

// Only authenticated full Product payloads use this cap. DynamoDB items are at most
// 400 KiB; JSON escaping can expand strings up to sixfold. 4 MiB leaves bounded
// room for that expansion and the DTO envelope. List/auth limits stay at 256 KiB.
export const PRODUCT_JSON_LIMIT = 4 * 1024 * 1024;
class ProductPayloadLimit extends Error {
  constructor(readonly status: number) {
    super('Product payload limit');
  }
}
// Fixed product routes only: never accepts an arbitrary upstream URL or token.
export async function catalogRelay(
  request: Request,
  productId: string | undefined,
  c: AdminConfig,
  fetcher: typeof fetch = fetch,
): Promise<NextResponse> {
  try {
    const config = settings(c);
    const method = request.method;
    if (!(productId ? ['GET', 'PUT'] : ['GET', 'POST']).includes(method))
      throw new AdminFailure('REQUEST', 405);
    if (
      method !== 'GET' &&
      (request.headers.get('origin') !== config.origin ||
        (request.headers.has('sec-fetch-site') &&
          request.headers.get('sec-fetch-site') !== 'same-origin'))
    )
      throw new AdminFailure('REQUEST', 403);
    const session = await authorize(
      request.headers.get('cookie') ?? '',
      c,
      fetcher,
    );
    let path = '/admin/products';
    if (productId !== undefined) path += '/' + id(productId);
    const cursor = new URL(request.url).searchParams.get('cursor');
    if (cursor !== null) {
      if (
        productId ||
        method !== 'GET' ||
        !/^[A-Za-z0-9_-]{1,8192}$/.test(cursor)
      )
        throw new AdminFailure('REQUEST', 400);
      path += '?cursor=' + encodeURIComponent(cursor);
    }
    const creationKey = new URL(request.url).searchParams.get('creationKey');
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (creationKey !== null) {
      if (method !== 'GET' || productId || cursor || !uuid.test(creationKey))
        throw new AdminFailure('REQUEST', 400);
      path += '?creationKey=' + encodeURIComponent(creationKey);
    }
    const requestKey = request.headers.get('idempotency-key');
    if (method === 'POST' && (!requestKey || !uuid.test(requestKey)))
      return output(
        {
          code: 'IDEMPOTENCY_KEY_INVALID',
          message: 'A valid creation request identity is required.',
        },
        400,
      );
    let fields: ProductFields | undefined, revision: string | undefined;
    if (method !== 'GET') {
      try {
        const input = await json(
          request,
          PRODUCT_JSON_LIMIT,
          new ProductPayloadLimit(413),
        );
        if (method === 'PUT') {
          revision = text(input.revision, 64);
          if (
            !/^\d{4}-\d\d-\d\dT/.test(revision) ||
            !Number.isFinite(Date.parse(revision))
          )
            throw new Error();
          delete input.revision;
        }
        fields = productFields(input);
      } catch (error) {
        if (error instanceof ProductPayloadLimit) throw error;
        return output(
          {
            code: 'VALIDATION_ERROR',
            message: 'Check the product fields and try again.',
          },
          400,
        );
      }
    }
    const response = await fetcher(config.api + path, {
      method,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.token}`,
        ...(fields ? { 'Content-Type': 'application/json' } : {}),
        ...(revision ? { 'If-Match': revision } : {}),
        ...(method === 'POST' ? { 'Idempotency-Key': requestKey! } : {}),
      },
      ...(fields ? { body: JSON.stringify(fields) } : {}),
    });
    if (response.status === 401) throw new AdminFailure('EXPIRED', 401);
    if (response.status === 403) throw new AdminFailure('FORBIDDEN', 403);
    if ([400, 404, 409, 413, 503].includes(response.status)) {
      const safeMessages: Record<string, string> = {
        SLUG_CONFLICT:
          'This slug is already used by another cookie, including inactive cookies. Choose another in Advanced Details.',
        IDEMPOTENCY_CONFLICT:
          'This creation request was already used with different details. Reconcile the original cookie first.',
        PRODUCT_WRITES_NOT_READY:
          'Product changes are not enabled until catalog preparation is complete.',
        PRODUCT_INTEGRITY_CONFLICT:
          'Catalog ownership needs operator attention. Nothing further should be saved.',
        PRODUCT_TOO_LARGE:
          'Cookie details exceed the safe storage size. Shorten the details before saving.',
      };
      const failure = await json(response);
      if (typeof failure.code === 'string' && safeMessages[failure.code])
        return output(
          { code: failure.code, message: safeMessages[failure.code] },
          response.status,
        );
      return output(
        {
          code:
            response.status === 409
              ? 'PRODUCT_CONFLICT'
              : response.status === 404
                ? 'PRODUCT_NOT_FOUND'
                : 'VALIDATION_ERROR',
          message:
            response.status === 409
              ? 'This product changed. Reload it before saving again.'
              : response.status === 404
                ? 'This product no longer exists.'
                : 'The backend rejected these product fields.',
        },
        response.status,
      );
    }
    if (!response.ok) throw new AdminFailure('UNAVAILABLE', 502);
    const result = await json(
      response,
      method === 'GET' && !productId && !creationKey
        ? 262144
        : PRODUCT_JSON_LIMIT,
      new ProductPayloadLimit(502),
    );
    const validated = creationKey
      ? {
          creation:
            result.creation === null ? null : catalogProduct(result.creation),
        }
      : method === 'GET' && !productId
        ? catalogPage(result)
        : { product: catalogProduct(result.product) };
    if (
      'product' in validated &&
      validated.product &&
      productId &&
      validated.product.productId !== productId
    )
      throw new Error();
    if (session.expiresAt <= Date.now()) throw new AdminFailure('EXPIRED', 401);
    return output(
      { ...validated, loadedAt: new Date().toISOString() },
      response.status,
    );
  } catch (e) {
    if (e instanceof ProductPayloadLimit)
      return output(
        {
          code: 'PRODUCT_TOO_LARGE',
          message:
            'This product response or request exceeds the supported size. No data has been truncated; contact the site operator.',
        },
        e.status,
      );
    const failure =
      e instanceof AdminFailure ? e : new AdminFailure('UNAVAILABLE', 502);
    const response = output(
      { code: failure.code, message: failure.message },
      failure.status,
    );
    return failure.status === 401 || failure.status === 403
      ? save(response, c)
      : response;
  }
}

// JSON-only media relay. Never forwards processor claims or arbitrary destinations.
export async function mediaRelay(
  request: Request,
  target: MediaTarget,
  c: AdminConfig,
  fetcher: typeof fetch = fetch,
): Promise<NextResponse> {
  try {
    const config = settings(c),
      method = request.method;
    let path: string;
    try {
      path = mediaPath(target, method);
      const query = new URL(request.url).searchParams;
      if (target.kind === 'ready') {
        if (
          query.get('view') !== 'ready' ||
          [...query.keys()].some((k) => !['view', 'after'].includes(k)) ||
          query.getAll('view').length !== 1 ||
          query.getAll('after').length > 1 ||
          (query.get('after') ?? undefined) !== target.after
        )
          throw new Error();
      } else if (query.size) throw new Error();
    } catch {
      throw new AdminFailure('REQUEST', 400);
    }
    if (
      method !== 'GET' &&
      (request.headers.get('origin') !== config.origin ||
        (request.headers.has('sec-fetch-site') &&
          request.headers.get('sec-fetch-site') !== 'same-origin'))
    )
      throw new AdminFailure('REQUEST', 403);
    const session = await authorize(
      request.headers.get('cookie') ?? '',
      c,
      fetcher,
    );
    let input: unknown;
    if (method !== 'GET') {
      try {
        input = mediaInput(
          await json(request, 16384, new AdminFailure('REQUEST', 413)),
          target.kind,
        );
      } catch (e) {
        if (e instanceof AdminFailure && e.status === 413) throw e;
        throw new AdminFailure('REQUEST', 400);
      }
    } else if (request.body) throw new AdminFailure('REQUEST', 400);
    const key = request.headers.get('idempotency-key');
    if (target.kind === 'uploads' && (!key || !UUID.test(key)))
      throw new AdminFailure('REQUEST', 400);
    const response = await fetcher(config.api + path, {
      method,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.token}`,
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(target.kind === 'uploads' ? { 'Idempotency-Key': key! } : {}),
      },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    if (response.status === 401) throw new AdminFailure('EXPIRED', 401);
    if (response.status === 403) throw new AdminFailure('FORBIDDEN', 403);
    if (!response.ok) {
      const failure = await json(response, 16384);
      if (
        [400, 404, 409, 410, 413, 422, 503].includes(response.status) &&
        typeof failure.code === 'string' &&
        mediaErrorCodes.includes(failure.code)
      )
        return output(
          {
            code: failure.code,
            message:
              'Unable to complete the media request. Reload or contact the operator.',
          },
          response.status,
        );
      throw new AdminFailure('UNAVAILABLE', 502);
    }
    const result = mediaResponse(await json(response, 32768), target);
    if (session.expiresAt <= Date.now()) throw new AdminFailure('EXPIRED', 401);
    return output(result, response.status);
  } catch (e) {
    const f =
      e instanceof AdminFailure ? e : new AdminFailure('UNAVAILABLE', 502);
    const response = output({ code: f.code, message: f.message }, f.status);
    return f.status === 401 || f.status === 403 ? save(response, c) : response;
  }
}

// Fixed Drop routes only, with the same session and same-origin protections.
export async function dropRelay(
  request: Request,
  segments: string[],
  c: AdminConfig,
  fetcher: typeof fetch = fetch,
): Promise<NextResponse> {
  try {
    const config = settings(c),
      method = request.method;
    const [dropId, action] = segments;
    if (
      segments.length > 2 ||
      (dropId && id(dropId) !== dropId) ||
      !(
        (!dropId && ['GET', 'POST'].includes(method)) ||
        (dropId && action === 'composition' && method === 'GET') ||
        (dropId && action === 'draft' && method === 'PUT') ||
        (dropId &&
          ['publish', 'open', 'pause', 'resume', 'close'].includes(action) &&
          method === 'POST')
      )
    )
      throw new AdminFailure('REQUEST', 405);
    if (
      method !== 'GET' &&
      (request.headers.get('origin') !== config.origin ||
        (request.headers.has('sec-fetch-site') &&
          request.headers.get('sec-fetch-site') !== 'same-origin'))
    )
      throw new AdminFailure('REQUEST', 403);
    const session = await authorize(
      request.headers.get('cookie') ?? '',
      c,
      fetcher,
    );
    let path = '/admin/drops' + (dropId ? '/' + dropId + '/' + action : '');
    const cursor = new URL(request.url).searchParams.get('cursor');
    if (cursor) {
      if (dropId || method !== 'GET' || !/^[A-Za-z0-9_-]{1,8192}$/.test(cursor))
        throw new AdminFailure('REQUEST', 400);
      path += '?cursor=' + cursor;
    }
    const payload =
      method === 'GET'
        ? undefined
        : await json(request, 256 * 1024, new AdminFailure('REQUEST', 413));
    const response = await fetcher(config.api + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + session.token,
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const data = await json(
      response,
      4 * 1024 * 1024,
      new AdminFailure('INVALID'),
    );
    if (!response.ok)
      return output(
        {
          code: 'DROP_REQUEST_FAILED',
          message:
            response.status === 409
              ? 'Drop changed or is not ready. Reload before retrying.'
              : response.status === 400
                ? 'Check the Drop details and try again.'
                : 'Drop request could not be confirmed. Reload to check its current state.',
        },
        response.status,
      );
    if (session.expiresAt <= Date.now()) throw new AdminFailure('EXPIRED', 401);
    return output(data, response.status);
  } catch (e) {
    return output(
      { message: e instanceof AdminFailure ? e.message : messages.UNAVAILABLE },
      e instanceof AdminFailure ? e.status : 503,
    );
  }
}
