import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
const mocks = vi.hoisted(() => ({ streamLLM: vi.fn(), resolveModel: vi.fn(), searchWeb: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/web-search', async (original) => ({
  ...(await original<typeof import('@/lib/web-search')>()),
  searchWeb: mocks.searchWeb,
}));
import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';
import {
  buildChildActionTools,
  createPiWhiteboardRuntimeState,
} from '@/lib/chat/pi/tools/classroom-actions';
const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach clearly',
  avatar: '',
  color: '#fff',
  allowedActions: ['wb_open', 'wb_draw_text'],
  priority: 10,
  createdAt: new Date(),
  updatedAt: new Date(),
  isDefault: true,
};
const model = { provider: 'test.provider', modelId: 'offline' };
function body(): StatelessChatRequest {
  return {
    messages: [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Explain thoroughly' }] },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'Test', createdAt: 1, updatedAt: 1 },
      outlines: [],
      scenes: [],
      currentSceneId: null,
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: { agentIds: [teacher.id], agentConfigs: [teacher] },
    apiKey: '',
  } as StatelessChatRequest;
}
function finish(reason = 'stop') {
  return {
    type: 'finish',
    finishReason: reason,
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  };
}
function result(parts: Record<string, unknown>[]) {
  return {
    fullStream: (async function* () {
      yield* parts;
    })(),
    usage: new Promise(() => {}),
  };
}
function call(name: string, id: string, input: unknown) {
  return { type: 'tool-call', toolName: name, toolCallId: id, input };
}
const invoke = (id: string) =>
  call('call_agent', id, { agentId: teacher.id, instruction: 'Continue the explanation' });
const speech = (text = 'Useful answer') => result([{ type: 'text-delta', text }, finish()]);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}
async function run(
  events: StatelessEvent[],
  controller = new AbortController(),
  mode: 'native' | 'legacy' = 'legacy',
) {
  const b = body();
  await runPiDirectorLoop({
    body: b,
    agentConfigs: [teacher],
    send: async (e) => {
      events.push(e);
    },
    languageModel: model as never,
    thinkingConfig: { mode: 'disabled', enabled: false },
    abortSignal: controller.signal,
    signal: controller.signal,
    enableWhiteboardTools: true,
    childRuntimeMode: mode,
    nativeWebSearchConfig: {
      providerId: 'tavily',
      apiKey: 'offline',
      baseUrl: 'https://offline.invalid',
    },
  });
}
async function runRoute(events: StatelessEvent[], mode: 'native' | 'legacy' = 'legacy') {
  vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', String(mode === 'native'));
  mocks.resolveModel.mockResolvedValue({ model, apiKey: 'offline', providerId: 'openai' });
  const { POST } = await import('@/app/api/chat/pi/route');
  const request = body();
  request.config.piEnableWhiteboardTools = true;
  const response = await POST(
    new Request('http://localhost/api/chat/pi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }) as NextRequest,
  );
  expect(response.status).toBe(200);
  for (const frame of (await response.text()).split('\n\n')) {
    if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
  }
}
function done(events: StatelessEvent[]) {
  const e = events.find((e) => e.type === 'done');
  if (e?.type !== 'done') throw Error('missing done');
  return e.data;
}
describe('Pi Director completion and request cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.streamLLM.mockReset();
    mocks.searchWeb.mockReset();
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'false');
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(['legacy', 'native'] as const)(
    'lets the route complete eight %s delegations under default settings',
    async (mode) => {
      let directorCalls = 0;
      let childCalls = 0;
      mocks.streamLLM.mockImplementation((_p, source) => {
        if (source !== 'pi-chat-director') {
          childCalls++;
          return speech();
        }
        directorCalls++;
        return result([
          directorCalls <= 8 ? invoke('d' + directorCalls) : call('cue_user', 'cue', {}),
          finish('tool-calls'),
        ]);
      });
      const events: StatelessEvent[] = [];
      await runRoute(events, mode);
      expect(childCalls).toBe(8);
      expect(done(events).totalAgents).toBe(8);
      expect(done(events).cueUserReceived).toBe(true);
    },
  );
  it('allows twenty Director tools through the route under default settings', async () => {
    let n = 0;
    mocks.streamLLM.mockImplementation(() =>
      ++n <= 20
        ? result([call('read_scene', 'read' + n, { sceneId: 'missing' }), finish('tool-calls')])
        : speech('Finished'),
    );
    const events: StatelessEvent[] = [];
    await runRoute(events);
    expect(n).toBe(21);
    expect(done(events).directorToolTrace).toHaveLength(20);
    expect(done(events).totalAgents).toBe(0);
  });
  it('delivers nine valid Legacy actions and subsequent speech through the route under default settings', async () => {
    let n = 0;
    const actions = [
      { type: 'action', name: 'wb_open', params: {} },
      ...Array.from({ length: 8 }, (_, i) => ({
        type: 'action',
        name: 'wb_draw_text',
        params: { content: 'item ' + i, x: 20, y: 40 + i * 40 },
      })),
      { type: 'text', content: 'All steps explained' },
    ];
    mocks.streamLLM.mockImplementation((_p, source) =>
      source === 'pi-chat-director'
        ? result([++n === 1 ? invoke('d1') : call('cue_user', 'cue', {}), finish('tool-calls')])
        : speech(JSON.stringify(actions)),
    );
    const events: StatelessEvent[] = [];
    await runRoute(events);
    expect(events.filter((e) => e.type === 'action')).toHaveLength(9);
    expect(done(events).totalActions).toBe(9);
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.data.content)
        .join(''),
    ).toContain('All steps explained');
  });
  it('allows a third delegation after two empty Legacy results', async () => {
    let n = 0;
    let child = 0;
    mocks.streamLLM.mockImplementation((_p, source) => {
      if (source !== 'pi-chat-director') {
        child++;
        return result([finish()]);
      }
      return ++n <= 3 ? result([invoke('d' + n), finish('tool-calls')]) : speech('done');
    });
    const events: StatelessEvent[] = [];
    await run(events);
    expect(child).toBe(3);
    expect(done(events).totalAgents).toBe(3);
  });
  it('allows a third Native delegation after two partial token-limited responses', async () => {
    let n = 0;
    let child = 0;
    mocks.streamLLM.mockImplementation((_p, source) => {
      if (source !== 'pi-chat-director') {
        child++;
        return result([
          { type: 'text-delta', text: 'Partial visible explanation' },
          finish('length'),
        ]);
      }
      return ++n <= 3 ? result([invoke('d' + n), finish('tool-calls')]) : speech('done');
    });
    const events: StatelessEvent[] = [];
    await run(events, new AbortController(), 'native');
    expect(child).toBe(3);
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.data.content)
        .join(''),
    ).toContain('Partial visible explanation');
    expect(done(events).totalAgents).toBe(3);
  });
  it.each(['director', 'legacy', 'native'] as const)(
    'cancels while %s provider is pending without a done event',
    async (phase) => {
      const controller = new AbortController();
      const started = deferred();
      let pendingSignal: AbortSignal | undefined;
      mocks.streamLLM.mockImplementation((p, source) => {
        if (phase !== 'director' && source === 'pi-chat-director')
          return result([invoke('d1'), finish('tool-calls')]);
        pendingSignal = p.abortSignal;
        started.resolve();
        return new Promise(() => {});
      });
      const events: StatelessEvent[] = [];
      const running = run(events, controller, phase === 'native' ? 'native' : 'legacy');
      await started.promise;
      controller.abort();
      await running;
      expect(pendingSignal?.aborted).toBe(true);
      expect(events.some((e) => e.type === 'done' || e.type === 'cue_user')).toBe(false);
    },
  );
  it('cancels a Native child during pending web_search with no continuation', async () => {
    const controller = new AbortController();
    const started = deferred();
    let searchSignal: AbortSignal | undefined;
    mocks.streamLLM.mockImplementation((_p, source) =>
      result([
        source === 'pi-chat-director' ? invoke('d1') : call('web_search', 's1', { query: 'test' }),
        finish('tool-calls'),
      ]),
    );
    mocks.searchWeb.mockImplementation((p) => {
      searchSignal = p.signal;
      started.resolve();
      return new Promise(() => {});
    });
    const events: StatelessEvent[] = [];
    const running = run(events, controller, 'native');
    await started.promise;
    controller.abort();
    await running;
    expect(searchSignal?.aborted).toBe(true);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
  it('a tool timeout returns an error to Director and does not terminate the loop', async () => {
    vi.stubEnv('OPENMAIC_AGENT_TOOL_TIMEOUT_MS', '25');
    let n = 0;
    mocks.streamLLM.mockImplementation((_p, source) => {
      if (source !== 'pi-chat-director') return new Promise(() => {});
      return ++n === 1
        ? result([invoke('d1'), finish('tool-calls')])
        : speech('Tool failed, ending naturally');
    });
    const events: StatelessEvent[] = [];
    await run(events);
    expect(n).toBe(2);
    expect(done(events).directorToolTrace?.[0]).toMatchObject({
      isError: true,
      resultPreview: expect.stringContaining('execution budget'),
    });
  });
  it('does not call a provider when cancelled during route model resolution', async () => {
    const controller = new AbortController();
    mocks.resolveModel.mockImplementation(async () => {
      controller.abort();
      return { model, apiKey: 'offline', providerId: 'openai' };
    });
    mocks.streamLLM.mockImplementation(() => speech('Provider still called after early abort'));
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      new Request('http://localhost/api/chat/pi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
        signal: controller.signal,
      }) as NextRequest,
    );
    await response.text();
    expect(controller.signal.aborted).toBe(true);
    expect(mocks.streamLLM).not.toHaveBeenCalled();
  });
  it.each(['request cancellation', 'tool timeout'])(
    'stops a parsed Legacy action batch on %s while delivery is pending',
    async (reason) => {
      if (reason === 'tool timeout') vi.stubEnv('OPENMAIC_AGENT_TOOL_TIMEOUT_MS', '50');
      let directorCalls = 0;
      const controller = new AbortController();
      const started = deferred();
      const release = deferred();
      const events: StatelessEvent[] = [];
      const payload = JSON.stringify([
        { type: 'action', name: 'wb_open', params: {} },
        { type: 'action', name: 'wb_draw_text', params: { content: 'late', x: 20, y: 40 } },
        { type: 'text', content: 'late speech' },
      ]);
      mocks.streamLLM.mockImplementation((_p, source) =>
        source === 'pi-chat-director'
          ? ++directorCalls === 1
            ? result([invoke('d1'), finish('tool-calls')])
            : speech('Tool failed, ending naturally')
          : speech(payload),
      );
      const b = body();
      let settled = false;
      const running = runPiDirectorLoop({
        body: b,
        agentConfigs: [teacher],
        send: async (e) => {
          events.push(e);
          if (e.type === 'action' && e.data.actionName === 'wb_open') {
            started.resolve();
            await release.promise;
          }
        },
        languageModel: model as never,
        thinkingConfig: { mode: 'disabled', enabled: false },
        abortSignal: controller.signal,
        signal: controller.signal,
        enableWhiteboardTools: true,
        childRuntimeMode: 'legacy',
      }).finally(() => {
        settled = true;
      });
      await started.promise;
      if (reason === 'request cancellation') controller.abort();
      try {
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 250 });
      } finally {
        release.resolve();
        await running;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events.filter((e) => e.type === 'action').map((e) => e.data.actionName)).toEqual([
        'wb_open',
      ]);
      expect(events.some((e) => e.type === 'agent_end' || e.type === 'text_delta')).toBe(false);
      if (reason === 'request cancellation') {
        expect(events.some((e) => e.type === 'done')).toBe(false);
      } else {
        expect(done(events).totalAgents).toBe(0);
        expect(done(events).totalActions).toBe(1);
        expect(done(events).directorState?.whiteboardLedger).toEqual([
          expect.objectContaining({ actionName: 'wb_open' }),
        ]);
        expect(done(events).directorToolTrace?.[0]).toMatchObject({ isError: true });
        expect(directorCalls).toBe(2);
      }
    },
  );
  it.each(['before next child', 'after next child starts'])(
    'retains a timed-out dispatched draw for the next child when delivery resumes %s',
    async (releaseWhen) => {
      vi.stubEnv('OPENMAIC_AGENT_TOOL_TIMEOUT_MS', '50');
      const release = deferred();
      const events: StatelessEvent[] = [];
      let directorCalls = 0;
      let childCalls = 0;
      let secondChildPrompt = '';
      mocks.streamLLM.mockImplementation((params, source) => {
        if (source === 'pi-chat-director') {
          directorCalls++;
          if (directorCalls === 2 && releaseWhen === 'before next child') release.resolve();
          return result([
            directorCalls <= 2 ? invoke('d' + directorCalls) : call('cue_user', 'cue', {}),
            finish('tool-calls'),
          ]);
        }
        childCalls++;
        if (childCalls === 2) {
          secondChildPrompt = JSON.stringify(params);
          if (releaseWhen === 'after next child starts') release.resolve();
        }
        return speech(
          JSON.stringify(
            childCalls === 1
              ? [
                  {
                    type: 'action',
                    name: 'wb_draw_text',
                    params: { elementId: 'el-1', content: 'drawn before timeout', x: 20, y: 40 },
                  },
                  { type: 'action', name: 'wb_clear', params: {} },
                  { type: 'text', content: 'must not be delivered' },
                ]
              : [
                  { type: 'action', name: 'wb_delete', params: { elementId: 'el-1' } },
                  { type: 'text', content: 'Removed it' },
                ],
          ),
        );
      });
      const controller = new AbortController();
      try {
        await runPiDirectorLoop({
          body: body(),
          agentConfigs: [{ ...teacher, allowedActions: ['wb_draw_text', 'wb_clear', 'wb_delete'] }],
          send: async (event) => {
            events.push(event);
            if (event.type === 'action' && event.data.actionName === 'wb_draw_text')
              await release.promise;
          },
          languageModel: model as never,
          thinkingConfig: { mode: 'disabled', enabled: false },
          abortSignal: controller.signal,
          signal: controller.signal,
          enableWhiteboardTools: true,
          childRuntimeMode: 'legacy',
        });
      } finally {
        release.resolve();
      }
      expect(events.filter((e) => e.type === 'action').map((e) => e.data.actionName)).toEqual([
        'wb_draw_text',
        'wb_delete',
      ]);
      expect(secondChildPrompt).toContain('el-1');
      expect(done(events).totalActions).toBe(2);
      expect(done(events).totalAgents).toBe(1);
      expect(
        done(events).directorState?.whiteboardLedger?.map((action) => action.actionName),
      ).toEqual(['wb_draw_text', 'wb_delete']);
      expect(done(events).directorToolTrace?.[0]).toMatchObject({ isError: true });
      expect(events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
      expect(
        events.some(
          (e) => e.type === 'text_delta' && e.data.content.includes('must not be delivered'),
        ),
      ).toBe(false);
    },
  );
  it.each(['pre-aborted', 'synchronous failure', 'asynchronous failure'])(
    'does not bookkeep an action on %s before accepted delivery',
    async (failure) => {
      const controller = new AbortController();
      if (failure === 'pre-aborted') controller.abort();
      const send = vi.fn(() => {
        if (failure === 'synchronous failure') throw new Error('send failed');
        return Promise.reject(new Error('send failed'));
      });
      const request = body();
      const state = createPiWhiteboardRuntimeState(request);
      const onActionDone = vi.fn();
      const tool = buildChildActionTools({
        body: request,
        agent: teacher,
        messageId: 'message-1',
        send,
        onActionDone,
        abortSignal: controller.signal,
        enableWhiteboardTools: true,
        whiteboardState: state,
      }).find((tool) => tool.name === 'wb_draw_text')!;
      await expect(
        tool.execute('action-1', { elementId: 'el-1', content: 'text', x: 20, y: 40 }),
      ).rejects.toBeDefined();
      expect(send).toHaveBeenCalledTimes(failure === 'pre-aborted' ? 0 : 1);
      expect(onActionDone).not.toHaveBeenCalled();
      expect(state.visibleElementCount).toBe(0);
      expect(state.knownElementIds.size).toBe(0);
    },
  );
  it.each(['legacy', 'native'] as const)(
    'cancels %s while agent_start delivery is pending',
    async (mode) => {
      const controller = new AbortController();
      const started = deferred();
      const release = deferred();
      const events: StatelessEvent[] = [];
      mocks.streamLLM.mockImplementation((_p, source) =>
        source === 'pi-chat-director' ? result([invoke('d1'), finish('tool-calls')]) : speech(),
      );
      const b = body();
      let settled = false;
      const running = runPiDirectorLoop({
        body: b,
        agentConfigs: [teacher],
        send: async (e) => {
          events.push(e);
          if (e.type === 'agent_start') {
            started.resolve();
            await release.promise;
          }
        },
        languageModel: model as never,
        thinkingConfig: { mode: 'disabled', enabled: false },
        abortSignal: controller.signal,
        signal: controller.signal,
        enableWhiteboardTools: true,
        childRuntimeMode: mode,
      }).finally(() => {
        settled = true;
      });
      await started.promise;
      controller.abort();
      try {
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 250 });
      } finally {
        release.resolve();
        await running;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    },
  );
  it('cancels fallback cue delivery without emitting done', async () => {
    let calls = 0;
    const controller = new AbortController();
    const events: StatelessEvent[] = [];
    const started = deferred();
    const release = deferred();
    mocks.streamLLM.mockImplementation((_p, source) =>
      source === 'pi-chat-director'
        ? ++calls === 1
          ? result([invoke('d1'), finish('tool-calls')])
          : speech()
        : speech(),
    );
    const b = body();
    let settled = false;
    const running = runPiDirectorLoop({
      body: b,
      agentConfigs: [teacher],
      send: async (e) => {
        events.push(e);
        if (e.type === 'cue_user') {
          started.resolve();
          await release.promise;
        }
      },
      languageModel: model as never,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: controller.signal,
      signal: controller.signal,
      enableWhiteboardTools: true,
      childRuntimeMode: 'legacy',
    }).finally(() => {
      settled = true;
    });
    await started.promise;
    controller.abort();
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 250 });
    } finally {
      release.resolve();
      await running;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});
