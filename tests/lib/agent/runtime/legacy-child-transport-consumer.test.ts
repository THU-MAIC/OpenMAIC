import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const resolvedModel = { provider: 'test.provider', modelId: 'child-model' };
const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_open'],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

function finish(finishReason: string) {
  return { type: 'finish', finishReason, totalUsage: ZERO_USAGE };
}

function parsedToolCall() {
  return {
    type: 'tool-call',
    toolCallId: 'unexpected-pi-tool',
    toolName: 'unexpected_tool',
    input: {},
  };
}

function resultFrom(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: new Promise(() => {}),
  };
}

function makeBody(): StatelessChatRequest {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Open the whiteboard.' }],
      },
    ],
    storeState: {
      stage: {
        id: 'stage-1',
        name: 'Transport test',
        createdAt: 1,
        updatedAt: 2,
        whiteboard: [],
      },
      outlines: [],
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          title: 'Lesson',
          order: 1,
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } as never },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: { agentIds: [teacher.id], agentConfigs: [teacher] },
    apiKey: '',
  } as StatelessChatRequest;
}

function makeHarness() {
  const events: StatelessEvent[] = [];
  const summaries: AgentTurnSummary[] = [];
  const onActionDone = vi.fn();
  const abortController = new AbortController();
  const tool = buildCallAgentTool({
    body: makeBody(),
    agentConfigs: [teacher],
    send: async (event) => {
      events.push(event);
    },
    languageModel: resolvedModel as never,
    onAgentDone: (summary) => summaries.push(summary),
    onActionDone,
    thinkingConfig: { mode: 'disabled', enabled: false },
    maxOutputTokens: 384,
    abortSignal: abortController.signal,
    maxAgentTurns: 3,
    getAgentTurnCount: () => summaries.length,
    getAgentResponses: () => summaries,
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: 2,
    enableWhiteboardTools: true,
  });
  return { events, summaries, onActionDone, tool };
}

async function execute(harness: ReturnType<typeof makeHarness>) {
  return harness.tool.execute('delegate-1', {
    agentId: teacher.id,
    instruction: 'Teach briefly.',
  });
}

function actionOutput(text = 'I opened the board.') {
  return JSON.stringify([
    { type: 'action', name: 'wb_open', params: {} },
    { type: 'text', content: text },
  ]);
}

describe('Legacy Pi Child shared transport consumer', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('makes length plus a parsed Pi tool call terminal without action or continuation', async () => {
    mocks.streamLLM.mockReturnValue(resultFrom([parsedToolCall(), finish('length')]));
    const harness = makeHarness();

    await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(mocks.streamLLM.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: resolvedModel, maxOutputTokens: 384 }),
    );
    expect(mocks.streamLLM.mock.calls[0]?.[1]).toBe('pi-chat-child');
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(harness.events.filter((event) => event.type === 'action')).toEqual([]);
    expect(harness.summaries).toEqual([
      expect.objectContaining({ agentId: teacher.id, actionCount: 0, contentPreview: '' }),
    ]);
  });

  it('preserves ordinary streamed-text action accounting through the real shared loop', async () => {
    mocks.streamLLM.mockReturnValue(
      resultFrom([{ type: 'text-delta', text: actionOutput() }, finish('stop')]),
    );
    const harness = makeHarness();

    const result = await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(harness.events.filter((event) => event.type === 'action')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ actionName: 'wb_open' }) }),
    ]);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.summaries).toEqual([
      expect.objectContaining({
        agentId: teacher.id,
        actionCount: 1,
        contentPreview: 'I opened the board.',
      }),
    ]);
    expect(result.details).toEqual(
      expect.objectContaining({ text: 'I opened the board.', actionWarnings: [] }),
    );
  });

  it('does not roll back a streamed Legacy action seen before length plus parsed toolCall', async () => {
    mocks.streamLLM.mockReturnValue(
      resultFrom([
        { type: 'text-delta', text: actionOutput('Action arrived before truncation.') },
        parsedToolCall(),
        finish('length'),
      ]),
    );
    const harness = makeHarness();

    await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.events.filter((event) => event.type === 'action')).toHaveLength(1);
    expect(harness.summaries).toEqual([
      expect.objectContaining({
        agentId: teacher.id,
        actionCount: 1,
        contentPreview: 'Action arrived before truncation.',
      }),
    ]);
  });
});
