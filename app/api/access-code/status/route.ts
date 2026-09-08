import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { verifyAccessToken } from '@/lib/server/access-token';
import { isClassroomViewingPath } from '@/lib/auth/path-gates';
import { isAdminRole } from '@/lib/config/sso';
import { getRequestUser } from '@/lib/server/auth/request-user';

/**
 * Access-code gate status, made path-aware for the SSO login system.
 *
 * The client guard asks "must I show the password modal on THIS page?" The
 * answer is no when:
 *
 *  - the access-code cookie is valid (as before), or
 *  - an SSO session exists whose role grants this path: any logged-in user
 *    may watch a courseware page, and an admin (role '0') passes everywhere.
 *
 * Without the path awareness, a teacher/student logged in via Eduku would be
 * greeted with the admin password modal on the courseware they were invited
 * to watch.
 */
export async function GET(request: NextRequest) {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const cookieStore = await cookies();
    const token = cookieStore.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  if (!authenticated) {
    const user = await getRequestUser(request);
    if (user) {
      const pathname = request.nextUrl.searchParams.get('path') ?? '';
      authenticated = isAdminRole(user.role) || isClassroomViewingPath(pathname);
    }
  }

  return apiSuccess({ enabled, authenticated });
}
