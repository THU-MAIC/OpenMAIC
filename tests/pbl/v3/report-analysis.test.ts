import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  reportAnalysisInput,
  reportSources,
  validateReportFindings,
} from '@/lib/server/pbl-v3/report-analysis';
import { reportConversationMessages, type LearningReport } from '@/lib/pbl/v3/report';

const report: LearningReport = {
  studyId: 'study',
  project: { id: 'project', version: '1', title: 'Project' },
  revision: 1,
  requiredComplete: true,
  milestones: [],
  outcomes: [],
  counts: {},
  truncated: false,
  evidence: [{ sequence: 1, at: 1, kind: 'evaluation.recorded', detail: 'passed' }],
  conversations: [
    {
      role: 'coder',
      milestone: 'one',
      truncated: false,
      messages: [
        {
          sequence: 2,
          at: 2,
          role: 'user',
          text: 'I changed the loop to preserve the earlier greeting.',
        },
        {
          sequence: 3,
          at: 3,
          role: 'assistant',
          text: 'The implementation preserves the greeting.',
        },
      ],
    },
  ],
};
const finding = {
  category: 'change',
  title: 'Preserving earlier behavior',
  detail: 'The learner explained their correction.',
  evidence: ['turn:0:2'],
  quote: 'changed the loop',
};

describe('grounded report analysis', () => {
  it('shares chronological conversation order with the UI and interleaves analysis sources without changing citations', () => {
    const mixed: LearningReport = {
      ...report,
      evidence: [
        { sequence: 7, at: 7, kind: 'evaluation.recorded', detail: 'passed' },
        { sequence: -4, at: 4, kind: 'file-edit', detail: 'The correction' },
      ],
      conversations: [
        {
          role: 'mentor',
          milestone: 'project',
          truncated: false,
          messages: [
            { sequence: 1, at: 1, role: 'assistant', text: 'Welcome' },
            { sequence: 2, at: 8, role: 'assistant', text: 'Final reflection' },
          ],
        },
        {
          role: 'coder',
          milestone: 'two',
          truncated: false,
          messages: [
            { sequence: 1, at: 5, role: 'user', text: 'I changed the loop' },
            { sequence: 2, at: 6, role: 'assistant', text: 'Review the correction' },
          ],
        },
        {
          role: 'planner',
          milestone: 'one',
          truncated: false,
          messages: [
            { sequence: 1, at: 2, role: 'user', text: 'My plan' },
            { sequence: 2, at: 3, role: 'assistant', text: 'Review the plan' },
          ],
        },
      ],
    };
    const before = structuredClone(mixed);
    expect(reportConversationMessages(mixed).map((m) => m.id)).toEqual([
      'turn:0:1',
      'turn:2:1',
      'turn:2:2',
      'turn:1:1',
      'turn:1:2',
      'turn:0:2',
    ]);
    const input = reportAnalysisInput(mixed);
    expect(input.records.map((r) => r.at)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(reportSources(mixed).map((r) => r.id)).toContain('event:-4');
    expect(
      validateReportFindings(
        JSON.stringify({ findings: [{ ...finding, evidence: ['turn:1:1'] }] }),
        mixed,
      ),
    ).toHaveLength(1);
    expect(mixed).toEqual(before);
  });
  it('accepts a finding with a real learner quote and rejects invented references or quotes', () => {
    expect(validateReportFindings(JSON.stringify({ findings: [finding] }), report)).toEqual([
      finding,
    ]);
    for (const invalid of [
      { ...finding, evidence: ['turn:0:999'] },
      { ...finding, quote: 'I completely mastered programming' },
      { ...finding, evidence: ['turn:0:3'], quote: 'preserves the greeting' },
      { ...finding, quote: undefined },
    ])
      expect(() => validateReportFindings(JSON.stringify({ findings: [invalid] }), report)).toThrow(
        'No supported',
      );
  });
  it('bounds analysis across the journey while retaining full stored records and reporting omissions', () => {
    const large = {
      ...report,
      evidence: Array.from({ length: 2000 }, (_, i) => ({
        sequence: i,
        at: i,
        kind: 'artifact',
        detail: `record ${i} ` + 'x'.repeat(1000),
      })),
    };
    const input = reportAnalysisInput(large);
    expect(input.records).toHaveLength(1000);
    expect(input.records[0]?.id).toBe('event:0');
    expect(input.records.at(-1)?.id).toBe('event:1999');
    expect(input.omitted).toBe(true);
    expect(large.evidence[0]?.detail.length).toBeGreaterThan(1000);
    expect(input.records.reduce((n, r) => n + r.text.length, 0)).toBeLessThanOrEqual(60_000);
  });

  it('accepts literal decision answers/reasons as learner evidence but rejects course prose and agent text', () => {
    const decisions: LearningReport = {
      ...report,
      evidence: [
        {
          sequence: 9,
          at: 9,
          kind: 'decision.recorded',
          detail: 'Course question and option label',
          learnerText: {
            answer: 'I check the requested position.',
            rationale: 'Keep unrelated items unchanged.',
          },
        },
      ],
    };
    for (const quote of ['check the requested position', 'Keep unrelated items unchanged'])
      expect(
        validateReportFindings(
          JSON.stringify({ findings: [{ ...finding, evidence: ['event:9'], quote }] }),
          decisions,
        ),
      ).toHaveLength(1);
    for (const quote of ['Course question', 'option label', 'preserves the greeting'])
      expect(() =>
        validateReportFindings(
          JSON.stringify({ findings: [{ ...finding, evidence: ['event:9'], quote }] }),
          decisions,
        ),
      ).toThrow('No supported');
    const legacy = {
      ...decisions,
      evidence: decisions.evidence.map(({ learnerText: _, ...e }) => e),
    };
    expect(() =>
      validateReportFindings(
        JSON.stringify({
          findings: [{ ...finding, evidence: ['event:9'], quote: 'Course question' }],
        }),
        legacy,
      ),
    ).toThrow('No supported');
  });

  it('retains both long answer and rationale excerpts and prioritizes learner sources over generated records', () => {
    const large: LearningReport = {
      ...report,
      evidence: [
        {
          sequence: 8,
          at: 0,
          kind: 'decision.recorded',
          detail: 'question',
          learnerText: {
            answer: 'ANSWER ' + 'a'.repeat(4000),
            rationale: 'REASON ' + 'b'.repeat(4000),
          },
        },
        ...Array.from({ length: 1500 }, (_, i) => ({
          sequence: i + 10,
          at: i + 10,
          kind: 'artifact',
          detail: 'Agent action',
        })),
      ],
    };
    const input = reportAnalysisInput(large);
    expect(input.records).toHaveLength(1000);
    const decision = input.records.find((r) => r.id === 'event:8')!;
    expect(decision.text).toContain('ANSWER');
    expect(decision.text).toContain('REASON');
    expect(input.records.some((r) => r.id === 'turn:0:2')).toBe(true);
    expect(input.records.reduce((n, r) => n + r.text.length, 0)).toBeLessThanOrEqual(60_000);
    expect(input.omitted).toBe(true);
    expect(large.evidence[0]!.learnerText!.answer.length).toBeGreaterThan(4000);
  });
});
