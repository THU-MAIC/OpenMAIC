/**
 * GET /api/auth/session — the current SSO session (or null), plus the facts
 * the client needs to drive login UI: whether SSO is configured, the connect
 * URL, and the allowed postMessage origin.
 */

import type { NextRequest } from 'next/server';

import { getEdukuConnectOrigin, getEdukuConnectUrl, isSsoConfigured } from '@/lib/config/sso';
import { apiSuccess } from '@/lib/server/api-response';
import { getRequestUser, publicUserView } from '@/lib/server/auth/request-user';

export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  return apiSuccess({
    ssoEnabled: isSsoConfigured(),
    accessCodeEnabled: Boolean(process.env.ACCESS_CODE?.trim()),
    connectUrl: getEdukuConnectUrl(),
    connectOrigin: getEdukuConnectOrigin(),
    user: user ? publicUserView(user) : null,
  });
}
