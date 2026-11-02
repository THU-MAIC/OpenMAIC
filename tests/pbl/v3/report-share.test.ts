import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: vi.fn() }));
vi.mock('@/lib/server/model-config/runtime', () => ({}));
vi.mock('@/lib/server/model-config/llm', () => ({}));
import type { LearningReport } from '@/lib/pbl/v3/report';
import { reportShareContent, reportShareCampaign } from '@/lib/pbl/v3/report-share';
import { validateReportFindings } from '@/lib/server/pbl-v3/report-analysis';
import { ellipsizeShareText, wrapShareText } from '@/lib/pbl/v3/report-share-text';
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
  expect(ready.highlights).toEqual(['completed']);
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
  expect(failed.highlights).toEqual(['completed']);
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
  expect(content.highlights).toEqual(['completed']);
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

it('never exports private titles accepted by the real report validator, including other chat excerpts', () => {
  const privateText = 'My personal draft lives at https://private.example/workspace/token';
  const otherExcerpt = 'This other learner excerpt must stay private';
  const withSources = {
    ...report,
    evidence: [],
    conversations: [
      {
        role: 'mentor',
        milestone: 'one',
        truncated: false,
        messages: [
          { sequence: 1, at: 1, role: 'user' as const, text: `${privateText}. ${otherExcerpt}` },
        ],
      },
    ],
  };
  const findings = validateReportFindings(
    JSON.stringify({
      findings: [
        {
          category: 'journey',
          title: privateText,
          detail: 'Private analysis.',
          evidence: ['turn:0:1'],
        },
        {
          category: 'strength',
          title: otherExcerpt,
          detail: 'Private analysis.',
          evidence: ['turn:0:1'],
          quote: privateText,
        },
      ],
    }),
    withSources,
  );
  expect(findings).toHaveLength(2);
  const exported = reportShareContent({
    ...withSources,
    analysis: { status: 'ready', findings, omitted: false, canRetry: false },
  });
  expect(JSON.stringify(exported)).not.toMatch(
    /personal draft|private\.example|token|Private analysis|other learner excerpt/,
  );
  expect(exported.highlights).toEqual(['completed']);
});

it('conditions public conclusions on recorded review and outcomes, never mastery or assumed success', () => {
  const supported = {
    ...report,
    summary: { ...report.summary!, skills: [{ id: 'planReview' as const, milestoneIds: ['one'] }] },
    outcomes: [{ milestoneId: 'one', tests: 'passed', quiz: null, reflected: false }],
  };
  expect(reportShareContent(supported).highlights).toEqual(['reviewed', 'verified']);
  expect(
    reportShareContent({ ...supported, outcomes: [{ ...supported.outcomes[0], tests: 'failed' }] })
      .highlights,
  ).toEqual(['reviewed', 'completed']);
  expect(
    reportShareContent({ ...report, summary: undefined, outcomes: undefined }).highlights,
  ).toEqual([]);
});

it('wraps normal words intact, while allowing long CJK and tokens to wrap', () => {
  const measure = (value: string) => value.length;
  expect(wrapShareText('Making engineering decisions', 18, measure)).toEqual([
    'Making engineering',
    'decisions',
  ]);
  expect(wrapShareText('一个很长的中文标题', 4, measure)).toEqual(['一个很长', '的中文标', '题']);
  expect(wrapShareText('abcdefghijkl', 5, measure)).toEqual(['abcde', 'fghij', 'kl']);
});

it('never splits combined emoji when wrapping or truncating', () => {
  const measure = (value: string) => Array.from(value).length;
  expect(wrapShareText('AA1️⃣BB❤️CC', 4, measure)).toEqual(['AA', '1️⃣B', 'B❤️C', 'C']);
  expect(ellipsizeShareText('A1️⃣❤️', 5, measure)).toBe('A1️⃣…');
});
