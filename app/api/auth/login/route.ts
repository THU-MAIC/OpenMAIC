/**
 * POST /api/auth/login — exchange the Eduku one-time code for a session.
 *
 * The browser received the `classai-login` CODE through postMessage; it
 * forwards it here (never touching the app secret), the server exchanges it
 * with Eduku, upserts the account, mints a session row, and sets the signed
 * httpOnly session cookie.
 */

import type { NextRequest } from 'next/server';

import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  signSessionToken,
  sessionTtlSeconds,
} from '@/lib/auth/session-token';
import { isSsoConfigured } from '@/lib/config/sso';
import { createUserSession, upsertEdukuUser } from '@/lib/persistence/user-accounts';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { exchangeEdukuCode } from '@/lib/server/auth/eduku';
import { publicUserView } from '@/lib/server/auth/request-user';
import { createLogger } from '@/lib/logger';

const log = createLogger('Auth Login');

const MAX_CODE_LENGTH = 512;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (code === '' || code.length > MAX_CODE_LENGTH) {
      return apiError('INVALID_REQUEST', 400, 'A valid Eduku login code is required');
    }

    if (!isSsoConfigured()) {
      return apiError('SSO_NOT_CONFIGURED', 503, 'Eduku SSO is not configured on this server');
    }

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      return apiError(
        'SSO_NOT_CONFIGURED',
        503,
        'Database is not configured; login is unavailable',
      );
    }

    const exchanged = await exchangeEdukuCode(code);
    if ('failure' in exchanged) {
      const { failure } = exchanged;
      switch (failure.kind) {
        case 'not-configured':
          return apiError('SSO_NOT_CONFIGURED', 503, 'Eduku SSO is not configured on this server');
        case 'upstream-http':
          return apiError(
            'UPSTREAM_ERROR',
            502,
            failure.detail
              ? `Eduku token exchange failed — ${failure.detail}`
              : `Eduku token exchange failed (HTTP ${failure.status || 'transport error'})`,
          );
        case 'upstream-json':
          return apiError('UPSTREAM_ERROR', 502, `Eduku token exchange failed — ${failure.detail}`);
        case 'vendor-refusal':
          // The vendor validated our request (signature included) and refused:
          // expired/invalid code, unregistered app, or an unsupported account.
          return apiError('INVALID_CREDENTIALS', 401, `Eduku login refused — ${failure.detail}`);
      }
    }

    const { pool } = await getServerPersistenceProvider(connectionString);
    const user = await upsertEdukuUser(pool, exchanged.profile);
    const ttlSeconds = sessionTtlSeconds();
    const session = await createUserSession(pool, user.id, ttlSeconds * 1000);

    const token = await signSessionToken({
      v: 1,
      sid: session.id,
      uid: user.id,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    });

    const response = apiSuccess({ user: publicUserView(user) });
    response.cookies.set(SESSION_COOKIE_NAME, token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: ttlSeconds,
    });
    return response;
  } catch (error) {
    log.error('Login failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Login failed');
  }
}
