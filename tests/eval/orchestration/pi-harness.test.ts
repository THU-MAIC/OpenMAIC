import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import {
  getPiMaxActionsPerAgent,
  getPiMaxAgentTurns,
  resolveAgentConfigs,
} from '@/lib/chat/pi/config';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const h = vi.hoisted(() => ({
  runPiDirectorLoop: vi.fn(),
}));

vi.mock('@/lib/chat/pi/director-loop', () => ({ runPiDirectorLoop: h.runPiDirectorLoop }));

const { runPiClassroomRequest } = await import('@/eval/orchestration/pi-harness');

const model = { id: 'offline' } as unknown as LanguageModel;
const evalModel = {
  model,
  modelInfo: { outputWindow: 4096, contextWindow: 128000 },
} as unknown as Parameters<typeof runPiClassroomRequest>[1];

const done = (): StatelessEvent => ({
  type: 'done',
  data: { totalActions: 0, totalAgents: 0, directorToolTrace: [] },
});

function request(config: Partial<StatelessChatRequest['config']> = {}): StatelessChatRequest {
  return {
    messages: [],
    storeState: {
      stage: null,
      scenes: [],
      currentSceneId: null,
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: {
      agentIds: ['t1', 'default-2'],
      agentConfigs: [
        {
          id: 't1',
          name: 'Lin',
          role: 'teacher',
          persona: 'Leads with the answer.',
          avatar: '',
          color: '#000',
          allowedActions: ['spotlight'],
          priority: 10,
        },
      ],
      sessionType: 'qa',
      ...config,
    },
    apiKey: '',
  };
}

beforeEach(() => {
  h.runPiDirectorLoop.mockReset();
  h.runPiDirectorLoop.mockImplementation(
    async (opts: { send: (e: StatelessEvent) => Promise<void> }) => {
      await opts.send(done());
    },
  );
});

describe('runPiClassroomRequest', () => {
  it('runs the real director loop with the route defaults for an in-class request', async () => {
    const req = request();
    const run = await runPiClassroomRequest(req, evalModel);

    expect(h.runPiDirectorLoop).toHaveBeenCalledOnce();
    const opts = h.runPiDirectorLoop.mock.calls[0][0];
    const body = { ...req, config: { ...req.config, piEnableWhiteboardTools: true } };
    expect(opts.body).toEqual(body);
    // Agent configs and budgets come from the Pi config helpers: the scenario
    // override for t1, the registry default for default-2.
    expect(
      opts.agentConfigs.map((a: { id: string; name: string; persona: string }) => [
        a.id,
        a.name,
        a.persona,
      ]),
    ).toEqual(resolveAgentConfigs(body).map((a) => [a.id, a.name, a.persona]));
    expect(opts.agentConfigs.map((a: { id: string }) => a.id)).toEqual(['t1', 'default-2']);
    expect(opts.maxAgentTurns).toBe(getPiMaxAgentTurns(body));
    expect(opts.maxActionsPerAgent).toBe(getPiMaxActionsPerAgent(body));
    expect(opts).toMatchObject({
      languageModel: model,
      thinkingConfig: { mode: 'disabled', enabled: false },
      maxOutputTokens: 4096,
      contextWindow: 128000,
      enableWhiteboardTools: true,
      childRuntimeMode: 'legacy',
    });
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(run.done).toEqual(done().data);
  });

  it('applies per-request budgets through the same helpers', async () => {
    await runPiClassroomRequest(
      request({ piMaxAgentTurns: 2, piMaxActionsPerAgent: 99 }),
      evalModel,
    );

    const opts = h.runPiDirectorLoop.mock.calls[0][0];
    expect(opts.maxAgentTurns).toBe(2);
    expect(opts.maxActionsPerAgent).toBe(getPiMaxActionsPerAgent(opts.body));
    expect(opts.maxActionsPerAgent).toBeLessThan(99);
  });

  it('fails a run that throws, ends without done, or is aborted', async () => {
    h.runPiDirectorLoop.mockRejectedValueOnce(new Error('provider failed'));
    await expect(runPiClassroomRequest(request(), evalModel)).rejects.toThrow('provider failed');

    h.runPiDirectorLoop.mockImplementationOnce(async () => {});
    await expect(runPiClassroomRequest(request(), evalModel)).rejects.toThrow(
      'ended without a done event',
    );

    const controller = new AbortController();
    h.runPiDirectorLoop.mockImplementationOnce(async (opts: { abortSignal: AbortSignal }) => {
      controller.abort();
      expect(opts.abortSignal.aborted).toBe(true);
    });
    await expect(runPiClassroomRequest(request(), evalModel, controller.signal)).rejects.toThrow(
      'aborted',
    );
  });
});
