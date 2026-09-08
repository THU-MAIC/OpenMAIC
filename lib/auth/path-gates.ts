/**
 * Path classification shared by the Edge middleware and Node route handlers.
 *
 * Three zones:
 *
 *  - PUBLIC      — login, auth API, access-code API, health, forbidden page
 *  - CLASSROOM   — courseware viewing (pages + the APIs the viewer/chat/quiz
 *                  use). Gated by the SSO session, never by ACCESS_CODE, so
 *                  teachers/students without the admin code can watch.
 *  - ADMIN       — everything else (generation homepage, workspace, workbench,
 *                  generation APIs). Gated by ACCESS_CODE and/or an admin
 *                  (role '0') SSO session.
 *
 * Pure string helpers — no env reads, no imports — safe for both runtimes.
 */

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/forbidden' ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/access-code/') ||
    pathname === '/api/health'
  );
}

/**
 * APIs the courseware viewer needs. Prefix matches: `/api/chat` covers
 * `/api/chat/pi/*`, `/api/classroom` covers `/api/classroom-media/*`,
 * `/api/persistence/` covers the browser-persistence sync the viewer uses,
 * and `/api/transcription` serves the classroom chat's voice input (the same
 * route the admin homepage uses — exempted from ACCESS_CODE for that reason).
 */
const CLASSROOM_API_PREFIXES = [
  '/api/classroom',
  '/api/stage-meta/',
  '/api/quiz-grade',
  '/api/chat',
  '/api/pbl/v2/',
  '/api/interactions',
  '/api/persistence/',
  '/api/transcription',
];

export function isClassroomPath(pathname: string): boolean {
  if (pathname === '/classroom' || pathname.startsWith('/classroom/')) return true;
  return CLASSROOM_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** The same classification for a client-supplied path string (access-code modal). */
export function isClassroomViewingPath(pathname: string): boolean {
  return (
    pathname === '/classroom' ||
    pathname.startsWith('/classroom/') ||
    pathname === '/login' ||
    pathname === '/forbidden'
  );
}
