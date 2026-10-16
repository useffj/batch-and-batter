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

export async function weeklyDropRelay(
  request: Request,
  segments: string[],
  config: RuntimeConfig,
) {
  try {
    const key = await loadSessionKey(config);
    const { dropRelay } = await import('./server');
    return dropRelay(request, segments, { ...config, ADMIN_SESSION_KEY: key });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}

export async function orderRelay(
  request: Request,
  orderId: string | undefined,
  config: RuntimeConfig,
) {
  try {
    const key = await loadSessionKey(config);
    const { ordersRelay } = await import('./server');
    return ordersRelay(request, orderId, { ...config, ADMIN_SESSION_KEY: key });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}

export async function fulfillmentRelay(
  request: Request,
  orderId: string | undefined,
  config: RuntimeConfig,
) {
  try {
    const key = await loadSessionKey(config);
    const { relayFulfillment } = await import('./server');
    return relayFulfillment(request, orderId, {
      ...config,
      ADMIN_SESSION_KEY: key,
    });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}

export async function customerRelay(
  request: Request,
  action: 'search' | 'history',
  config: RuntimeConfig,
) {
  try {
    const key = await loadSessionKey(config);
    const { customersRelay } = await import('./server');
    return customersRelay(request, action, {
      ...config,
      ADMIN_SESSION_KEY: key,
    });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}

export async function notificationRelay(
  request: Request,
  orderId: string,
  config: RuntimeConfig,
) {
  try {
    const key = await loadSessionKey(config);
    const { notificationsRelay } = await import('./server');
    return notificationsRelay(request, orderId, {
      ...config,
      ADMIN_SESSION_KEY: key,
    });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}

export async function accessRelay(
  request: Request,
  orderId: string,
  action:
    | 'status'
    | 'reissue'
    | 'revoke'
    | 'request-status'
    | 'review'
    | 'refund-status'
    | 'authorize'
    | 'reconcile',
  config: RuntimeConfig,
) {
  try {
    const key = await loadSessionKey(config);
    const { guestAccessRelay } = await import('./server');
    return guestAccessRelay(request, orderId, action, {
      ...config,
      ADMIN_SESSION_KEY: key,
    });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}

export async function worklistRelay(request: Request, config: RuntimeConfig) {
  try {
    const key = await loadSessionKey(config);
    const { refundWorklistRelay } = await import('./server');
    return refundWorklistRelay(request, { ...config, ADMIN_SESSION_KEY: key });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}

export async function waitlistsRelay(
  request: Request,
  action: string,
  config: RuntimeConfig,
) {
  try {
    const key = await loadSessionKey(config);
    const { waitlistAdminRelay } = await import('./server');
    return waitlistAdminRelay(request, action, {
      ...config,
      ADMIN_SESSION_KEY: key,
    });
  } catch {
    return NextResponse.json(
      { message: messages.CONFIGURATION },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
      },
    );
  }
}
