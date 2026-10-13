/**
 * Tests for the git evaluation evidence collector (slice 4b).
 *
 * The collector is I/O glue over the Gitea client; the interesting pure logic
 * (domain static checks) is already covered by domain-static-checks.test.ts.
 * Here we pin the no-op degrade paths: a non-git submission, an unconfigured
 * Git bridge, or a git submission that isn't the latest all yield `undefined`
 * so the evaluator falls back to the text-only prompt instead of throwing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectGitEvaluationEvidence } from '@/lib/pbl/v2/operations/runtime/git-evaluation-evidence';
import { addSubmission } from '@/lib/pbl/v2/operations/runtime/submission';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function mkProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'ArkTS PBL',
    description: 'desc',
    learningObjective: 'obj',
    proficiency: 'beginner',
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: 'ts',
    updatedAt: 'ts',
  };
}

const GITEA_KEYS = [
  'GITEA_URL',
  'GITEA_TOKEN',
  'GITEA_TEMPLATE_REPO',
  'GITEA_WEBHOOK_SECRET',
] as const;

const GIT_SUB = {
  provider: 'gitea' as const,
  fullName: 'goking/arkts-pbl-template',
  ref: 'refs/heads/main',
  commitSha: '7002ba50a2a24f8824005f81f2494b7d378a07f9',
  trigger: 'pinned' as const,
};

describe('collectGitEvaluationEvidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined for a non-git submission', async () => {
    const project = mkProject();
    addSubmission(project, { microtaskId: 't1', kind: 'text', content: 'hello' });
    await expect(collectGitEvaluationEvidence(project, 't1')).resolves.toBeUndefined();
  });

  it('returns undefined when the Git bridge is not configured (hermetic env)', async () => {
    for (const key of GITEA_KEYS) vi.stubEnv(key, '');
    const project = mkProject();
    addSubmission(project, { microtaskId: 't1', kind: 'git', content: '', gitConfig: GIT_SUB });
    await expect(collectGitEvaluationEvidence(project, 't1')).resolves.toBeUndefined();
  });

  it('returns undefined when a git submission is not the latest', async () => {
    const project = mkProject();
    addSubmission(project, { microtaskId: 't1', kind: 'git', content: '', gitConfig: GIT_SUB });
    addSubmission(project, { microtaskId: 't1', kind: 'text', content: 'a later paste revision' });
    await expect(collectGitEvaluationEvidence(project, 't1')).resolves.toBeUndefined();
  });
});
