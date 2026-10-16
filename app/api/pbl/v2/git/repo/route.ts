/**
 * GET /api/pbl/v2/git/repo
 *
 * Read-only status of the learner's provisioned fork for a PBL project, for
 * the workspace to show "已开通 / 去开通" without a side-effecting enroll. No
 * Gitea call: it reads only the registry (`findRepoByOwnerStage`). Returns
 * `{ repo: null }` when the learner has not enrolled the project yet.
 */

import type { NextRequest } from 'next/server';

import { apiError } from '@/lib/server/api-response';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { findRepoByOwnerStage, publicRepoView } from '@/lib/persistence/pbl-repo-registry';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const stageId = new URL(req.url).searchParams.get('stageId')?.trim();
  if (!stageId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`stageId` is required.');
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const queryable = provider.pool as unknown as ConnectableQueryable;
    const row = await findRepoByOwnerStage(queryable, ownerId, stageId);
    return ownerJson({ repo: row ? publicRepoView(row) : null }, 200, responseHeaders);
  });
}
