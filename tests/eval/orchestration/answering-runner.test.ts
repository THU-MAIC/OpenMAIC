import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import type { DirectorToolTraceEntry } from '@/lib/chat/pi/types';
import type { StatelessEvent } from '@/lib/types/chat';

const h = vi.hoisted(() => ({
  runPiDirectorLoop: vi.fn(),
}));

vi.mock('@/lib/chat/pi/director-loop', () => ({ runPiDirectorLoop: h.runPiDirectorLoop }));
vi.mock('@/eval/shared/resolve-model', () => ({ resolveEvalModel: vi.fn() }));

const { buildRequest, computeRates, sampleScenario } =
  await import('@/eval/orchestration/answering-runner');
type Scenario = Parameters<typeof buildRequest>[0];

const evalModel = { model: {} as LanguageModel, modelInfo: null };

const scenario: Scenario = {
  case_id: 'case',
  description: '',
  agents: [
    { id: 'default-1', name: '李老师', role: 'teacher', priority: 10 },
    { id: 'default-2', name: '助教', role: 'assistant', priority: 7 },
  ],
  teacherAgentId: 'default-1',
  messages: [
    { role: 'user', content: '[你]: 对称轴公式是什么?' },
    { role: 'assistant', content: '[{"type":"text","content":"对称轴是竖直线。"}]' },
  ],
  agentResponses: [
    {
      agentId: 'default-1',
      agentName: '李老师',
      contentPreview: '对称轴是竖直线。',
      actionCount: 0,
      whiteboardActions: [],
    },
  ],
  turnCount: 1,
  whiteboardOpen: true,
};

let seq = 0;
const entry = (toolName: string, args: unknown, extra: Partial<DirectorToolTraceEntry> = {}) =>
  ({
    sequence: ++seq,
    toolName,
    args,
    isError: false,
    resultPreview: '',
    ...extra,
  }) as DirectorToolTraceEntry;
const call = (agentId: string, extra: Partial<DirectorToolTraceEntry> = {}) =>
  entry(
    'call_agent',
    { agentId, instruction: 'answer' },
    { details: { agentId, text: 'x' }, ...extra },
  );
const invalid = (agentId: string) =>
  entry(
    'call_agent',
    { agentId, instruction: 'answer' },
    {
      details: { skipped: true, reason: 'invalid_agent_id', requestedAgentId: agentId },
    },
  );

function respond(...traces: DirectorToolTraceEntry[][]) {
  for (const trace of traces) {
    h.runPiDirectorLoop.mockImplementationOnce(
      async (opts: { send: (e: StatelessEvent) => Promise<void> }) => {
        await opts.send({
          type: 'done',
          data: { totalActions: 0, totalAgents: 1, directorToolTrace: trace },
        });
      },
    );
  }
}

beforeEach(() => {
  seq = 0;
  h.runPiDirectorLoop.mockReset();
});

describe('answering: request from the scenario', () => {
  it('keeps agents, history text, prior agent responses and classroom state', () => {
    const req = buildRequest(scenario);

    expect(req.config.agentIds).toEqual(['default-1', 'default-2']);
    expect(req.config.agentConfigs?.map((a) => [a.id, a.name, a.role, a.priority])).toEqual([
      ['default-1', '李老师', 'teacher', 10],
      ['default-2', '助教', 'assistant', 7],
    ]);
    expect(req.messages.map((m) => [m.role, (m.parts[0] as { text: string }).text])).toEqual([
      ['user', '对称轴公式是什么?'],
      ['assistant', '对称轴是竖直线。'],
    ]);
    expect(req.directorState).toEqual({
      turnCount: 1,
      agentResponses: scenario.agentResponses,
      whiteboardLedger: [],
    });
    expect(req.storeState.whiteboardOpen).toBe(true);
  });
});

describe('answering: classification by the first call_agent', () => {
  it('classifies each trace shape', async () => {
    respond(
      [entry('read_scene', { sceneId: 's' }), call('default-1')],
      [call('default-2')],
      [invalid('ghost')],
      [entry('read_scene', { sceneId: 's' })],
    );
    const samples = await sampleScenario(scenario, evalModel, 4);

    expect(samples).toEqual([
      { classification: 'TEACHER', rawAgentId: 'default-1' },
      { classification: 'OTHER_AGENT', rawAgentId: 'default-2' },
      { classification: 'OTHER_AGENT', rawAgentId: 'ghost', note: 'invalid_agent_id' },
      { classification: 'NO_DISPATCH', rawAgentId: null },
    ]);
  });

  it('does not let a later successful call rescue a wrong or invalid first call', async () => {
    respond([invalid('ghost'), call('default-1')], [call('default-2'), call('default-1')]);
    const samples = await sampleScenario(scenario, evalModel, 2);

    expect(samples.map((s) => s.classification)).toEqual(['OTHER_AGENT', 'OTHER_AGENT']);
  });

  it('keeps a valid teacher dispatch as TEACHER when the teacher reply itself failed', async () => {
    respond([call('default-1', { isError: true })]);
    const [sample] = await sampleScenario(scenario, evalModel, 1);

    expect(sample).toEqual({
      classification: 'TEACHER',
      rawAgentId: 'default-1',
      note: 'agent reply failed',
    });
  });

  it('counts only a failed run as ERROR', async () => {
    h.runPiDirectorLoop
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockImplementationOnce(async () => {});
    const samples = await sampleScenario(scenario, evalModel, 2);

    expect(samples).toEqual([
      { classification: 'ERROR', rawAgentId: null, error: 'provider failed' },
      { classification: 'ERROR', rawAgentId: null, error: 'Pi run ended without a done event' },
    ]);
  });
});

describe('answering: correct rate', () => {
  it('keeps OTHER_AGENT and NO_DISPATCH in the denominator and excludes ERROR', async () => {
    respond([call('default-1')], [invalid('ghost')], [entry('read_scene', {})]);
    h.runPiDirectorLoop.mockRejectedValueOnce(new Error('provider failed'));
    const samples = await sampleScenario(scenario, evalModel, 4);

    const { rates, correctRate } = computeRates(samples);
    expect(correctRate).toBeCloseTo(1 / 3);
    expect(rates.OTHER_AGENT).toBeCloseTo(1 / 3);
    expect(rates.NO_DISPATCH).toBeCloseTo(1 / 3);
    expect(rates.ERROR).toBe(0.25);
  });

  it('gives an all-error scenario a correct rate of 0', () => {
    const { correctRate, rates } = computeRates([
      { classification: 'ERROR', rawAgentId: null, error: 'a' },
      { classification: 'ERROR', rawAgentId: null, error: 'b' },
    ]);
    expect(correctRate).toBe(0);
    expect(correctRate >= 0.7).toBe(false);
    expect(rates.ERROR).toBe(1);
  });
});
