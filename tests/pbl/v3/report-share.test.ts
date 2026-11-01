import { expect, it } from 'vitest';
import type { LearningReport } from '@/lib/pbl/v3/report';
import { reportShareContent, reportShareCampaign } from '@/lib/pbl/v3/report-share';
const report = {
  studyId: 'private-study',
  project: { id: 'any-project', version: '1', title: 'My project' },
  requiredComplete: true,
  summary: {
    completedMilestones: 1,
    totalMilestones: 1,
    completedSteps: 7,
    totalSteps: 7,
    concepts: ['Lists'],
    skills: [{ id: 'verification', milestoneIds: ['one'] }],
  },
  conversations: [{ messages: [{ text: 'PRIVATE CHAT' }] }],
  evidence: [{ detail: 'PRIVATE EVIDENCE' }],
  analysis: { status: 'generating', findings: [], omitted: false, canRetry: false },
} as unknown as LearningReport;
it('updates an already-open poster when analysis arrives without projecting evidence or quotes', () => {
  expect(reportShareContent(report).waiting).toBe(true);
  const ready = reportShareContent({
    ...report,
    analysis: {
      ...report.analysis!,
      status: 'ready',
      findings: [
        {
          category: 'strength',
          title: 'Checked the input boundary',
          detail: 'PRIVATE DETAIL',
          evidence: ['private'],
          quote: 'PRIVATE QUOTE',
        },
      ],
    },
  });
  expect(ready.highlights).toEqual(['Checked the input boundary']);
  expect(ready.waiting).toBe(false);
  expect(JSON.stringify(ready)).not.toMatch(/PRIVATE|private-study|evidence|quote/);
  expect(ready.metrics).toContainEqual(['skills', '1']);
});
it('keeps facts but removes waiting and error content on analysis failure', () => {
  const failed = reportShareContent({
    ...report,
    analysis: { ...report.analysis!, status: 'failed' },
  });
  expect(failed.waiting).toBe(false);
  expect(failed.highlights).toEqual([]);
  expect(failed.metrics).toHaveLength(4);
  expect(JSON.stringify(failed)).not.toContain('failed');
});
it('does not invent missing counts, infer links from IDs or export learner quotations', () => {
  expect(reportShareContent({ ...report, summary: undefined }).metrics).toEqual([]);
  expect(reportShareCampaign.url).toBe('');
  const content = reportShareContent({
    ...report,
    analysis: {
      ...report.analysis!,
      status: 'ready',
      findings: [
        {
          category: 'strength',
          title: 'Learner said PRIVATE QUOTE',
          detail: '',
          evidence: [],
          quote: 'PRIVATE QUOTE',
        },
      ],
    },
  });
  expect(content.highlights).toEqual([]);
});

it('shows verification only from saved report outcomes rather than assumed completion', () => {
  const content = reportShareContent({
    ...report,
    facts: { decisions: 2 } as LearningReport['facts'],
    outcomes: [
      {
        milestoneId: 'one',
        tests: 'passed',
        quiz: { score: 4, total: 4, attempt: 1 },
        reflected: true,
      },
    ],
  });
  expect(content.verification).toEqual({
    passed: 1,
    tested: 1,
    quizScore: 4,
    quizTotal: 4,
    decisions: 2,
  });
  expect(reportShareContent(report).verification.tested).toBe(0);
});
