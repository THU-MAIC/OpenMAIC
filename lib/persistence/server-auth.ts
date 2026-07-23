/**
 * DEVELOPMENT-ONLY authentication for the embedded persistence route.
 *
 * The browser-provided learner key is trusted as the partition identity. A
 * production deployment must replace this module with real authentication and
 * derive learner identity from server-controlled claims.
 */
import type { IncomingMessage } from 'node:http';

import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<RuntimeHttpPrincipal | undefined> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = singleHeader(req.headers.authorization);
  if (!token || authorization !== `Bearer ${token}`) return undefined;

  const learnerKey = singleHeader(req.headers['x-learner-key']);
  return learnerKey ? { learnerKey } : {};
}
