import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({
  streamLLM: vi.fn(),
  injectOwnErrorWithOkStatus: false,
}));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

vi.mock('@/lib/chat/pi/tools/read-scene', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/pi/tools/read-scene')>();
  return {
    ...actual,
    buildReadSceneTool: vi.fn((options: Parameters<typeof actual.buildReadSceneTool>[0]) => {
      const tool = actual.buildReadSceneTool(options);
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        execute: async (...args: Parameters<typeof tool.execute>) => {
          if (!mocks.injectOwnErrorWithOkStatus) return execute(...args);
          return {
            content: [{ type: 'text' as const, text: 'Synthetic own-marker failure.' }],
            details: {
              status: 'ok' as const,
              sceneId: 'synthetic-marker',
              source: 'request_start_snapshot' as const,
              truncated: false as const,
            },
            isError: true,
          };
        },
      };
    }),
  };
});

import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const resolvedModel = { provider: 'test.provider', modelId: 'director-model' };
const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#3366ff',
  allowedActions: [],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

function finish(finishReason: string) {
  return { type: 'finish', finishReason, totalUsage: ZERO_USAGE };
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
        parts: [{ type: 'text', text: 'Read the missing scene.' }],
      },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'Transport test', createdAt: 1, updatedAt: 2 },
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

function toolOutput(callIndex: number): { type?: string; value?: string } | undefined {
  const params = mocks.streamLLM.mock.calls[callIndex]?.[0] as
    | { messages?: Array<Record<string, unknown>> }
    | undefined;
  const toolMessage = params?.messages?.find((message) => message.role === 'tool') as
    | { content?: Array<{ output?: { type?: string; value?: string } }> }
    | undefined;
  return toolMessage?.content?.[0]?.output;
}

describe('Director shared Pi transport consumer', () => {
  beforeEach(() => {
    mocks.streamLLM.mockReset();
    mocks.injectOwnErrorWithOkStatus = false;
  });

  it('uses the resolved chat model and traces a normalized evidence failure unchanged', async () => {
    mocks.streamLLM
      .mockReturnValueOnce(
        resultFrom([
          {
            type: 'tool-call',
            toolCallId: 'director-read',
            toolName: 'read_scene',
            input: { sceneId: 'missing-scene' },
          },
          finish('tool-calls'),
        ]),
      )
      .mockReturnValueOnce(
        resultFrom([
          { type: 'text-delta', text: 'The requested scene does not exist.' },
          finish('stop'),
        ]),
      );
    const events: StatelessEvent[] = [];
    const abortController = new AbortController();

    await runPiDirectorLoop({
      body: makeBody(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: resolvedModel as never,
      thinkingConfig: { mode: 'disabled', enabled: false },
      maxOutputTokens: 640,
      abortSignal: abortController.signal,
      signal: abortController.signal,
      maxAgentTurns: 2,
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
    });

    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(mocks.streamLLM.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: resolvedModel, maxOutputTokens: 640 }),
    );
    expect(mocks.streamLLM.mock.calls[0]?.[1]).toBe('pi-chat-director');
    expect(toolOutput(1)).toEqual({
      type: 'error-text',
      value: expect.stringContaining('was not found in the request-start course snapshot'),
    });

    const done = events.find((event) => event.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.data.directorToolTrace).toEqual([
      expect.objectContaining({
        sequence: 1,
        toolName: 'read_scene',
        args: { sceneId: 'missing-scene' },
        isError: true,
        resultPreview: expect.stringContaining('was not found'),
        details: {
          status: 'not_found',
          sceneId: 'missing-scene',
          source: 'request_start_snapshot',
          truncated: false,
        },
      }),
    ]);
  });

  it('sees own-marker normalization before the Director evidence fallback', async () => {
    mocks.injectOwnErrorWithOkStatus = true;
    mocks.streamLLM
      .mockReturnValueOnce(
        resultFrom([
          {
            type: 'tool-call',
            toolCallId: 'director-marker',
            toolName: 'read_scene',
            input: { sceneId: 'synthetic-marker' },
          },
          finish('tool-calls'),
        ]),
      )
      .mockReturnValueOnce(
        resultFrom([{ type: 'text-delta', text: 'Failure acknowledged.' }, finish('stop')]),
      );
    const events: StatelessEvent[] = [];
    const abortController = new AbortController();

    await runPiDirectorLoop({
      body: makeBody(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: resolvedModel as never,
      thinkingConfig: { mode: 'disabled', enabled: false },
      maxOutputTokens: 640,
      abortSignal: abortController.signal,
      signal: abortController.signal,
      maxAgentTurns: 2,
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
    });

    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(toolOutput(1)).toEqual({
      type: 'error-text',
      value: 'Synthetic own-marker failure.',
    });

    const done = events.find((event) => event.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('expected done event');
    expect(done.data.directorToolTrace).toEqual([
      expect.objectContaining({
        sequence: 1,
        toolName: 'read_scene',
        args: { sceneId: 'synthetic-marker' },
        isError: true,
        resultPreview: 'Synthetic own-marker failure.',
        details: {
          status: 'ok',
          sceneId: 'synthetic-marker',
          source: 'request_start_snapshot',
          truncated: false,
        },
      }),
    ]);
  });
});
