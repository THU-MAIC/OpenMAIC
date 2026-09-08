/**
 * Signed session token for the SSO cookie (edge + Node safe).
 *
 * The cookie carries a compact self-describing payload so the Edge middleware
 * can decide routing (role + expiry) without a database round trip, while the
 * Node routes re-check the session row for revocation. The payload is
 * `base64url(JSON).base64url(HMAC-SHA256)` — the same HMAC pattern the
 * ACCESS_CODE cookie already uses, built on Web Crypto so both runtimes share
 * one implementation.
 */

import { getSessionSigningSecret, getSessionTtlDays } from '@/lib/config/sso';

export const SESSION_COOKIE_NAME = 'openmaic_session';

export interface SessionClaims {
  /** Payload version. */
  v: 1;
  /** `user_sessions.id` — the row a Node route can revoke. */
  sid: string;
  /** `user_accounts.id`. */
  uid: string;
  /** Vendor role: '0' (admin) | '3' (teacher) | '4' (student). */
  role: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function importSigningKey(): Promise<CryptoKey> {
  const secret = getSessionSigningSecret();
  if (!secret) throw new Error('Session signing secret is not configured');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSessionToken(claims: SessionClaims): Promise<string> {
  const key = await importSigningKey();
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Length-constant comparison — same approach as the ACCESS_CODE verifier. */
function signaturesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  const dotIndex = token.indexOf('.');
  if (dotIndex <= 0 || dotIndex === token.length - 1) return null;

  const payloadPart = token.substring(0, dotIndex);
  const signaturePart = token.substring(dotIndex + 1);

  const payloadBytes = base64UrlToBytes(payloadPart);
  const signatureBytes = base64UrlToBytes(signaturePart);
  if (!payloadBytes || !signatureBytes) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  const candidate = claims as Partial<Record<keyof SessionClaims, unknown>>;
  if (
    candidate.v !== 1 ||
    typeof candidate.sid !== 'string' ||
    typeof candidate.uid !== 'string' ||
    typeof candidate.role !== 'string' ||
    typeof candidate.exp !== 'number'
  ) {
    return null;
  }

  const key = await importSigningKey();
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadPart));
  if (!signaturesEqual(new Uint8Array(expected), signatureBytes)) return null;

  if (candidate.exp * 1000 <= Date.now()) return null;

  return { v: 1, sid: candidate.sid, uid: candidate.uid, role: candidate.role, exp: candidate.exp };
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
} as const;

/** Seconds of session lifetime, matching the cookie maxAge contract. */
export function sessionTtlSeconds(): number {
  return getSessionTtlDays() * 24 * 60 * 60;
}
