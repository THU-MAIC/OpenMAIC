import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

// The scoring contract of the Pi orchestration evals rests on what the real
// director loop records. These tests run the real runPiDirectorLoop, buildAgent
// and agent SDK; only the model StreamFn is scripted (no network, no model).
// They pin two observation limits of the director tool trace:
//   - a call_agent attempt rejected by the tool schema is not recorded;
//   - a legacy child whose provider fails after partial text is not marked failed.

type ScriptedMessage = { content: unknown[]; stopReason: 'toolUse' | 'stop' | 'error' };

const h = vi.hoisted(() => ({
  director: [] as ScriptedMessage[],
  child: { text: 'The answer is 42.', fail: false },
  childCalls: 0,
  judgeAnswer: vi.fn(),
}));

vi.mock('@/lib/agent/runtime/stream-fn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent/runtime/stream-fn')>()),
  createCallLlmStreamFn: (opts: { source: string }) => () => {
    let scripted: ScriptedMessage;
    if (opts.source === 'pi-chat-director') {
      scripted = h.director.shift() ?? {
        content: [{ type: 'text', text: 'Done.' }],
        stopReason: 'stop',
      };
    } else {
      h.childCalls++;
      scripted = {
        content: [{ type: 'text', text: h.child.text }],
        stopReason: h.child.fail ? 'error' : 'stop',
      };
    }
    const message = {
      role: 'assistant',
      content: scripted.content,
      api: 'offline',
      provider: 'offline',
      model: 'offline',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: scripted.stopReason,
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() =>
      stream.push(
        (scripted.stopReason === 'error'
          ? {
              type: 'error',
              reason: 'error',
              error: { ...message, errorMessage: 'scripted provider failure' },
            }
          : { type: 'done', reason: scripted.stopReason, message }) as never,
      ),
    );
    return stream;
  },
}));
vi.mock('@/eval/shared/resolve-model', () => ({ resolveEvalModel: vi.fn() }));
vi.mock('@/eval/orchestration/answer-content-judge', () => ({ judgeAnswer: h.judgeAnswer }));

const answering = await import('@/eval/orchestration/answering-runner');
const content = await import('@/eval/orchestration/answer-content-runner');

const evalModel = { model: {} as LanguageModel, modelInfo: null };
const judgeModel = { id: 'judge' } as unknown as LanguageModel;

const callAgent = (args: Record<string, unknown>): ScriptedMessage => ({
  content: [{ type: 'toolCall', id: `call-${Math.random()}`, name: 'call_agent', arguments: args }],
  stopReason: 'toolUse',
});
// Missing the required `instruction`: the agent runtime rejects it before the tool runs.
const schemaRejected = callAgent({ agentId: 'teacher' });
const validTeacher = () => callAgent({ agentId: 'teacher', instruction: 'Answer the question.' });

const answeringScenario: Parameters<typeof answering.sampleScenario>[0] = {
  case_id: 'trace-contract',
  description: '',
  agents: [
    { id: 'teacher', name: 'Teacher', role: 'teacher', priority: 10 },
    { id: 'peer', name: 'Peer', role: 'student', priority: 4 },
  ],
  teacherAgentId: 'teacher',
  messages: [{ role: 'user', content: '[You]: What is 6 × 7?' }],
  agentResponses: [],
  turnCount: 0,
};

const contentScenario: Parameters<typeof content.sampleScenario>[0] = {
  case_id: 'trace-contract',
  category: 'control',
  description: '',
  agents: [
    { id: 'teacher', name: 'Teacher', role: 'teacher', priority: 10, persona: 'Answers directly.' },
    { id: 'peer', name: 'Peer', role: 'student', priority: 4, persona: 'Asks questions.' },
  ],
  teacherAgentId: 'teacher',
  turns: [{ role: 'user', text: 'What is 6 × 7?' }],
  answerKey: 'States 42.',
};

beforeEach(() => {
  h.director = [];
  h.child = { text: 'The answer is 42.', fail: false };
  h.childCalls = 0;
  h.judgeAnswer.mockReset();
  h.judgeAnswer.mockResolvedValue({
    leads_with_answer: true,
    answered_anywhere: true,
    reason: 'ok',
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('network is forbidden in this test');
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Pi trace contract: schema-rejected call_agent attempts are not recorded', () => {
  it('lets a later recorded teacher attempt classify and be judged', async () => {
    h.director = [schemaRejected, validTeacher()];
    const [sample] = await answering.sampleScenario(answeringScenario, evalModel, 1);
    expect(sample).toEqual({ classification: 'TEACHER', rawAgentId: 'teacher' });
    expect(answering.computeRates([sample]).correctRate).toBe(1);

    h.director = [schemaRejected, validTeacher()];
    const [judged] = await content.sampleScenario(contentScenario, evalModel, judgeModel, 1);
    expect(judged.noReply).toBeUndefined();
    expect(h.judgeAnswer).toHaveBeenCalledOnce();
    expect(h.judgeAnswer.mock.calls[0][4]).toBe('The answer is 42.');
  });

  it('is NO_DISPATCH when no recorded attempt follows the rejected one', async () => {
    h.director = [schemaRejected];
    const [sample] = await answering.sampleScenario(answeringScenario, evalModel, 1);

    expect(sample).toEqual({ classification: 'NO_DISPATCH', rawAgentId: null });
    expect(h.childCalls).toBe(0);
  });
});

describe('Pi trace contract: legacy child provider failures are not exposed', () => {
  it('judges the partial text of a teacher child whose provider failed', async () => {
    h.child = { text: 'The answer is', fail: true };
    h.director = [validTeacher()];
    const [sample] = await content.sampleScenario(contentScenario, evalModel, judgeModel, 1);

    expect(h.childCalls).toBe(1);
    expect(sample.noReply).toBeUndefined();
    expect(sample.error).toBeUndefined();
    expect(h.judgeAnswer).toHaveBeenCalledOnce();
    expect(h.judgeAnswer.mock.calls[0][3]).toBe('The answer is');
    expect(h.judgeAnswer.mock.calls[0][4]).toBe('The answer is');

    // The routing classification is unaffected and carries no failure note.
    h.director = [validTeacher()];
    const [routed] = await answering.sampleScenario(answeringScenario, evalModel, 1);
    expect(routed).toEqual({ classification: 'TEACHER', rawAgentId: 'teacher' });
  });
});
