import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: vi.fn() }));
vi.mock('@/lib/server/model-config/runtime', () => ({}));
vi.mock('@/lib/server/model-config/llm', () => ({}));
import type { LearningReport } from '@/lib/pbl/v3/report';
import {
  reportShareContent,
  reportShareCampaign,
  reportShareDestination,
  reportShareDisplayUrl,
} from '@/lib/pbl/v3/report-share';
import { validateReportFindings } from '@/lib/server/pbl-v3/report-analysis';
import { ellipsizeShareText, wrapShareText } from '@/lib/pbl/v3/report-share-text';
import { projectReportSummary } from '@/lib/pbl/v3/report-summary';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
const report = {
  studyId: 'private-study',
  project: { id: 'any-project', version: '1', title: 'My project' },
  requiredComplete: true,
  milestones: [
    {
      id: 'one',
      title: 'Connect the dialogue',
      goal: 'Send a question and show the answer.',
      status: 'completed',
      decisions: [{ id: 'choice', question: 'PRIVATE QUESTION', answer: 'PRIVATE ANSWER' }],
    },
    { id: 'two', title: 'Optional next step', status: 'pending' },
  ],
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
it('projects identical facts regardless of analysis state, private findings or revision', () => {
  const facts = reportShareContent(report);
  for (const status of ['not_generated', 'generating', 'ready', 'failed'] as const) {
    const projected = reportShareContent({
      ...report,
      revision: 99,
      analysis: {
        ...report.analysis!,
        status,
        findings: [
          {
            category: 'journey',
            title: 'PRIVATE TITLE',
            detail: 'PRIVATE DETAIL',
            quote: 'PRIVATE QUOTE',
            evidence: ['private'],
          },
        ],
      },
    });
    expect(projected).toEqual(facts);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|private-study|evidence|quote/);
  }
  expect(facts.results).toEqual([
    { title: 'Connect the dialogue', description: 'Send a question and show the answer.' },
  ]);
  expect(facts.workflow).toEqual(['verification']);
  expect(facts.metrics.some(([key]) => key === 'skills')).toBe(false);
  expect(facts).not.toHaveProperty('waiting');
  expect(facts).not.toHaveProperty('highlights');
});
it('does not even read analysis while projecting the public card', () => {
  const privateReport = { ...report };
  Object.defineProperty(privateReport, 'analysis', {
    get() {
      throw new Error('Private analysis read');
    },
  });
  expect(reportShareContent(privateReport)).toEqual(reportShareContent(report));
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
  expect(content).toEqual(reportShareContent(report));
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

it('omits missing summary fields rather than inventing counts or rendering undefined values', () => {
  const content = reportShareContent({
    ...report,
    summary: { completedSteps: 3, totalSteps: 7 } as LearningReport['summary'],
  });
  expect(content.metrics).toEqual([['completedSteps', '3/7']]);
  expect(content.results[0].title).toBe('Connect the dialogue');
  expect(content.workflow).toEqual([]);
  expect(content.concepts).toEqual([]);
  expect(JSON.stringify(content)).not.toContain('undefined');
});

it('uses authored share copy for achieved milestones only', () => {
  const shareResult = { title: 'My agent can reply!', description: 'Try it from the chat page.' };
  const milestones = report.milestones.map((milestone) => ({ ...milestone, shareResult }));
  expect(reportShareContent({ ...report, milestones }).results).toEqual([shareResult]);
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
  expect(exported).toEqual(reportShareContent(withSources));
});

it('reflects changed public facts without depending on analysis or invented conclusions', () => {
  const changed = reportShareContent({
    ...report,
    requiredComplete: false,
    summary: { ...report.summary!, completedSteps: 3 },
  });
  expect(changed.completed).toBe(false);
  expect(changed.metrics).toContainEqual(['completedSteps', '3/7']);
  expect(changed).not.toEqual(reportShareContent(report));
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

it('fills the current line with CJK text after a space-separated Latin word', () => {
  const title = '用 Python 把自己的待办清单做出来学会添加事项按编号删除并验证实际操作的效果';
  const lines = wrapShareText(title, 26, (value) => value.length);
  expect(title).toHaveLength(41);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(title.slice(0, 26));
  expect(lines.join('')).toBe(title);

  // Latin words still move intact to the next line after Chinese prose.
  expect(wrapShareText('完成 Python project', 10, (value) => value.length)).toEqual([
    '完成 Python',
    'project',
  ]);
});

it('never splits combined emoji when wrapping or truncating', () => {
  const measure = (value: string) => Array.from(value).length;
  expect(wrapShareText('AA1️⃣BB❤️CC', 4, measure)).toEqual(['AA', '1️⃣B', 'B❤️C', 'C']);
  expect(ellipsizeShareText('A1️⃣❤️', 5, measure)).toBe('A1️⃣…');
});

it('uses only an explicitly configured HTTP(S) campaign destination', () => {
  expect(reportShareDestination()).toBeNull();
  expect(reportShareDestination('  https://workshop.example/intro?source=share  ')).toBe(
    'https://workshop.example/intro?source=share',
  );
  for (const value of [
    '',
    '/classroom/private-study',
    'not a URL',
    'data:text/plain,link',
    'https://token:secret@course.example/',
  ])
    expect(reportShareDestination(value)).toBeNull();
});

it('keeps printed URLs readable without decoding escapes into a different destination', () => {
  const readable = 'https://a.cn/工作坊前置课程';
  expect(reportShareDisplayUrl(new URL(readable).href)).toBe(readable);
  for (const url of [
    'https://a.cn/path%2Fpart?ref=a%26b',
    'https://a.cn/path%252Fpart',
    'https://a.cn/path%E0%A4',
    'https://a.cn/path%00part',
    'https://a.cn/a%E2%80%8Bb', // Zero-width space.
    'https://a.cn/a%E2%80%AEb', // Right-to-left override.
    'https://a.cn/a%CD%8Fb', // Combining grapheme joiner (not a Cf character).
    'https://a.cn/a%EF%B8%8Fb', // Variation selector.
    'https://a.cn/a%C2%A0b', // Non-breaking space.
    'https://a.cn/a%20b',
  ]) {
    expect(reportShareDisplayUrl(url)).toBe(url);
    expect(new URL(reportShareDisplayUrl(url)).href).toBe(url);
  }
});

it('omits empty skill/concept metrics from a real metadata-free project summary, while retaining recorded zero progress', () => {
  const project = structuredClone(
    installedProject({ id: 'greeting-python', version: '1.0.0' }).definition,
  );
  for (const milestone of project.milestones) delete milestone.teaching;
  const summary = projectReportSummary(project, startOrchestration(project).state);
  expect(summary.concepts).toEqual([]);
  expect(summary.skills).toEqual([]);
  const projected = reportShareContent({ ...report, requiredComplete: false, summary });
  expect(projected.metrics).toContainEqual(['completedMilestones', '0/1']);
  expect(projected.metrics.map(([key]) => key)).toEqual(['completedMilestones', 'completedSteps']);
});
