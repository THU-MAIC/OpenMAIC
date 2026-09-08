/**
 * Server-side session resolution for route handlers.
 *
 * The middleware already filters most unauthenticated traffic at the edge
 * using the signed cookie payload; this helper is the authoritative Node-side
 * check routes use to load the live session row + account before acting on a
 * request (recording interactions, returning the profile, revoking logout).
 *
 * A cookie whose `sid` row is gone or expired — or whose account no longer
 * exists — answers `null` exactly like a missing cookie.
 */

import type { NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth/session-token';
import { isSsoConfigured } from '@/lib/config/sso';
import { findLiveUserSession, type UserAccountRow } from '@/lib/persistence/user-accounts';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

/** The account profile a request's session resolves to, or null. */
export async function getRequestUser(req: NextRequest): Promise<UserAccountRow | null> {
  if (!isSsoConfigured()) return null;

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const claims = await verifySessionToken(token);
  if (!claims) return null;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;

  try {
    const { pool } = await getServerPersistenceProvider(connectionString);
    const live = await findLiveUserSession(pool, claims.sid);
    if (!live) return null;
    // The signed uid must match the session's owner — a cookie is only valid
    // for the session row it was minted with.
    if (live.session.userId !== claims.uid) return null;
    return live.user;
  } catch (error) {
    console.error('[auth] Session lookup failed', error);
    return null;
  }
}

export interface PublicUserView {
  id: string;
  nick: string | null;
  username: string | null;
  userno: string | null;
  role: string;
  rolename: string | null;
  schoolName: string | null;
  className: string | null;
  headimg: string | null;
  edukuUserid: string;
  usertype: string | null;
  edukuOpenid: string | null;
}

/** The subset of the account the client may see (no internal timestamps). */
export function publicUserView(user: UserAccountRow): PublicUserView {
  return {
    id: user.id,
    nick: user.nick,
    username: user.username,
    userno: user.userno,
    role: user.role,
    rolename: user.rolename,
    schoolName: user.schoolName,
    className: user.className,
    headimg: user.headimg,
    edukuUserid: user.edukuUserid,
    usertype: user.usertype,
    edukuOpenid: user.edukuOpenid,
  };
}
