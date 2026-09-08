import { NextRequest, NextResponse } from 'next/server';

import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { isAdminRole, isSsoConfigured } from '@/lib/config/sso';
import { isApiPath, isClassroomPath, isPublicPath } from '@/lib/auth/path-gates';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth/session-token';

/** Convert string to Uint8Array */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Verify an HMAC-signed token using Web Crypto API (Edge-compatible) */
async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(timestamp);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));

  // Constant-length comparison (not truly constant-time in JS, but sufficient here)
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hasValidAccessCookie(request: NextRequest): Promise<boolean> {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) return false;
  const cookie = request.cookies.get('openmaic_access');
  return Boolean(cookie?.value && (await verifyToken(cookie.value, accessCode)));
}

/**
 * Role of the SSO session carried by the request, or null. The middleware
 * runs at the edge with no database, so this trusts the signed cookie payload
 * (HMAC + expiry); Node routes re-check the live session row.
 */
async function readSessionRole(request: NextRequest): Promise<string | null> {
  if (!isSsoConfigured()) return null;
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const claims = await verifySessionToken(token);
  return claims ? claims.role : null;
}

function loginRedirect(request: NextRequest): NextResponse {
  const target = request.nextUrl.pathname + request.nextUrl.search;
  return NextResponse.redirect(
    new URL(`/login?redirect=${encodeURIComponent(target)}`, request.url),
  );
}

const SESSION_UNAUTHENTICATED_BODY = {
  success: false,
  errorCode: 'UNAUTHENTICATED',
  error: 'Login required',
};
const SESSION_FORBIDDEN_BODY = {
  success: false,
  errorCode: 'FORBIDDEN',
  error: 'Admin access required',
};
const ACCESS_CODE_BODY = {
  success: false,
  errorCode: 'INVALID_REQUEST',
  error: 'Access code required',
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Return an actual server-side 404 when either half of the workbench is off.
  // Edge middleware cannot reliably inspect server-only deployment variables,
  // so it enforces the public gate and leaves the complete runtime/database
  // check to Node. A Node-hosted middleware uses the same gate as startup.
  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Whitelist: SSO endpoints, access-code endpoints, health check, and the
  // login/forbidden pages themselves.
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const ssoConfigured = isSsoConfigured();
  const accessCodeSet = Boolean(process.env.ACCESS_CODE);
  const isApi = isApiPath(pathname);

  // ── Courseware viewing zone ──────────────────────────────────────────────
  // Gated by the SSO session, never by ACCESS_CODE, so teachers/students who
  // were invited to watch a courseware link are not asked for the admin code.
  if (isClassroomPath(pathname)) {
    if (!ssoConfigured) {
      // SSO disabled: keep the previous open behavior (no login system).
      return NextResponse.next();
    }
    const role = await readSessionRole(request);
    if (role) return NextResponse.next();
    // Admins holding the access code may preview courseware without an SSO
    // account; their interactions are simply not recorded.
    if (await hasValidAccessCookie(request)) return NextResponse.next();

    if (isApi) {
      return NextResponse.json(SESSION_UNAUTHENTICATED_BODY, { status: 401 });
    }
    return loginRedirect(request);
  }

  // ── Admin zone (generation homepage, workspace, workbench, APIs) ─────────
  // ACCESS_CODE, when set, remains the primary gate; an admin SSO session
  // (role '0') also passes. Logged-in non-admins are sent to /forbidden
  // instead of the password modal.
  if (accessCodeSet) {
    if (await hasValidAccessCookie(request)) return NextResponse.next();
    if (ssoConfigured) {
      const role = await readSessionRole(request);
      if (role) {
        if (isAdminRole(role)) return NextResponse.next();
        if (isApi) return NextResponse.json(SESSION_FORBIDDEN_BODY, { status: 403 });
        return NextResponse.redirect(new URL('/forbidden', request.url));
      }
    }
    if (isApi) {
      return NextResponse.json(ACCESS_CODE_BODY, { status: 401 });
    }
    // Page requests → let through, frontend shows modal
    return NextResponse.next();
  }

  // No ACCESS_CODE: the admin zone depends entirely on the SSO admin role.
  if (ssoConfigured) {
    const role = await readSessionRole(request);
    if (isAdminRole(role)) return NextResponse.next();
    if (role) {
      if (isApi) return NextResponse.json(SESSION_FORBIDDEN_BODY, { status: 403 });
      return NextResponse.redirect(new URL('/forbidden', request.url));
    }
    if (isApi) return NextResponse.json(SESSION_UNAUTHENTICATED_BODY, { status: 401 });
    return loginRedirect(request);
  }

  // Neither gate configured: open development mode.
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
