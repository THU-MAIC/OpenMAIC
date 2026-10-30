import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createTeachingContextProjection } from '@/lib/server/pbl-v3/context-projection';
import { currentTeachingContext } from '@/lib/server/pbl-v3/teaching-context';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'test',
  model: 'test',
  stopReason: 'stop',
  timestamp: 0,
  usage,
});
const model = {
  id: 'test',
  name: 'test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  contextWindow: 32000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<Api>;
const window = { stageKey: 'first:3', studentTurns: 1 };
function summarizer(
  text = 'Earlier learner proposed append. A test failed. No new acceptance is established.',
) {
  return vi.fn<StreamFn>((_model, context) => {
    expect(JSON.stringify(context)).not.toContain('Current authoritative policy');
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(model.contextWindow - 4096);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: assistant(text) });
    return stream;
  });
}
const longContext = (): Context => ({
  systemPrompt: 'Current authoritative policy. Approval is version-bound.',
  messages: [
    ...Array.from({ length: 15 }, (_, i) => ({
      role: 'user' as const,
      content: `Historical learner ${i}: ` + '旧内容'.repeat(3000),
      timestamp: i,
    })),
    { role: 'user', content: 'I accept the current version, with no changes.', timestamp: 20 },
  ],
});
describe('model-aware teaching context projection', () => {
  it('leaves ordinary context unchanged without extra model calls', async () => {
    const stream = summarizer(),
      runtime = createTeachingContextProjection(stream);
    const context: Context = {
      systemPrompt: 'Policy',
      messages: [{ role: 'user', content: 'Ready', timestamp: 0 }],
    };
    expect(await runtime.prepare(context, window, model)).toEqual(
      currentTeachingContext(context, window),
    );
    expect(stream).not.toHaveBeenCalled();
    runtime.dispose();
  });
  it('bounds long history and preserves exact latest feedback without mutating durable-source messages', async () => {
    const stream = summarizer(),
      runtime = createTeachingContextProjection(stream),
      context = longContext(),
      before = structuredClone(context);
    const result = await runtime.prepare(context, window, model);
    expect(stream).toHaveBeenCalled();
    expect(result.messages).toContainEqual(context.messages.at(-1));
    expect(result.systemPrompt).toContain('Current authoritative policy');
    expect(result.systemPrompt).toContain('never authoritative learner feedback');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(25000);
    expect(context).toEqual(before);
    const count = stream.mock.calls.length;
    await runtime.prepare(context, window, model);
    expect(stream).toHaveBeenCalledTimes(count);
    runtime.dispose();
  });
  it('also compacts a single long stage instead of depending on a stage transition', async () => {
    const runtime = createTeachingContextProjection(summarizer()),
      context = longContext();
    const result = await runtime.prepare(context, { ...window, studentTurns: 16 }, model);
    expect(result.messages.filter((m) => m.role === 'user').length).toBeLessThan(16);
    expect(result.messages).toContainEqual(context.messages.at(-1));
    runtime.dispose();
  });
  it('retains tool calls and results together while making space for the actual learner input', async () => {
    const runtime = createTeachingContextProjection(summarizer()),
      context = longContext();
    context.messages.push(
      {
        ...assistant(''),
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'read-1', name: 'read_file', arguments: { path: 'src/main.py' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'Observed current source' }],
        isError: false,
        timestamp: 0,
      },
    );
    const result = await runtime.prepare(context, window, model);
    const calls = result.messages.flatMap((m) =>
      m.role === 'assistant' ? m.content.filter((p) => p.type === 'toolCall').map((p) => p.id) : [],
    );
    expect(result.messages.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId)).toEqual(
      calls,
    );
    expect(calls).toEqual(['read-1']);
    runtime.dispose();
  });
  it('refuses an oversized static policy or latest reply before sending any model request', async () => {
    const stream = summarizer(),
      runtime = createTeachingContextProjection(stream);
    await expect(
      runtime.prepare(
        {
          systemPrompt: 'x'.repeat(100000),
          messages: [{ role: 'user', content: 'Ready', timestamp: 0 }],
        },
        window,
        model,
      ),
    ).rejects.toThrow('PBL_CONTEXT_CAPACITY');
    await expect(
      runtime.prepare(
        { messages: [{ role: 'user', content: 'x'.repeat(100000), timestamp: 0 }] },
        window,
        model,
      ),
    ).rejects.toThrow('PBL_CONTEXT_CAPACITY');
    expect(stream).not.toHaveBeenCalled();
    runtime.dispose();
  });
  it('keeps projection caches isolated between role runtimes', async () => {
    const first = summarizer('ROLE ONE ONLY'),
      second = summarizer('ROLE TWO ONLY'),
      a = createTeachingContextProjection(first),
      b = createTeachingContextProjection(second);
    await a.prepare(longContext(), window, model);
    const result = await b.prepare(longContext(), window, model);
    expect(second).toHaveBeenCalled();
    expect(result.systemPrompt).not.toContain('ROLE ONE ONLY');
    a.dispose();
    b.dispose();
  });
  it('does not send an oversized original request after compaction fails', async () => {
    const stream = vi.fn<StreamFn>(() => {
      const result = createAssistantMessageEventStream();
      result.push({
        type: 'error',
        reason: 'error',
        error: { ...assistant(''), stopReason: 'error', errorMessage: 'internal provider failure' },
      });
      return result;
    });
    const runtime = createTeachingContextProjection(stream);
    await expect(runtime.prepare(longContext(), window, model)).rejects.toThrow(
      'PBL_CONTEXT_COMPACTION_FAILED',
    );
    runtime.dispose();
  });
  it('cancels a stalled summary without changing the saved-source conversation', async () => {
    const controller = new AbortController();
    const stalled = createAssistantMessageEventStream();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = createTeachingContextProjection(() => {
      entered();
      return stalled;
    });
    const context = longContext(),
      before = structuredClone(context);
    const pending = runtime.prepare(context, window, model, controller.signal);
    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(context).toEqual(before);
    stalled.push({ type: 'done', reason: 'stop', message: assistant('Late summary') });
    runtime.dispose();
  });
});
