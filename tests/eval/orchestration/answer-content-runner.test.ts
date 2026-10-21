import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import type { DirectorToolTraceEntry } from '@/lib/chat/pi/types';
import type { StatelessEvent } from '@/lib/types/chat';

const h = vi.hoisted(() => ({
  runPiDirectorLoop: vi.fn(),
  judgeAnswer: vi.fn(),
}));

vi.mock('@/lib/chat/pi/director-loop', () => ({ runPiDirectorLoop: h.runPiDirectorLoop }));
vi.mock('@/eval/shared/resolve-model', () => ({ resolveEvalModel: vi.fn() }));
vi.mock('@/eval/orchestration/answer-content-judge', () => ({ judgeAnswer: h.judgeAnswer }));

const { aggregate, buildRequest, firstTeacherReply, sampleScenario } =
  await import('@/eval/orchestration/answer-content-runner');
type Scenario = Parameters<typeof buildRequest>[0];
type Done = Parameters<typeof firstTeacherReply>[0];

const evalModel = { model: {} as LanguageModel, modelInfo: null };
const judgeModel = { id: 'judge' } as unknown as LanguageModel;

// A real fixture: its scene, stage, agents and turns must reach the request.
const scenario = (
  JSON.parse(
    readFileSync(join(process.cwd(), 'eval/orchestration/scenarios/answer-content.json'), 'utf-8'),
  ) as Scenario[]
)[0];
const teacher = scenario.teacherAgentId;
const peer = scenario.agents.find((a) => a.id !== teacher)!.id;

let seq = 0;
const call = (agentId: string, text: string, extra: Partial<DirectorToolTraceEntry> = {}) =>
  ({
    sequence: ++seq,
    toolName: 'call_agent',
    args: { agentId, instruction: 'answer' },
    isError: false,
    // The trace preview is truncated; the judged text must come from details.
    resultPreview: `${agentId}: ${text.slice(0, 5)}`,
    details: { agentId, text },
    ...extra,
  }) as DirectorToolTraceEntry;
const doneWith = (...trace: DirectorToolTraceEntry[]): Done => ({
  totalActions: 0,
  totalAgents: trace.length,
  directorToolTrace: trace,
});

function respond(...dones: Done[]) {
  for (const done of dones) {
    h.runPiDirectorLoop.mockImplementationOnce(
      async (opts: { send: (e: StatelessEvent) => Promise<void> }) => {
        await opts.send({ type: 'done', data: done });
      },
    );
  }
}

beforeEach(() => {
  seq = 0;
  h.runPiDirectorLoop.mockReset();
  h.judgeAnswer.mockReset();
  h.judgeAnswer.mockResolvedValue({
    leads_with_answer: true,
    answered_anywhere: true,
    reason: 'ok',
  });
});

describe('answer-content: request from the scenario', () => {
  it('sends the classroom scene without preloading it into the history', () => {
    const req = buildRequest(scenario);

    expect(req.storeState.scenes).toEqual([scenario.scene]);
    expect(req.storeState.currentSceneId).toBe((scenario.scene as { id: string }).id);
    expect(req.storeState.stage).toEqual(scenario.stage);
    expect(req.userProfile).toEqual(scenario.userProfile);
    expect(req.config.agentConfigs?.map((a) => [a.id, a.persona])).toEqual(
      scenario.agents.map((a) => [a.id, a.persona]),
    );
    expect(req.messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual(
      scenario.turns.map((t) => t.text),
    );
  });
});

describe('answer-content: the judged reply', () => {
  it('takes the full text of the first teacher call, not peers or later teacher calls', () => {
    const reply = firstTeacherReply(
      doneWith(
        call(peer, 'Peer says hi.'),
        call(teacher, 'x = -b/(2a). Here is why.'),
        call(teacher, 'Later.'),
      ),
      teacher,
    );
    expect(reply).toEqual({ text: 'x = -b/(2a). Here is why.' });
  });

  it('reports why there is no reply instead of falling back to a later call', () => {
    expect(
      firstTeacherReply(
        doneWith(
          call(teacher, '', { details: { skipped: true, reason: 'agent_turn_limit' } }),
          call(teacher, 'Later.'),
        ),
        teacher,
      ),
    ).toEqual({ noReply: 'first teacher call skipped: agent_turn_limit' });
    expect(
      firstTeacherReply(doneWith(call(teacher, 'Partial', { isError: true })), teacher),
    ).toEqual({
      noReply: 'first teacher call failed',
    });
    expect(firstTeacherReply(doneWith(call(teacher, '   ')), teacher)).toEqual({
      noReply: 'first teacher call produced no text',
    });
    expect(firstTeacherReply(doneWith(call(peer, 'Only the peer.')), teacher)).toEqual({
      noReply: 'director never called the teacher',
    });
  });
});

describe('answer-content: sampling and aggregation', () => {
  it('judges the first two sentences and the full teacher reply', async () => {
    respond(doneWith(call(teacher, 'The formula is x = -b/(2a). It comes from the vertex. More.')));
    const [sample] = await sampleScenario(scenario, evalModel, judgeModel, 1);

    expect(h.judgeAnswer).toHaveBeenCalledWith(
      judgeModel,
      scenario.turns.at(-1)!.text,
      scenario.answerKey,
      'The formula is x = -b/(2a). It comes from the vertex.',
      'The formula is x = -b/(2a). It comes from the vertex. More.',
    );
    expect(sample.verdict.leads_with_answer).toBe(true);
  });

  it('scores a missing reply, a run error and a judge error as 0 out of all samples', async () => {
    respond(doneWith(call(teacher, 'Answer.')), doneWith(call(peer, 'Peer only.')));
    h.runPiDirectorLoop.mockRejectedValueOnce(new Error('provider failed'));
    respond(doneWith(call(teacher, 'Answer.')));
    h.judgeAnswer
      .mockResolvedValueOnce({ leads_with_answer: true, answered_anywhere: true, reason: 'ok' })
      .mockResolvedValueOnce({
        leads_with_answer: false,
        answered_anywhere: false,
        reason: 'unparsable',
        error: true,
      });

    const samples = await sampleScenario(scenario, evalModel, judgeModel, 4);

    expect(h.judgeAnswer).toHaveBeenCalledTimes(2);
    expect(samples[1]).toMatchObject({ noReply: 'director never called the teacher' });
    expect(samples[1].error).toBeUndefined();
    expect(samples[2]).toMatchObject({ error: 'provider failed' });
    expect(samples[3].verdict.error).toBe(true);
    const agg = aggregate(samples);
    expect(agg.leadsRate).toBe(0.25);
    expect(agg.answeredRate).toBe(0.25);
  });
});
