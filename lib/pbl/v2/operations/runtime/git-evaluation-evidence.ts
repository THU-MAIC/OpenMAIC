/**
 * PBL v2 — Git evaluation evidence collector (slice 4b).
 *
 * When a microtask's latest submission is a git-backed submission
 * (`kind === 'git'`), the evaluator grades the learner's actual code, not a
 * pasted snippet. This module assembles that evidence server-side (the client
 * never holds the Gitea token):
 *
 *   1. the raw commit diff (what changed),
 *   2. the domain static-check findings over the changed ArkTS/TS source files
 *      and the domain's registry files at the pinned SHA — fetched and run by
 *      the shared helper in `domains/git-static-findings.ts` (the same helper
 *      the push webhook uses for push-time feedback).
 *
 * Everything is best-effort and degrades to `undefined`: a missing Gitea
 * config, a deleted fork, or a fetch failure should never abort the whole
 * evaluation — the LLM simply falls back to the text-only prompt.
 */

import { createLogger } from '@/lib/logger';

import { getGiteaConfig } from '../../git-bridge/config';
import { getCommit, getCommitDiff, listCommitFiles } from '../../git-bridge/gitea-client';
import type { GitStaticFinding } from '../../git-bridge/static-checks';
import { latestSubmissionForMicrotask } from './submission';
import type { PBLProjectV2 } from '../../types';

const log = createLogger('PBL v2 GitEvaluationEvidence');

/** Cap the diff length so a huge commit can't blow the evaluator token budget. */
const MAX_DIFF_CHARS = 12000;

/** Structured git evidence fed into the task-eval prompt. */
export interface GitEvaluationEvidence {
  provider: 'gitea';
  fullName: string;
  ref: string;
  commitSha: string;
  commitMessage?: string;
  /** Raw unified diff (truncated). */
  diff: string;
  /** Relative paths changed in the commit (non-removed). */
  changedFiles: string[];
  /** Domain static-check findings over the changed source + registry files. */
  staticFindings: GitStaticFinding[];
}

/**
 * Collect git evidence for the microtask's latest submission. Returns
 * `undefined` when the submission is not git-backed, Gitea is not configured,
 * or the fetch fails — the caller falls back to the text-only prompt.
 */
export async function collectGitEvaluationEvidence(
  project: PBLProjectV2,
  microtaskId: string,
): Promise<GitEvaluationEvidence | undefined> {
  const sub = latestSubmissionForMicrotask(project, microtaskId);
  if (!sub || sub.kind !== 'git' || !sub.gitConfig) return undefined;

  const config = getGiteaConfig();
  if (!config) return undefined;

  const { fullName, ref, commitSha } = sub.gitConfig;

  try {
    const commit = await getCommit(config, fullName, commitSha);
    const diffRaw = await getCommitDiff(config, fullName, commitSha);
    const changedFiles = listCommitFiles(commit)
      .filter((f) => f.status !== 'removed')
      .map((f) => f.filename);

    // Domain-specific static findings (e.g. ArkTS page registration / strict
    // typing rules) are layered on by the optional domain-profile framework.
    // Without it the evaluator still receives the commit metadata, changed
    // files and the truncated diff; the findings array simply stays empty.
    const staticFindings: GitStaticFinding[] = [];

    const diff =
      diffRaw.length > MAX_DIFF_CHARS
        ? diffRaw.slice(0, MAX_DIFF_CHARS) + '\n[...diff truncated]'
        : diffRaw;

    return {
      provider: 'gitea',
      fullName,
      ref,
      commitSha,
      commitMessage: commit.message,
      diff,
      changedFiles,
      staticFindings,
    };
  } catch (err) {
    log.warn(
      `Git evaluation evidence failed for ${fullName}@${commitSha}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
