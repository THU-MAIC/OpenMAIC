/**
 * Shared (single-tenant) owner identity, provided by the host through env.
 *
 * Upstream partitions courses, folders, materials and agent sessions by an
 * anonymous 30-day cookie (`resolveRequestOwnerId` → `anon:<uuid>`), and left a
 * hook for a host auth layer: an explicit `authenticatedOwnerId` is returned
 * verbatim. Nobody upstream threads that parameter yet, so every browser (and
 * the same browser after 30 days) sees an empty library while the courses stay
 * in Postgres.
 *
 * Single-tenant deployments (one team behind one `ACCESS_CODE`) want one shared
 * library instead. When `PERSISTENCE_SHARED_OWNER_ID` is set, every request
 * that passed the access-code gate resolves to that fixed owner, and
 * `POST /api/stages/[id]/publish` (which refuses `anon:` owners) works.
 *
 * Contract:
 *  - env unset/blank → `undefined` → upstream anonymous behaviour, untouched;
 *  - value must not start with `anon:` (that namespace is the cookie's);
 *  - `ACCESS_CODE` set → the request must carry a valid `openmaic_access`
 *    token (same HMAC check as middleware.ts); otherwise fall back to the
 *    anonymous path. `ACCESS_CODE` unset → the app has no gate at all, so the
 *    shared owner applies unconditionally.
 */

import { verifyAccessToken } from '@/lib/server/access-token';

export const SHARED_OWNER_ENV = 'PERSISTENCE_SHARED_OWNER_ID';
const ACCESS_COOKIE = 'openmaic_access';

function readCookie(headers: Headers, name: string): string | undefined {
  const encoded = headers.get('cookie');
  if (!encoded) return undefined;
  for (const item of encoded.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The configured shared owner id, or `undefined` when the feature is off. */
export function configuredSharedOwnerId(): string | undefined {
  const id = process.env[SHARED_OWNER_ENV]?.trim();
  if (!id || id.startsWith('anon:')) return undefined;
  return id;
}

/**
 * Resolve the shared owner for one request: the configured id when the
 * request is inside the access-code gate, otherwise `undefined` so the caller
 * keeps upstream's anonymous-cookie path.
 */
export function sharedOwnerId(req: Pick<Request, 'headers'>): string | undefined {
  const id = configuredSharedOwnerId();
  if (!id) return undefined;
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) return id;
  const token = readCookie(req.headers, ACCESS_COOKIE);
  return token && verifyAccessToken(token, accessCode) ? id : undefined;
}
