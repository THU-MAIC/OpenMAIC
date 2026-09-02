'use server';

import { cookies } from 'next/headers';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';

/**
 * The anonymous identity cookie minted by the agent-runtime owner resolution
 * (`lib/server/agent-runtime/owner.ts`). A server action has no `Request` to
 * hand to `resolveRequestOwnerId`, so this module re-reads the same cookie the
 * routes read, and mints with the same UUID-v4 scheme when it is absent or
 * forged (an over-strict guard is fail-safe: visitors merely get a fresh id,
 * nobody is locked out of their own sessions).
 */
const ANONYMOUS_COOKIE = 'anonymous_id';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function currentOwnerId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(ANONYMOUS_COOKIE)?.value;
  if (existing && UUID_V4.test(existing)) return `anon:${existing}`;
  const minted = crypto.randomUUID();
  cookieStore.set(ANONYMOUS_COOKIE, minted, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === 'production',
  });
  return `anon:${minted}`;
}

/** Server Action mutation used by the workspace row menu. */
export async function deleteWorkspaceSession(id: string): Promise<{ deleted: boolean }> {
  const sessionId = id.trim();
  if (!sessionId) return { deleted: false };
  const ownerId = await currentOwnerId();
  const store = await getAgentSessionStore();
  return { deleted: await store.softDeleteSession(sessionId, ownerId) };
}
