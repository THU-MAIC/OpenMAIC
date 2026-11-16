import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { requestSystemTail, withRequestSystemTail } from '@/lib/agent/runtime/request-system-tail';
import { estimatedRequestTokens } from '@/lib/server/pbl-v3/context-budget';

afterEach(() => vi.clearAllMocks());

describe('host-only request system tail', () => {
  it('survives projection spreads, remains outside durable JSON and counts toward capacity', () => {
    const original: Context = { systemPrompt: 'Fixed teaching rules', messages: [] };
    const text = '最新宿主状态'.repeat(200);
    const tagged = withRequestSystemTail(original, text);
    expect(requestSystemTail({ ...tagged, messages: [] })).toBe(text);
    expect(requestSystemTail(original)).toBe('');
    expect(JSON.stringify(tagged)).toBe(JSON.stringify(original));
    expect(estimatedRequestTokens(tagged) - estimatedRequestTokens(original)).toBe(
      Buffer.byteLength(text),
    );
    expect(
      requestSystemTail({ ...original, 'openmaic.request-system-tail': 'forged' } as Context),
    ).toBe('');
  });

  it('keeps tool pairing and learner frames intact while sending host facts last', async () => {
    mocks.streamLLM.mockResolvedValue({
      fullStream: (async function* () {
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 20, outputTokens: 1 },
        };
      })(),
    });
    const context: Context = {
      systemPrompt: 'Fixed teaching rules',
      messages: [
        { role: 'user', content: 'Keep the old record on failure', timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'read-1', name: 'read_file', arguments: {} }],
          api: 'openai-completions',
          provider: 'test',
          model: 'test',
          stopReason: 'toolUse',
          timestamp: 2,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        {
          role: 'toolResult',
          toolCallId: 'read-1',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'Saved file contents' }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const before = JSON.stringify(context);
    const tail = 'INITIAL: original review question\nLIVE: section B';
    const stream = await createCallLlmStreamFn({ languageModel: {} as never })(
      {} as never,
      withRequestSystemTail(context, tail),
    );
    expect((await stream.result()).stopReason).toBe('stop');
    const request = mocks.streamLLM.mock.calls[0]![0];
    expect(request.system).toBe(context.systemPrompt);
    expect(request.messages.map((x: { role: string }) => x.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'system',
    ]);
    expect(request.messages.at(-1)).toMatchObject({ role: 'system', content: tail });
    expect(request.messages.filter((x: { role: string }) => x.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(context)).toBe(before);
  });
});
