/**
 * POST /api/auth/logout — revoke the current session row and clear the cookie.
 */

import type { NextRequest } from 'next/server';

import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  verifySessionToken,
} from '@/lib/auth/session-token';
import { revokeUserSession } from '@/lib/persistence/user-accounts';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('Auth Logout');

export async function POST(req: NextRequest) {
  const response = apiSuccess({});

  try {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    const claims = token ? await verifySessionToken(token) : null;
    const connectionString = process.env.DATABASE_URL?.trim();
    if (claims && connectionString) {
      const { pool } = await getServerPersistenceProvider(connectionString);
      await revokeUserSession(pool, claims.sid);
    }
  } catch (error) {
    // Logout must always clear the cookie, even when the database is down.
    log.warn('Session revocation failed; cookie still cleared:', error);
  }

  response.cookies.set(SESSION_COOKIE_NAME, '', {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: 0,
  });
  return response;
}
