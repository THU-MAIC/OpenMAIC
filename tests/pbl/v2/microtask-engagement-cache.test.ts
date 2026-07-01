/**
 * Tests for the engagement-cache lifeline added in PR 6.1.
 *
 * Why this exists: `project.engagementEvents` is a ring buffer with a
 * 500-entry cap (engagement.ts:MAX_EVENTS). A long project can roll
 * its early task events off the back, leaving the milestone evaluator
 * with no telemetry to feed the LLM — which is what makes the
 * evaluation "specific" instead of generic.
 *
 * The PR 6.1 fix: cache the summary onto `microtask.engagement` at
 * the moment the task completes (or is skipped), so the evaluator
 * always has data. These tests pin the cache behaviour.
 */
import { describe, expect, it } from 'vitest';
import { advanceMicrotask } from '@/lib/pbl/v2/operations/progress';
import { recordEvent } from '@/lib/pbl/v2/operations/engagement';
import type { PBLMicrotask, PBLMilestone, PBLProjectV2 } from '@/lib/pbl/v2/types';

function mkTask(id: string, status: PBLMicrotask['status'] = 'in_progress'): PBLMicrotask {
  return {
    id,
    title: `t-${id}`,
    description: '',
    status,
    assignee: 'user',
    hints: [],
    order: 0,
  };
}

function mkMilestone(
  id: string,
  tasks: PBLMicrotask[],
  status: PBLMilestone['status'] = 'active',
): PBLMilestone {
  return {
    id,
    title: `m-${id}`,
    description: '',
    status,
    order: 0,
    microtasks: tasks,
    documents: [],
  };
}

function mkProject(milestones: PBLMilestone[]): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'p',
    description: '',
    proficiency: 'intermediate',
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones,
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: 'ts',
    updatedAt: 'ts',
  };
}

describe('microtask.engagement cache (PR 6.1)', () => {
  it('advanceMicrotask freezes the engagement summary onto microtask.engagement', () => {
    const t = mkTask('t1');
    const ms = mkMilestone('ms1', [t]);
    const project = mkProject([ms]);
    // Seed some events as if the learner did the task
    recordEvent(project, 'microtask_opened', {
      microtaskId: 't1',
      milestoneId: 'ms1',
    });
    recordEvent(project, 'learner_turn', { microtaskId: 't1' });
    recordEvent(project, 'learner_turn', { microtaskId: 't1' });
    recordEvent(project, 'observation_concept_unlocked', {
      microtaskId: 't1',
      payload: { signature: 'put_basic' },
    });
    expect(t.engagement).toBeUndefined();

    const result = advanceMicrotask(project, 't1', 'done', {
      performance: 'good',
    });
    expect(result.ok).toBe(true);
    expect(t.engagement).toBeDefined();
    expect(t.engagement!.learnerTurnCount).toBe(2);
    expect(t.engagement!.conceptsUnlocked).toContain('put_basic');
  });

  it('caches the human-readable concept label from the observation payload', () => {
    // The end-of-project report shows `label` (in the learner's language), not
    // the machine `signature`. The label must survive into the cached summary
    // so the report stays readable even after the event ledger rolls over.
    const t = mkTask('t1');
    const ms = mkMilestone('ms1', [t]);
    const project = mkProject([ms]);
    recordEvent(project, 'microtask_opened', { microtaskId: 't1', milestoneId: 'ms1' });
    recordEvent(project, 'observation_concept_unlocked', {
      microtaskId: 't1',
      payload: { signature: 'set_dedup', label: '为什么 set 能自动去重' },
    });
    advanceMicrotask(project, 't1', 'done', { performance: 'good' });
    expect(t.engagement!.conceptUnlockLabels).toEqual({ set_dedup: '为什么 set 能自动去重' });

    // Survives ledger trim — the cached summary holds the label.
    project.engagementEvents.splice(0);
    expect(t.engagement!.conceptUnlockLabels?.set_dedup).toBe('为什么 set 能自动去重');
  });

  it('cached summary includes durationSeconds (microtask_completed event must be recorded BEFORE caching)', () => {
    const t = mkTask('t1');
    const ms = mkMilestone('ms1', [t]);
    const project = mkProject([ms]);
    // Use explicit timestamps so we can assert duration math.
    project.engagementEvents.push({
      id: 'e1',
      kind: 'microtask_opened',
      microtaskId: 't1',
      milestoneId: 'ms1',
      ts: '2026-01-01T00:00:00.000Z',
    });
    advanceMicrotask(project, 't1', 'done', { performance: 'ok' });
    // microtask_completed event was recorded by advanceMicrotask; the
    // cache then ran microtaskEngagement which uses BOTH events to
    // compute duration. The exact value depends on wall clock, but we
    // can assert that durationSeconds was set (not undefined).
    expect(t.engagement!.completedAt).toBeDefined();
    expect(typeof t.engagement!.durationSeconds).toBe('number');
  });

  it('cache survives even if the ledger is later trimmed (overflow scenario)', () => {
    const t = mkTask('t1');
    const ms = mkMilestone('ms1', [t]);
    const project = mkProject([ms]);
    recordEvent(project, 'microtask_opened', { microtaskId: 't1' });
    recordEvent(project, 'observation_concept_unlocked', {
      microtaskId: 't1',
      payload: { signature: 'iter_entries' },
    });
    advanceMicrotask(project, 't1', 'done', { performance: 'ok' });
    // Simulate ledger overflow: blow away every event so the live
    // recomputation would return nothing. The cache should still hold.
    project.engagementEvents.splice(0);
    expect(t.engagement!.conceptsUnlocked).toContain('iter_entries');
  });
});
