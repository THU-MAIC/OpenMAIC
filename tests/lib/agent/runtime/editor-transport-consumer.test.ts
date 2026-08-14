import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModelFromRequest: vi.fn(),
  streamLLM: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: mocks.streamLLM,
  callLLM: mocks.callLLM,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { POST } from '@/app/api/agent/edit/route';

const EDITOR_FLAG = 'NEXT_PUBLIC_MAIC_EDITOR_ENABLED';
const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const resolvedModel = { provider: 'test.provider', modelId: 'editor-model' };
let originalEditorFlag: string | undefined;

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

function makeRequest(): NextRequest {
  return new Request('http://localhost/api/agent/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Read the current slide.',
      scene: { id: 'missing-scene', title: 'Missing' },
      sceneContextMap: {},
    }),
  }) as unknown as NextRequest;
}

async function readSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = await response.text();
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

function toolOutputType(callIndex: number): unknown {
  const params = mocks.streamLLM.mock.calls[callIndex]?.[0] as
    | { messages?: Array<Record<string, unknown>> }
    | undefined;
  const toolMessage = params?.messages?.find((message) => message.role === 'tool') as
    | { content?: Array<{ output?: { type?: string } }> }
    | undefined;
  return toolMessage?.content?.[0]?.output?.type;
}

describe('Editor shared Pi transport consumer', () => {
  beforeEach(() => {
    originalEditorFlag = process.env[EDITOR_FLAG];
    process.env[EDITOR_FLAG] = 'true';
    mocks.resolveModelFromRequest.mockReset();
    mocks.streamLLM.mockReset();
    mocks.callLLM.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: resolvedModel,
      modelInfo: { outputWindow: 512 },
      modelString: 'test:editor-model',
      providerId: 'test',
      modelId: 'editor-model',
      apiKey: '',
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
  });

  afterEach(() => {
    if (originalEditorFlag === undefined) delete process.env[EDITOR_FLAG];
    else process.env[EDITOR_FLAG] = originalEditorFlag;
  });

  it('uses the resolved maic-agent model and carries a strict tool failure as error-text', async () => {
    mocks.streamLLM
      .mockReturnValueOnce(
        resultFrom([
          {
            type: 'tool-call',
            toolCallId: 'editor-read',
            toolName: 'read_scene_content',
            input: { sceneId: 'missing-scene' },
          },
          finish('tool-calls'),
        ]),
      )
      .mockReturnValueOnce(
        resultFrom([{ type: 'text-delta', text: 'The scene is unavailable.' }, finish('stop')]),
      );

    const response = await POST(makeRequest());
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledTimes(1);
    expect(mocks.resolveModelFromRequest.mock.calls[0]?.[2]).toBe('maic-agent');
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(mocks.streamLLM.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: resolvedModel, maxOutputTokens: 512 }),
    );
    expect(mocks.streamLLM.mock.calls[0]?.[1]).toBe('maic-agent');
    expect(toolOutputType(1)).toBe('error-text');
    expect(mocks.callLLM).not.toHaveBeenCalled();

    const toolEnd = events.find((event) => event.type === 'tool_execution_end') as
      | { isError?: boolean; result?: { content?: unknown; details?: unknown } }
      | undefined;
    expect(toolEnd).toMatchObject({
      isError: true,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('scene context not found'),
          },
        ],
        details: {
          sceneId: 'missing-scene',
          title: '',
          type: '',
        },
      },
    });
  });

  it('propagates response cancellation into the active OpenMAIC transport', async () => {
    let transportSignal: AbortSignal | undefined;
    mocks.streamLLM.mockImplementation((params: { abortSignal?: AbortSignal }) => {
      transportSignal = params.abortSignal;
      return {
        fullStream: (async function* () {
          if (!transportSignal?.aborted) {
            await new Promise<void>((resolve) =>
              transportSignal?.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
          yield { type: 'abort', reason: 'editor response cancelled' };
        })(),
        usage: new Promise(() => {}),
      };
    });

    const response = await POST(makeRequest());
    await vi.waitFor(() => expect(mocks.streamLLM).toHaveBeenCalledTimes(1));
    await response.body?.cancel();

    expect(transportSignal?.aborted).toBe(true);
  });
});
