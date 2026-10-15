import { mediaRelay as relayMedia } from './server';
import type { MediaTarget } from './media-contract';
import 'server-only';
import { NextResponse } from 'next/server';
import {
  catalogRelay,
  adminRelay as relay,
  authorize as authorizeSession,
  AdminFailure,
  messages,
  logout,
} from './server';
import { loadSessionKey, type RuntimeConfig } from './session-key';
export { AdminFailure } from './server';

export async function authorize(cookie: string, config: RuntimeConfig) {
  let key: string;
  try {
    key = await loadSessionKey(config);
  } catch {
    throw new AdminFailure('CONFIGURATION');
  }
  return authorizeSession(cookie, { ...config, ADMIN_SESSION_KEY: key });
}
export async function adminRelay(
  request: Request,
  action: Parameters<typeof relay>[1],
  config: RuntimeConfig,
) {
  if (action === 'logout')
    return logout(request, config, fetch, async () => ({
      ...config,
      ADMIN_SESSION_KEY: await loadSessionKey(config),
    }));
  let key: string;
  try {
    key = await loadSessionKey(config);
  } catch {
    return NextResponse.json(
      { code: 'CONFIGURATION', message: messages.CONFIGURATION },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store, private',
          Vary: 'Cookie',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  }
  return relay(request, action, { ...config, ADMIN_SESSION_KEY: key });
}

export async function productRelay(
  request: Request,
  productId: string | undefined,
  config: RuntimeConfig,
) {
  let key: string;
  try {
    key = await loadSessionKey(config);
  } catch {
    return NextResponse.json(
      { code: 'CONFIGURATION', message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
  return catalogRelay(request, productId, {
    ...config,
    ADMIN_SESSION_KEY: key,
  });
}

export async function mediaRelay(
  request: Request,
  target: MediaTarget,
  config: RuntimeConfig,
) {
  let key: string;
  try {
    key = await loadSessionKey(config);
  } catch {
    return NextResponse.json(
      { code: 'CONFIGURATION', message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
  return relayMedia(request, target, { ...config, ADMIN_SESSION_KEY: key });
}
