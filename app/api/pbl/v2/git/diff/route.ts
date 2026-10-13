/**
 * POST /api/pbl/v2/git/diff
 *
 * Server-side Gitea diff fetch for the "提交评判" (pin SHA) flow. The client
 * holds the learner's fork full name and the pinned SHA, but must never hold
 * the Gitea token — so it asks the server to fetch the commit, its changed
 * files, and the raw unified diff. The returned diff feeds the formal rubric
 * evaluation (the client appends a `kind: 'git'` submission and runs the
 * normal `/api/pbl/v2/evaluate` flow).
 */

import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getGiteaConfig } from '@/lib/pbl/v2/git-bridge/config';
import { getCommit, getCommitDiff, listCommitFiles } from '@/lib/pbl/v2/git-bridge/gitea-client';

const log = createLogger('PBL v2 Git Diff');

const FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

export async function POST(req: NextRequest) {
  const config = getGiteaConfig();
  if (!config) {
    return apiError('INTERNAL_ERROR', 503, 'Git bridge is not configured.');
  }

  let body: { fullName?: string; sha?: string };
  try {
    body = (await req.json()) as { fullName?: string; sha?: string };
  } catch {
    return apiError('PARSE_FAILED', 400, 'Request body must be valid JSON.');
  }

  const fullName = body?.fullName?.trim();
  const sha = body?.sha?.trim();
  if (!fullName || !FULL_NAME_RE.test(fullName)) {
    return apiError('INVALID_REQUEST', 400, '`fullName` must be owner/repo.');
  }
  if (!sha || !/^[0-9a-fA-F]{7,64}$/.test(sha)) {
    return apiError('INVALID_REQUEST', 400, '`sha` must be a commit SHA.');
  }

  try {
    const [commit, diff] = await Promise.all([
      getCommit(config, fullName, sha),
      getCommitDiff(config, fullName, sha),
    ]);

    return apiSuccess({
      fullName,
      sha,
      commit: {
        sha: commit.sha,
        message: commit.message ?? '',
        created: commit.created,
      },
      changedFiles: listCommitFiles(commit),
      diff,
    });
  } catch (err) {
    log.error('[diff] Gitea fetch failed', err);
    return apiError('INTERNAL_ERROR', 502, 'Failed to fetch commit diff from Gitea.');
  }
}
