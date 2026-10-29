import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const calls = vi.hoisted(() => ({ llm: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: calls.llm }));
vi.mock('@/lib/server/model-config/runtime', () => ({
  backgroundWorkspaceId: async () => 'workspace',
  assertWorkspaceModelsAuthorized: async () => {},
  lookupSlot: async () => ({ status: 'assigned' }),
}));
vi.mock('@/lib/server/model-config/llm', () => ({
  slotLanguageModel: async () => ({ model: 'assigned-model', serverManaged: true }),
}));
import { analyzeLearningReport } from '@/lib/server/pbl-v3/report-analysis';
import type { LearningReport } from '@/lib/pbl/v3/report';
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
  conversations: [],
};
const text = JSON.stringify({
  findings: [
    {
      category: 'journey',
      title: 'Tested the project',
      detail: 'The saved test passed.',
      evidence: ['event:1'],
    },
  ],
});
beforeEach(() => calls.llm.mockReset());
it('requests thinking off without a small shared output budget that can truncate the report JSON', async () => {
  calls.llm.mockResolvedValue({ text, finishReason: 'stop' });
  const analysis = await analyzeLearningReport('owner', report, new AbortController().signal);
  expect(analysis.findings).toHaveLength(1);
  expect(calls.llm.mock.calls[0]![0]).not.toHaveProperty('maxOutputTokens');
  expect(calls.llm.mock.calls[0]![3]).toEqual({ mode: 'disabled' });
  expect(analysis.omitted).toBe(false);
});
it('marks supported partial output as incomplete if the provider exhausts its physical output window', async () => {
  calls.llm.mockResolvedValue({ text, finishReason: 'length' });
  const analysis = await analyzeLearningReport('owner', report, new AbortController().signal);
  expect(analysis.findings).toHaveLength(1);
  expect(analysis.omitted).toBe(true);
});
