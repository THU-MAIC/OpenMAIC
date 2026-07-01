/**
 * Tests for the submission helpers.
 *
 * Targets the v2-specific behaviours of submission storage and the
 * summarize-for-evaluator helper added in PR 6.1.
 */
import { describe, expect, it } from 'vitest';
import {
  addSubmission,
  latestSubmissionForMicrotask,
  listSubmissionsForMicrotask,
  summarizeLatestSubmissionForMicrotask,
  summarizeSubmissionsForMicrotask,
} from '@/lib/pbl/v2/operations/submission';
import { buildRevisionGuidanceMessage } from '@/components/scene-renderers/pbl/v2/submission';
import type { PBLEvaluation, PBLProjectV2 } from '@/lib/pbl/v2/types';

function mkProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 't',
    description: 'd',
    proficiency: 'intermediate',
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

describe('addSubmission', () => {
  it('appends with id, microtaskId, kind, content, timestamp', () => {
    const p = mkProject();
    const sub = addSubmission(p, {
      microtaskId: 't1',
      kind: 'text',
      content: 'hello',
    });
    expect(sub.id).toMatch(/^sub_/);
    expect(sub.microtaskId).toBe('t1');
    expect(sub.kind).toBe('text');
    expect(p.submissions).toHaveLength(1);
    expect(p.submissions[0]).toBe(sub);
    expect(p.updatedAt).toBe(sub.createdAt);
  });

  it('preserves filename + mimeType for file kind', () => {
    const p = mkProject();
    const sub = addSubmission(p, {
      microtaskId: 't1',
      kind: 'file',
      content: 'def x(): pass',
      filename: 'x.py',
      mimeType: 'text/x-python',
    });
    expect(sub.filename).toBe('x.py');
    expect(sub.mimeType).toBe('text/x-python');
  });
});

describe('listSubmissionsForMicrotask', () => {
  it('filters by microtaskId', () => {
    const p = mkProject();
    addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'a' });
    addSubmission(p, { microtaskId: 't2', kind: 'text', content: 'b' });
    addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'c' });
    const subs = listSubmissionsForMicrotask(p, 't1');
    expect(subs.map((s) => s.content)).toEqual(['a', 'c']);
  });

  it('returns empty array when none exist', () => {
    expect(listSubmissionsForMicrotask(mkProject(), 'nope')).toEqual([]);
  });
});

describe('latestSubmissionForMicrotask', () => {
  it('returns the newest submission for a microtask', () => {
    const p = mkProject();
    const older = addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'older wrong' });
    const newer = addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'newer correct' });
    older.createdAt = '2026-05-30T00:00:00.000Z';
    newer.createdAt = '2026-05-30T00:01:00.000Z';

    expect(latestSubmissionForMicrotask(p, 't1')).toBe(newer);
  });
});

describe('summarizeLatestSubmissionForMicrotask', () => {
  it('includes only the latest submission content', () => {
    const p = mkProject();
    const older = addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'older wrong' });
    const newer = addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'newer correct' });
    older.createdAt = '2026-05-30T00:00:00.000Z';
    newer.createdAt = '2026-05-30T00:01:00.000Z';

    const out = summarizeLatestSubmissionForMicrotask(p, 't1');
    expect(out).toContain('Latest submission');
    expect(out).toContain('newer correct');
    expect(out).not.toContain('older wrong');
  });
});

describe('summarizeSubmissionsForMicrotask', () => {
  it('returns empty string when no submissions exist (lets eval-prompts skip the section)', () => {
    expect(summarizeSubmissionsForMicrotask(mkProject(), 'nope')).toBe('');
  });

  it('produces a per-submission header with kind, filename, and timestamp', () => {
    const p = mkProject();
    addSubmission(p, {
      microtaskId: 't1',
      kind: 'file',
      content: 'print("hi")',
      filename: 'hello.py',
    });
    const out = summarizeSubmissionsForMicrotask(p, 't1');
    expect(out).toContain('Submission 1');
    expect(out).toContain('file');
    expect(out).toContain('hello.py');
    expect(out).toContain('print("hi")');
  });

  it('truncates when content exceeds the char budget with a clear marker', () => {
    const p = mkProject();
    const big = 'x'.repeat(8000);
    addSubmission(p, { microtaskId: 't1', kind: 'text', content: big });
    const out = summarizeSubmissionsForMicrotask(p, 't1', 200);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('[...older submissions truncated]');
  });

  it('numbers multiple submissions and truncates clean at boundary', () => {
    const p = mkProject();
    addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'first' });
    addSubmission(p, { microtaskId: 't1', kind: 'text', content: 'second' });
    const out = summarizeSubmissionsForMicrotask(p, 't1');
    expect(out).toContain('Submission 1');
    expect(out).toContain('first');
    expect(out).toContain('Submission 2');
    expect(out).toContain('second');
  });
});

describe('buildRevisionGuidanceMessage', () => {
  const evaluation: PBLEvaluation = {
    id: 'ev-1',
    kind: 'task',
    microtaskId: 't1',
    feedback: 'needs work',
    strengths: [],
    improvements: ['补上 remove_item(item) 调用', '退出时使用 break'],
    score: 45,
    createdAt: '2026-05-30T00:00:00.000Z',
  };

  it('uses the first-revision wording on the first failed task evaluation', () => {
    const msg = buildRevisionGuidanceMessage({
      evaluation,
      instructorId: 'role-i',
      microtaskId: 't1',
      language: 'zh-CN',
      revisionAttempt: 1,
    });

    expect(msg?.content).toContain('这版先别急着往下走');
  });

  it('varies the opening after repeated failed task evaluations', () => {
    const msg = buildRevisionGuidanceMessage({
      evaluation,
      instructorId: 'role-i',
      microtaskId: 't1',
      language: 'zh-CN',
      revisionAttempt: 2,
    });

    expect(msg?.content).toContain('这次还需要再补一轮');
    expect(msg?.content).not.toContain('这版先别急着往下走');
  });
});
