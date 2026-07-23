/**
 * DEVELOPMENT-ONLY authentication for the embedded persistence route.
 *
 * The token is NOT a secret: NEXT_PUBLIC_PERSISTENCE_TOKEN is compiled into
 * the public browser bundle, so it is fully visible to every visitor and
 * provides no confidentiality and no user isolation — anyone who can load the
 * page can read and write EVERY learner partition and all documents by
 * supplying an arbitrary x-learner-key. Its only purpose is to keep unrelated
 * network scanners out of a trusted-network endpoint. Suitable only for
 * localhost or trusted-network, single-user deployments. Production must
 * replace this module with real session verification and derive learner
 * identity from server-controlled claims.
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
