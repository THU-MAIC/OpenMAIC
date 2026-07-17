import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({
  buildAgent: vi.fn(),
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: vi.fn(() => vi.fn()),
}));

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'AI teacher',
  role: 'teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_open', 'wb_draw_text', 'wb_close'],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};
const fullWhiteboardActions = [
  'spotlight',
  'laser',
  'play_video',
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_clear',
  'wb_delete',
  'wb_close',
];
const slideTeacher: AgentConfig = {
  ...teacher,
  allowedActions: fullWhiteboardActions,
};

function makeBody(
  opts: {
    sceneType?: 'slide' | 'quiz';
    slideElements?: unknown[];
    whiteboardOpen?: boolean;
    whiteboardElements?: unknown[];
  } = {},
): StatelessChatRequest {
  const sceneType = opts.sceneType ?? 'slide';
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: '请画一下树荫为什么降温。' }],
      },
    ],
    storeState: {
      stage: {
        id: 'stage-1',
        name: 'City Cooling',
        whiteboard:
          opts.whiteboardElements !== undefined
            ? [{ id: 'wb-1', elements: opts.whiteboardElements }]
            : undefined,
      },
      scenes: [
        {
          id: 'scene-1',
          title: 'Cooling',
          type: sceneType,
          content:
            sceneType === 'slide'
              ? { type: 'slide', canvas: { elements: opts.slideElements ?? [] } }
              : { type: 'quiz', questions: [] },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: opts.whiteboardOpen ?? false,
    },
    config: {
      agentIds: [teacher.id],
      agentConfigs: [teacher],
      piEnableWhiteboardTools: true,
    },
    apiKey: '',
  } as unknown as StatelessChatRequest;
}

function makeMockChildWithJsonOutput(jsonOutput: string) {
  return {
    subscribe: (handler: (event: unknown) => void) => {
      setTimeout(() => {
        handler({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: jsonOutput },
        });
      }, 0);
      return () => {};
    },
    prompt: async () => {},
    waitForIdle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    state: {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: jsonOutput }],
        },
      ],
    },
  };
}

function mockChildWithJsonOutput(jsonOutput: string) {
  mocks.buildAgent.mockReturnValue(makeMockChildWithJsonOutput(jsonOutput));
}

// Deliver the assistant output as several text deltas, awaiting the subscriber
// for each chunk before the next — mirroring pi-agent-core, which does
// `await listener(event)` and only resolves waitForIdle once every delta has
// been fully drained. This lets us exercise mid-token split boundaries that the
// single-delta mock never hits.
function mockChildWithChunks(chunks: string[], finalMessage?: string) {
  let handler: ((event: unknown) => unknown) | null = null;
  mocks.buildAgent.mockReturnValue({
    subscribe: (h: (event: unknown) => unknown) => {
      handler = h;
      return () => {};
    },
    prompt: async () => {},
    waitForIdle: async () => {
      for (const chunk of chunks) {
        await handler?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: chunk },
        });
      }
    },
    state: {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: finalMessage ?? chunks.join('') }],
        },
      ],
    },
  });
}

function baseToolOpts(events: StatelessEvent[]) {
  return {
    body: makeBody(),
    agentConfigs: [teacher],
    send: async (event: StatelessEvent) => {
      events.push(event);
    },
    languageModel: {} as never,
    onAgentDone: vi.fn(),
    onActionDone: vi.fn(),
    thinkingConfig: { mode: 'disabled' as const, enabled: false },
    abortSignal: new AbortController().signal,
    maxAgentTurns: 6,
    getAgentTurnCount: () => 0,
    getAgentResponses: () => [],
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: 8,
    enableWhiteboardTools: true,
  };
}

describe('Pi call_agent JSON action output', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.buildAgent.mockReset();
  });

  it('parses child JSON actions, executes all action events, and does not leak raw JSON speech', async () => {
    const jsonOutput = JSON.stringify([
      { type: 'action', name: 'wb_open', params: {} },
      {
        type: 'action',
        name: 'wb_draw_text',
        params: { content: '树荫减少太阳辐射', x: 80, y: 120 },
      },
      { type: 'action', name: 'wb_close', params: {} },
      { type: 'text', content: '我画了一个很简单的关系：树荫先挡住直射阳光，地面吸热就会减少。' },
    ]);
    mockChildWithJsonOutput(jsonOutput);

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: teacher.id,
      instruction: 'Draw and explain briefly.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_open', 'wb_draw_text', 'wb_close']);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: {
          messageId: expect.any(String),
          content: '我画了一个很简单的关系：树荫先挡住直射阳光，地面吸热就会减少。',
        },
      },
    ]);
    const visibleSpeech = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.data.content)
      .join('');
    expect(visibleSpeech).not.toContain('"type":"action"');
    expect(visibleSpeech).not.toContain('wb_open');
    expect(result.details).toMatchObject({
      agentId: teacher.id,
      text: '我画了一个很简单的关系：树荫先挡住直射阳光，地面吸热就会减少。',
    });
  });

  it('does not surface malformed structured JSON fallback as visible speech', async () => {
    mockChildWithJsonOutput('[{"type":"action","name":"wb_open","params":{}');

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: teacher.id,
      instruction: 'Draw and explain briefly.',
    });

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([]);
    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    // Suppression now happens in the structured parser, so no raw text ever
    // reaches the downstream fallback filter (hence no warning is surfaced).
    expect(result.details).toMatchObject({
      agentId: teacher.id,
      text: '',
    });
  });

  it('extracts content from a bare {type:"text"} object instead of leaking raw JSON', async () => {
    mockChildWithJsonOutput('{"type":"text","content":"这应该被结构化解析并显示。"}');

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool(baseToolOpts(events));

    const result = await tool.execute('call-1', {
      agentId: teacher.id,
      instruction: 'Explain briefly.',
    });

    const visibleSpeech = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.data.content)
      .join('');
    expect(visibleSpeech).toBe('这应该被结构化解析并显示。');
    expect(visibleSpeech).not.toContain('"type"');
    expect(visibleSpeech).not.toContain('"content"');
    expect(result.details).toMatchObject({
      agentId: teacher.id,
      text: '这应该被结构化解析并显示。',
    });
  });

  it('suppresses a bare action / unknown JSON object instead of showing raw JSON', async () => {
    for (const bareObject of [
      '{"type":"action","name":"wb_open","params":{}}',
      '{"foo":"bar","note":"unknown structured object"}',
    ]) {
      mocks.buildAgent.mockReset();
      mockChildWithJsonOutput(bareObject);

      const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
      const events: StatelessEvent[] = [];
      const tool = buildCallAgentTool(baseToolOpts(events));

      const result = await tool.execute('call-1', {
        agentId: teacher.id,
        instruction: 'Explain briefly.',
      });

      expect(events.filter((event) => event.type === 'text_delta')).toEqual([]);
      expect(events.filter((event) => event.type === 'action')).toEqual([]);
      expect(result.details).toMatchObject({ agentId: teacher.id, text: '' });
    }
  });

  it('suppresses brace-less / truncated JSON fragments instead of leaking them', async () => {
    for (const fragment of [
      // missing the opening `{`
      'type":"text","content":"半句话被截断',
      // starts like an object but never closes — jsonrepair must not resurrect it
      '{"type":"text","content":"内容没有闭合',
    ]) {
      mocks.buildAgent.mockReset();
      mockChildWithJsonOutput(fragment);

      const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
      const events: StatelessEvent[] = [];
      const tool = buildCallAgentTool(baseToolOpts(events));

      const result = await tool.execute('call-1', {
        agentId: teacher.id,
        instruction: 'Explain briefly.',
      });

      const visibleSpeech = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.data.content)
        .join('');
      expect(visibleSpeech).not.toContain('type"');
      expect(visibleSpeech).not.toContain('"content"');
      expect(result.details).toMatchObject({ agentId: teacher.id, text: '' });
    }
  });

  it('assembles one clean message from a chunked JSON stream without leaking raw JSON', async () => {
    // A valid array split at awkward mid-token boundaries across deltas.
    mockChildWithChunks([
      '[{"type":"acti',
      'on","name":"wb_open","params":{}},{"type":"te',
      'xt","content":"树荫挡住阳光，',
      '地面升温更慢。"}]',
    ]);

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool(baseToolOpts(events));

    const result = await tool.execute('call-1', {
      agentId: teacher.id,
      instruction: 'Draw and explain briefly.',
    });

    const textEvents = events.filter((event) => event.type === 'text_delta');
    const visibleSpeech = textEvents.map((event) => event.data.content).join('');
    // Content is reassembled correctly regardless of chunk boundaries.
    expect(visibleSpeech).toBe('树荫挡住阳光，地面升温更慢。');
    // No raw structured tokens leak into the bubble.
    expect(visibleSpeech).not.toContain('"type"');
    expect(visibleSpeech).not.toContain('wb_open');
    // All deltas belong to a single assistant message (not split into bubbles).
    expect(new Set(textEvents.map((event) => event.data.messageId)).size).toBe(1);
    // The whiteboard action still fires.
    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_open']);
    expect(result.details).toMatchObject({
      agentId: teacher.id,
      text: '树荫挡住阳光，地面升温更慢。',
    });
  });

  it('routes suppressed/weak child turns to the empty-turn guard', async () => {
    const onAgentDone = vi.fn();
    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({ ...baseToolOpts(events), onAgentDone });

    // Child emits a brace-less / truncated structured tail — the exact residue
    // the old substring classifier missed and leaked as visible speech (and thus
    // miscounted as a substantive turn). After suppression there is no visible
    // text and no executed action — a weak turn.
    const residue = 'type":"text","content":"半句话被截断';
    mockChildWithJsonOutput(residue);
    const first = await tool.execute('c1', { agentId: teacher.id, instruction: 'go' });
    expect(first.details).toMatchObject({ text: '' });
    // The summary handed to the director is non-substantive: empty preview + no
    // actions, so isTeachingSubstantiveTurn() rejects it and cue_user is blocked.
    expect(onAgentDone).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentPreview: '', actionCount: 0 }),
    );

    mocks.buildAgent.mockReset();
    mockChildWithJsonOutput(residue);
    await tool.execute('c2', { agentId: teacher.id, instruction: 'go' });

    // Two consecutive weak turns trip the empty-turn guard: a third call is
    // refused, so the director stops instead of treating scraps as teaching.
    mocks.buildAgent.mockReset();
    mockChildWithJsonOutput(residue);
    const third = await tool.execute('c3', { agentId: teacher.id, instruction: 'go' });
    expect(third.details).toMatchObject({ reason: 'consecutive_empty_turns' });
  });

  it('counts real speech that merely discusses JSON/brackets as a substantive turn', async () => {
    // Regression for #4: the visible speech legitimately contains structured-output
    // punctuation (`{"name":...}`, `[1,2]`). It was already streamed cleanly through
    // the parser, so it must be trusted — NOT re-run through the residue classifier,
    // which would flag it and misclassify a genuine teaching turn as empty.
    const speech = '我们用花括号表示对象，例如 {"name":"树"}，也用方括号 [1,2] 表示数组。';
    mockChildWithJsonOutput(JSON.stringify([{ type: 'text', content: speech }]));

    const onAgentDone = vi.fn();
    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({ ...baseToolOpts(events), onAgentDone });

    const result = await tool.execute('call-1', {
      agentId: teacher.id,
      instruction: 'Explain JSON notation.',
    });

    const visibleSpeech = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.data.content)
      .join('');
    expect(visibleSpeech).toBe(speech);
    expect(result.details).toMatchObject({ agentId: teacher.id, text: speech });
    // The turn is substantive: non-empty contentPreview so isTeachingSubstantiveTurn
    // accepts it and the director may legitimately cue_user afterwards.
    expect(onAgentDone).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentPreview: speech, actionCount: 0 }),
    );
  });

  it('accepts the raw-fallback path text unless it is whole structured residue', async () => {
    // No `[` ever streams (sawStructuredOutput stays false), so call-agent falls back
    // to the last assistant message. Genuine prose there is shown; whole JSON residue
    // is still suppressed by the backstop.
    mocks.buildAgent.mockReset();
    mocks.buildAgent.mockReturnValue({
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      state: {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: '同学们，我们开始上课。' }] },
        ],
      },
    });
    const onAgentDone = vi.fn();
    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({ ...baseToolOpts(events), onAgentDone });

    const result = await tool.execute('call-1', { agentId: teacher.id, instruction: 'go' });
    expect(result.details).toMatchObject({ text: '同学们，我们开始上课。' });
    expect(onAgentDone).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentPreview: '同学们，我们开始上课。' }),
    );
  });

  it('shows raw-fallback prose that merely contains an inline JSON example', async () => {
    // Boundary for the residue classifier: the model never emits `[`, so this
    // goes through the raw-fallback path. The prose legitimately embeds a JSON
    // snippet mid-sentence (`{"name":"树"}`). The classifier must anchor its
    // schema-key match to the START of the buffer, so this stays visible instead
    // of being suppressed as residue and miscounted as an empty turn.
    mocks.buildAgent.mockReset();
    const speech = '我们用对象 {"name":"树"} 表示一棵树。';
    mocks.buildAgent.mockReturnValue({
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      state: {
        messages: [{ role: 'assistant', content: [{ type: 'text', text: speech }] }],
      },
    });
    const onAgentDone = vi.fn();
    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({ ...baseToolOpts(events), onAgentDone });

    const result = await tool.execute('call-1', { agentId: teacher.id, instruction: 'go' });
    expect(result.details).toMatchObject({ agentId: teacher.id, text: speech });
    // Substantive turn: non-empty preview so the empty-turn guard is not tripped.
    expect(onAgentDone).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentPreview: speech, actionCount: 0 }),
    );
  });

  it('accepts play_video for a current-slide video element', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'play_video', params: { elementId: 'video_1' } },
        { type: 'text', content: '先看这个短视频，再回到概念。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({
        slideElements: [
          {
            id: 'video_1',
            type: 'video',
            left: 80,
            top: 120,
            width: 480,
            height: 270,
            autoplay: false,
          },
        ],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Use the video briefly.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([
      {
        type: 'action',
        data: {
          actionId: expect.any(String),
          actionName: 'play_video',
          agentId: slideTeacher.id,
          messageId: expect.any(String),
          params: { elementId: 'video_1' },
        },
      },
    ]);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: {
          messageId: expect.any(String),
          content: '先看这个短视频，再回到概念。',
        },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '先看这个短视频，再回到概念。',
      actionWarnings: [],
    });
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 1 }));
  });

  it('skips play_video when the element is missing or not a video', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'play_video', params: { elementId: 'text_1' } },
        { type: 'action', name: 'play_video', params: { elementId: 'missing_video' } },
        { type: 'text', content: '找不到合适视频时，我只口头说明。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({
        slideElements: [{ id: 'text_1', type: 'text', content: 'not video', left: 80, top: 120 }],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Use a video if it exists.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: { messageId: expect.any(String), content: '找不到合适视频时，我只口头说明。' },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '找不到合适视频时，我只口头说明。',
      actionWarnings: [
        {
          actionName: 'play_video',
          reason: 'invalid_params',
          message: 'play_video params.elementId "text_1" must reference a video element, got text',
        },
        {
          actionName: 'play_video',
          reason: 'invalid_params',
          message: 'play_video params.elementId "missing_video" was not found on the current slide',
        },
      ],
    });
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 0 }));
  });

  it('validates play_video required params', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'play_video', params: {} },
        { type: 'text', content: '缺少视频元素 id 时不会播放。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody({
        slideElements: [
          {
            id: 'video_1',
            type: 'video',
            left: 80,
            top: 120,
            width: 480,
            height: 270,
            autoplay: false,
          },
        ],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Use a video briefly.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(result.details).toMatchObject({
      text: '缺少视频元素 id 时不会播放。',
      actionWarnings: [
        {
          actionName: 'play_video',
          reason: 'invalid_params',
          message: 'play_video requires params.elementId string',
        },
      ],
    });
  });

  it('does not expose play_video outside slide scenes', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'play_video', params: { elementId: 'video_1' } },
        { type: 'text', content: '非 slide 场景里不播放视频。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody({ sceneType: 'quiz' }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Try a video outside slide.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: { messageId: expect.any(String), content: '非 slide 场景里不播放视频。' },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '非 slide 场景里不播放视频。',
      actionWarnings: [
        {
          actionName: 'play_video',
          reason: 'unknown_action',
          message: 'Action "play_video" is not available for this agent/scene.',
        },
      ],
    });
  });

  it('skips out-of-scope actions with a warning while preserving legal text', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'widget_highlight', params: { target: '#graph' } },
        { type: 'text', content: '这个 widget 动作不属于本轮 Pi parity slice。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: teacher.id,
      instruction: 'Try an out-of-scope action.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: {
          messageId: expect.any(String),
          content: '这个 widget 动作不属于本轮 Pi parity slice。',
        },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '这个 widget 动作不属于本轮 Pi parity slice。',
      actionWarnings: [
        {
          actionName: 'widget_highlight',
          reason: 'unknown_action',
          message: 'Action "widget_highlight" is not available for this agent/scene.',
        },
      ],
    });
  });

  it('does not allow wrap-up turns to mutate the whiteboard', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'spotlight', params: { elementId: 'formula_1' } },
        { type: 'action', name: 'wb_open', params: {} },
        {
          type: 'action',
          name: 'wb_draw_latex',
          params: { latex: '6CO_2 + 6H_2O -> C_6H_{12}O_6 + 6O_2', x: 80, y: 120 },
        },
        { type: 'text', content: '最后看一下幻灯片上的公式就好。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({
        slideElements: [{ id: 'formula_1', type: 'latex', latex: '6CO_2 + 6H_2O -> ...' }],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 1,
      getAgentTurnCount: () => 1,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Give one short final summary.',
      turnKind: 'wrap_up',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([
      {
        type: 'action',
        data: {
          actionId: expect.any(String),
          actionName: 'spotlight',
          agentId: slideTeacher.id,
          messageId: expect.any(String),
          params: { elementId: 'formula_1' },
        },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '最后看一下幻灯片上的公式就好。',
      turnKind: 'wrap_up',
      actionWarnings: [
        {
          actionName: 'wb_open',
          reason: 'unknown_action',
          message: 'Action "wb_open" is not available for this agent/scene.',
        },
        {
          actionName: 'wb_draw_latex',
          reason: 'unknown_action',
          message: 'Action "wb_draw_latex" is not available for this agent/scene.',
        },
      ],
    });
    expect(onActionDone).toHaveBeenCalledTimes(1);
    expect(onAgentDone).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCount: 1,
        whiteboardActions: [],
        turnKind: 'wrap_up',
      }),
    );
  });

  it('skips actions with missing required params and preserves later legal action/text', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_draw_text', params: { content: 'missing coordinates' } },
        { type: 'action', name: 'wb_open', params: {} },
        { type: 'text', content: '我先打开白板，再口头说明。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: teacher.id,
      instruction: 'Draw and explain briefly.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_open']);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: { messageId: expect.any(String), content: '我先打开白板，再口头说明。' },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '我先打开白板，再口头说明。',
      actionWarnings: [
        {
          actionName: 'wb_draw_text',
          reason: 'invalid_params',
          message: 'wb_draw_text requires params.x number',
        },
      ],
    });
  });

  it('filters scene-disallowed slide actions with a warning', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'spotlight', params: { elementId: 'text_1' } },
        { type: 'action', name: 'wb_open', params: {} },
        { type: 'text', content: '这个 quiz 场景里我不用聚光灯。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody({ sceneType: 'quiz' }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Draw and explain briefly.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_open']);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: { messageId: expect.any(String), content: '这个 quiz 场景里我不用聚光灯。' },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '这个 quiz 场景里我不用聚光灯。',
      actionWarnings: [
        {
          actionName: 'spotlight',
          reason: 'unknown_action',
          message: 'Action "spotlight" is not available for this agent/scene.',
        },
      ],
    });
  });

  it('supports the in-scope whiteboard clear/delete actions', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_delete', params: { elementId: 'note-1' } },
        { type: 'action', name: 'wb_clear', params: {} },
        { type: 'text', content: '我先删除指定元素，再清掉剩余旧内容。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({
        whiteboardElements: [
          { id: 'note-1', type: 'text', content: 'old', left: 80, top: 120 },
          { id: 'note-2', type: 'text', content: 'older', left: 80, top: 180 },
        ],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Clear and delete briefly.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_delete', 'wb_clear']);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: { messageId: expect.any(String), content: '我先删除指定元素，再清掉剩余旧内容。' },
      },
    ]);
    expect(onActionDone).toHaveBeenCalledWith(
      expect.objectContaining({ actionName: 'wb_delete', params: { elementId: 'note-1' } }),
    );
    expect(onActionDone).toHaveBeenCalledWith(expect.objectContaining({ actionName: 'wb_clear' }));
    expect(result.details).toMatchObject({
      text: '我先删除指定元素，再清掉剩余旧内容。',
      actionWarnings: [],
    });
  });

  it('skips wb_delete when the target id is not on a nonempty whiteboard', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_delete', params: { elementId: 'missing-note' } },
        { type: 'text', content: '找不到目标时不删除白板元素。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({
        whiteboardElements: [{ id: 'note-1', type: 'text', content: 'keep', left: 80, top: 120 }],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Try deleting a missing note.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      actionWarnings: [
        expect.objectContaining({
          message:
            'Action wb_delete skipped because whiteboard element "missing-note" was not found.',
        }),
      ],
    });
  });

  it('skips redundant wb_open without sending duplicate frontend actions or ledger records', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_open', params: {} },
        { type: 'action', name: 'wb_open', params: {} },
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { content: '树荫挡住直射阳光', x: 80, y: 120 },
        },
        { type: 'text', content: '我在已经打开的白板上继续补充，不重复打开。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Open once and draw briefly.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_open', 'wb_draw_text']);
    expect(onActionDone).toHaveBeenCalledTimes(2);
    expect(onActionDone).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actionName: 'wb_open' }),
    );
    expect(onActionDone).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actionName: 'wb_draw_text' }),
    );
    expect(result.details).toMatchObject({
      text: '我在已经打开的白板上继续补充，不重复打开。',
      actionWarnings: [],
    });
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 2 }));
  });

  it('skips a draw action that reuses an existing whiteboard element id', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { elementId: 'note-1', content: 'duplicate', x: 80, y: 120 },
        },
        { type: 'text', content: '已有元素 id 不会重复绘制。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({
        whiteboardElements: [
          { id: 'note-1', type: 'text', content: 'existing', left: 80, top: 120 },
        ],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Try drawing with a duplicate id.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      actionWarnings: [
        expect.objectContaining({
          message:
            'Action wb_draw_text skipped because whiteboard element id "note-1" already exists.',
        }),
      ],
    });
  });

  it('continues on an already-open whiteboard instead of sending another wb_open', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_open', params: {} },
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { content: '继续补充机制', x: 120, y: 160 },
        },
        { type: 'text', content: '白板已经开着，我直接在上面补充。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({ whiteboardOpen: true }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Continue on the current board.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_draw_text']);
    expect(result.details).toMatchObject({
      text: '白板已经开着，我直接在上面补充。',
      actionWarnings: [],
    });
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 1 }));
  });

  it('does not auto-clear existing whiteboard content before a fresh-session draw', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { content: '同一话题补充', x: 120, y: 160 },
        },
        { type: 'text', content: '我接着已有白板补充。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: {
        ...makeBody({
          whiteboardOpen: true,
          whiteboardElements: [{ id: 'old-diagram', type: 'text', content: '已有图' }],
        }),
        directorState: {
          turnCount: 1,
          agentResponses: [],
          whiteboardLedger: [],
        },
        piSessionBoundary: {
          isFirstRequestInLiveSession: true,
          previousEndSource: 'manual_stop',
          sameSceneAsPrevious: true,
        },
      },
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 1,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Draw in the new UI session.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_draw_text']);
    expect(onActionDone.mock.calls.map((call) => call[0]?.actionName)).toEqual(['wb_draw_text']);
    expect(result.details).toMatchObject({
      text: '我接着已有白板补充。',
      actionWarnings: [],
    });
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 1 }));
  });

  it('keeps Pi ledger history after wb_clear while treating visible elements as empty', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_open', params: {} },
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { content: '旧内容', x: 80, y: 120 },
        },
        { type: 'action', name: 'wb_clear', params: {} },
        { type: 'action', name: 'wb_delete', params: { elementId: 'old-note' } },
        { type: 'action', name: 'wb_open', params: {} },
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { content: '新内容', x: 80, y: 120 },
        },
        { type: 'text', content: '清空后我直接写新内容，不再重复开板或删除不存在的元素。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Clear and continue briefly.',
    });

    const actionNames = events
      .filter((event) => event.type === 'action')
      .map((event) => event.data.actionName);
    expect(actionNames).toEqual(['wb_open', 'wb_draw_text', 'wb_clear', 'wb_draw_text']);
    expect(onActionDone.mock.calls.map((call) => call[0]?.actionName)).toEqual([
      'wb_open',
      'wb_draw_text',
      'wb_clear',
      'wb_draw_text',
    ]);
    expect(result.details).toMatchObject({
      text: '清空后我直接写新内容，不再重复开板或删除不存在的元素。',
      actionWarnings: [],
    });
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 4 }));
  });

  it('shares whiteboard lifecycle state across child agent turns', async () => {
    mocks.buildAgent
      .mockReturnValueOnce(
        makeMockChildWithJsonOutput(
          JSON.stringify([
            { type: 'action', name: 'wb_open', params: {} },
            {
              type: 'action',
              name: 'wb_draw_text',
              params: { content: 'First turn', x: 80, y: 120, elementId: 'note-1' },
            },
            { type: 'text', content: 'I added the first note.' },
          ]),
        ),
      )
      .mockReturnValueOnce(
        makeMockChildWithJsonOutput(
          JSON.stringify([
            { type: 'action', name: 'wb_clear', params: {} },
            { type: 'action', name: 'wb_open', params: {} },
            { type: 'text', content: 'I cleared the previous note.' },
          ]),
        ),
      );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Add a note.',
    });
    await tool.execute('call-2', {
      agentId: slideTeacher.id,
      instruction: 'Clear the note.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_open', 'wb_draw_text', 'wb_clear']);
  });

  it('preserves the action budget for emitted actions while skipped lifecycle actions do not count', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_open', params: {} },
        { type: 'action', name: 'wb_open', params: {} },
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { content: '第一步', x: 80, y: 120 },
        },
        {
          type: 'action',
          name: 'wb_draw_text',
          params: { content: '第二步', x: 80, y: 180 },
        },
        { type: 'text', content: '动作预算仍然只允许简洁序列。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 2,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Use a concise action sequence.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['wb_open', 'wb_draw_text']);
    expect(result.details).toMatchObject({
      text: '动作预算仍然只允许简洁序列。',
      actionWarnings: [],
    });
    expect(onAgentDone).toHaveBeenCalledWith(expect.objectContaining({ actionCount: 2 }));
  });

  it('validates wb_delete required params', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_delete', params: {} },
        { type: 'text', content: '找不到元素 id 时我不会乱删。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onAgentDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone,
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Delete briefly.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: { messageId: expect.any(String), content: '找不到元素 id 时我不会乱删。' },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '找不到元素 id 时我不会乱删。',
      actionWarnings: [
        {
          actionName: 'wb_delete',
          reason: 'invalid_params',
          message: 'wb_delete requires params.elementId string',
        },
      ],
    });
    expect(onAgentDone).toHaveBeenCalledWith(
      expect.objectContaining({
        actionWarnings: [
          {
            actionName: 'wb_delete',
            reason: 'invalid_params',
            message: 'wb_delete requires params.elementId string',
          },
        ],
      }),
    );
  });

  it('rejects empty and ragged whiteboard tables without emitting actions', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        {
          type: 'action',
          name: 'wb_draw_table',
          params: { x: 80, y: 280, width: 360, height: 120, data: [] },
        },
        {
          type: 'action',
          name: 'wb_draw_table',
          params: { x: 80, y: 280, width: 360, height: 120, data: [[]] },
        },
        {
          type: 'action',
          name: 'wb_draw_table',
          params: {
            x: 80,
            y: 280,
            width: 360,
            height: 120,
            data: [['A', 'B'], ['only A']],
          },
        },
        { type: 'text', content: '无效表格不会写入白板。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Try invalid tables.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      actionWarnings: [
        expect.objectContaining({
          message: 'wb_draw_table requires a non-empty rectangular params.data string matrix',
        }),
      ],
    });
  });

  it('supports the full in-scope whiteboard action surface', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        { type: 'action', name: 'wb_open', params: {} },
        {
          type: 'action',
          name: 'wb_draw_shape',
          params: { shape: 'rectangle', x: 40, y: 60, width: 180, height: 90 },
        },
        {
          type: 'action',
          name: 'wb_draw_chart',
          params: {
            chartType: 'bar',
            x: 250,
            y: 60,
            width: 260,
            height: 160,
            data: { labels: ['树荫', '无遮蔽'], legends: ['温度'], series: [[28, 34]] },
          },
        },
        {
          type: 'action',
          name: 'wb_draw_latex',
          params: { latex: 'Q = mc\\Delta T', x: 80, y: 190 },
        },
        {
          type: 'action',
          name: 'wb_draw_table',
          params: {
            x: 80,
            y: 280,
            width: 360,
            height: 120,
            data: [
              ['位置', '吸热'],
              ['树荫', '低'],
            ],
          },
        },
        {
          type: 'action',
          name: 'wb_draw_line',
          params: { startX: 120, startY: 420, endX: 320, endY: 420, points: ['', 'arrow'] },
        },
        {
          type: 'action',
          name: 'wb_draw_code',
          params: {
            language: 'python',
            code: 'shade = 28\nsun = 34',
            x: 470,
            y: 260,
            fileName: 'temperature.py',
            elementId: 'code-1',
          },
        },
        {
          type: 'action',
          name: 'wb_edit_code',
          params: {
            elementId: 'code-1',
            operation: 'insert_after',
            lineId: 'L2',
            content: 'delta = sun - shade',
          },
        },
        { type: 'text', content: '我用白板把图形、数据、公式和代码都放到同一个解释里。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Use the full whiteboard surface briefly.',
    });

    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual([
      'wb_open',
      'wb_draw_shape',
      'wb_draw_chart',
      'wb_draw_latex',
      'wb_draw_table',
      'wb_draw_line',
      'wb_draw_code',
      'wb_edit_code',
    ]);
    const emittedActions = events.filter((event) => event.type === 'action');
    const drawActions = emittedActions.filter((event) =>
      event.data.actionName.startsWith('wb_draw_'),
    );
    expect(drawActions.every((event) => typeof event.data.params.elementId === 'string')).toBe(
      true,
    );
    expect(
      emittedActions.find((event) => event.data.actionName === 'wb_draw_code')?.data.params,
    ).toMatchObject({ elementId: 'code-1', lineIds: ['L1', 'L2'] });
    expect(
      emittedActions.find((event) => event.data.actionName === 'wb_edit_code')?.data.params,
    ).toMatchObject({ newLineIds: [expect.any(String)] });
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: {
          messageId: expect.any(String),
          content: '我用白板把图形、数据、公式和代码都放到同一个解释里。',
        },
      },
    ]);
    expect(onActionDone).toHaveBeenCalledWith(
      expect.objectContaining({ actionName: 'wb_draw_latex' }),
    );
    expect(onActionDone).toHaveBeenCalledWith(
      expect.objectContaining({ actionName: 'wb_edit_code' }),
    );
    expect(result.details).toMatchObject({
      text: '我用白板把图形、数据、公式和代码都放到同一个解释里。',
      actionWarnings: [],
    });
  });

  it('validates representative full whiteboard params', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        {
          type: 'action',
          name: 'wb_draw_chart',
          params: {
            chartType: 'bar',
            x: 250,
            y: 60,
            width: 260,
            height: 160,
            data: { labels: ['A'], legends: ['B'], series: [['bad']] },
          },
        },
        { type: 'action', name: 'wb_draw_line', params: { startX: 0, startY: 0, endX: 100 } },
        {
          type: 'action',
          name: 'wb_edit_code',
          params: { elementId: 'code-1', operation: 'rewrite_everything' },
        },
        { type: 'text', content: '参数不合法时我会只保留文字说明。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Try invalid whiteboard params.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      {
        type: 'text_delta',
        data: { messageId: expect.any(String), content: '参数不合法时我会只保留文字说明。' },
      },
    ]);
    expect(result.details).toMatchObject({
      text: '参数不合法时我会只保留文字说明。',
      actionWarnings: [
        {
          actionName: 'wb_draw_chart',
          reason: 'invalid_params',
          message: 'wb_draw_chart params.data.series must be a number matrix',
        },
        {
          actionName: 'wb_draw_line',
          reason: 'invalid_params',
          message: 'wb_draw_line requires params.endY number',
        },
        {
          actionName: 'wb_edit_code',
          reason: 'invalid_params',
          message:
            'wb_edit_code requires params.operation insert_after|insert_before|delete_lines|replace_lines',
        },
      ],
    });
  });

  it('requires operation-specific wb_edit_code fields', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        {
          type: 'action',
          name: 'wb_edit_code',
          params: { elementId: 'code-1', operation: 'insert_after', content: 'x = 1' },
        },
        {
          type: 'action',
          name: 'wb_edit_code',
          params: { elementId: 'code-1', operation: 'insert_before', lineId: 'L1' },
        },
        {
          type: 'action',
          name: 'wb_edit_code',
          params: { elementId: 'code-1', operation: 'delete_lines', lineIds: [] },
        },
        {
          type: 'action',
          name: 'wb_edit_code',
          params: { elementId: 'code-1', operation: 'replace_lines', lineIds: ['L1'] },
        },
        { type: 'text', content: '缺少编辑参数时只保留文字说明。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Try incomplete code edits.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(result.details).toMatchObject({
      actionWarnings: [
        expect.objectContaining({
          message: 'wb_edit_code insert_after requires params.lineId string',
        }),
        expect.objectContaining({
          message: 'wb_edit_code insert_before requires params.content string',
        }),
        expect.objectContaining({
          message: 'wb_edit_code delete_lines requires non-empty params.lineIds string array',
        }),
        expect.objectContaining({
          message: 'wb_edit_code replace_lines requires params.content string',
        }),
      ],
    });
  });

  it('skips wb_edit_code when the code element or target line does not exist', async () => {
    mockChildWithJsonOutput(
      JSON.stringify([
        {
          type: 'action',
          name: 'wb_edit_code',
          params: {
            elementId: 'missing-code',
            operation: 'insert_after',
            lineId: 'L1',
            content: 'x = 1',
          },
        },
        {
          type: 'action',
          name: 'wb_edit_code',
          params: {
            elementId: 'code-1',
            operation: 'replace_lines',
            lineIds: ['L99'],
            content: 'x = 2',
          },
        },
        { type: 'text', content: '找不到目标时不执行代码编辑。' },
      ]),
    );

    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const events: StatelessEvent[] = [];
    const onActionDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody({
        whiteboardElements: [
          {
            id: 'code-1',
            type: 'code',
            language: 'python',
            lines: [{ id: 'L1', content: 'x = 0' }],
          },
        ],
      }),
      agentConfigs: [slideTeacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const result = await tool.execute('call-1', {
      agentId: slideTeacher.id,
      instruction: 'Try edits against missing targets.',
    });

    expect(events.filter((event) => event.type === 'action')).toEqual([]);
    expect(onActionDone).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      actionWarnings: [
        expect.objectContaining({
          message: 'Action wb_edit_code skipped because code element "missing-code" was not found.',
        }),
        expect.objectContaining({
          message:
            'Action wb_edit_code skipped because line "L99" was not found in code element "code-1".',
        }),
      ],
    });
  });

  it('records empty child turns and stops after consecutive empties (loop-guard)', async () => {
    // Child that produces no output — simulates a model returning an empty completion.
    mocks.buildAgent.mockReturnValue({
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      state: { messages: [] },
    });
    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const onAgentDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [teacher],
      send: vi.fn(),
      languageModel: {} as never,
      onAgentDone,
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    const call = () => tool.execute('c', { agentId: teacher.id, instruction: 'x' });
    const r1 = (await call()) as { details: Record<string, unknown> };
    const r2 = (await call()) as { details: Record<string, unknown> };
    const r3 = (await call()) as { details: Record<string, unknown> };

    // Empty turns still record via onAgentDone (count toward the turn/retry budget)
    expect(onAgentDone).toHaveBeenCalledTimes(2);
    expect(r1.details.skipped).toBeFalsy();
    expect(r2.details.skipped).toBeFalsy();
    // Third consecutive empty attempt is refused deterministically instead of looping forever
    expect(r3.details).toMatchObject({ skipped: true, reason: 'consecutive_empty_turns' });
  });

  it('treats a thrown child run as an empty turn without escaping execute', async () => {
    mocks.buildAgent.mockReturnValue({
      subscribe: () => () => {},
      prompt: async () => {
        throw new Error('empty completion / stream error');
      },
      waitForIdle: async () => {},
      state: { messages: [] },
    });
    const { buildCallAgentTool } = await import('@/lib/chat/pi/tools/call-agent');
    const onAgentDone = vi.fn();
    const tool = buildCallAgentTool({
      body: makeBody(),
      agentConfigs: [teacher],
      send: vi.fn(),
      languageModel: {} as never,
      onAgentDone,
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });

    // A thrown child must not escape execute; it records an empty turn instead.
    const r1 = (await tool.execute('c', {
      agentId: teacher.id,
      instruction: 'x',
    })) as { details: Record<string, unknown> };
    expect(onAgentDone).toHaveBeenCalledTimes(1);
    expect(r1.details.skipped).toBeFalsy();
  });
});
