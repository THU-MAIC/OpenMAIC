/**
 * POST /api/pbl/v2/git/enroll
 *
 * Fork-on-enrollment: provision the learner's Git repo for a PBL project.
 * Unlike the stateless `/evaluate` and `/instructor` routes, this is
 * OWNER-scoped — the server resolves the learner from the request
 * (`withRequestOwner`) and keys the registry on `principal.ownerId`, which is
 * the same identity as the runtime `learnerKey`.
 *
 * Idempotent: a re-enroll for an already-provisioned `(owner, stageId)`
 * returns the stored row without touching Gitea. The learner receives their
 * own repo-scoped token (embedded in `cloneUrl` and returned bare) — never the
 * server's admin `GITEA_TOKEN`.
 */

import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  findRepoByOwnerStage,
  publicRepoView,
  upsertPBLRepo,
  type PBLRepoRegistryRow,
} from '@/lib/persistence/pbl-repo-registry';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getGiteaConfig } from '@/lib/pbl/v2/git-bridge/config';
import { provisionLearnerRepo, type ProvisionedRepo } from '@/lib/pbl/v2/git-bridge/provision';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

export const runtime = 'nodejs';

const log = createLogger('PBL v2 Git Enroll');

interface EnrollRequest {
  stageId?: string;
  sceneId?: string;
  domainId?: string;
}

export async function POST(req: NextRequest) {
  const config = getGiteaConfig();
  if (!config) {
    return apiError('INTERNAL_ERROR', 503, 'Git bridge is not configured.');
  }
  if (!config.adminUser || !config.adminPassword) {
    return apiError(
      'INTERNAL_ERROR',
      503,
      'Gitea admin credentials are required to provision learner repos (set GITEA_ADMIN_USER and GITEA_ADMIN_PASSWORD).',
    );
  }

  let body: EnrollRequest;
  try {
    body = (await req.json()) as EnrollRequest;
  } catch {
    return apiError('PARSE_FAILED', 400, 'Request body must be valid JSON.');
  }

  const stageId = body?.stageId?.trim();
  if (!stageId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`stageId` is required.');
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const queryable = provider.pool as unknown as ConnectableQueryable;

    // Idempotent fast path: already enrolled, return the stored fork.
    const existing = await findRepoByOwnerStage(queryable, ownerId, stageId);
    if (existing) {
      return ownerJson(publicRepoView(existing), 200, responseHeaders);
    }

    let provisioned: ProvisionedRepo;
    try {
      provisioned = await provisionLearnerRepo({ config, ownerId, stageId });
    } catch (error) {
      log.error('[enroll] provisioning failed', error);
      return ownerApiError(
        'INTERNAL_ERROR',
        502,
        'Failed to provision the learner repo on the Git host.',
        responseHeaders,
      );
    }

    let row: PBLRepoRegistryRow;
    try {
      row = await upsertPBLRepo(queryable, {
        ownerId,
        stageId,
        sceneId: body.sceneId?.trim() || undefined,
        domainId: body.domainId?.trim() || undefined,
        ...provisioned,
      });
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      throw error;
    }

    return ownerJson(publicRepoView(row), 201, responseHeaders);
  });
}
