/**
 * DEVELOPMENT-ONLY authentication for the embedded persistence route.
 *
 * NEXT_PUBLIC_PERSISTENCE_TOKEN ships in the public browser JavaScript bundle:
 * every visitor can extract it and impersonate ANY learner partition by
 * supplying an arbitrary x-learner-key. This is suitable only for localhost or
 * trusted-network, single-user deployments. Production must replace this
 * module with real session verification and derive learner identity from
 * server-controlled claims.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<RuntimeHttpPrincipal | undefined> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = singleHeader(req.headers.authorization);
  if (!token || !authorization || !secureEqual(authorization, `Bearer ${token}`)) return undefined;

  const learnerKey = singleHeader(req.headers['x-learner-key']);
  return learnerKey ? { learnerKey } : {};
}
