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
import {
  createTeachingContextProjection,
  serializeTeachingHistory,
  readTeachingContextCheckpoint,
  TEACHING_CONTEXT_ENTRY,
  type TeachingContextCheckpoint,
} from '@/lib/server/pbl-v3/context-projection';
import { teachingModelBudget, estimatedRequestTokens } from '@/lib/server/pbl-v3/context-budget';
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
  it('shares a physical input/output allowance, including large and unknown output windows', () => {
    for (const value of [
      model,
      { ...model, contextWindow: 1_048_576, maxTokens: 393_216 },
      { ...model, contextWindow: 1_000_000, maxTokens: Number.NaN },
    ]) {
      const budget = teachingModelBudget(value);
      expect(budget.inputTokens + budget.outputTokens).toBeLessThan(budget.contextWindow);
      expect(budget.outputTokens).toBeLessThanOrEqual(budget.contextWindow / 4);
    }
    expect(teachingModelBudget({ ...model, maxTokens: 0 }).outputTokens).toBe(8000);
  });

  it.each([8192, 16384, 32000])(
    'compacts old history within an actual %i-token summary request without a fixed reserve',
    async (contextWindow) => {
      const target = { ...model, contextWindow };
      const stream = vi.fn<StreamFn>((selected, request) => {
        expect(estimatedRequestTokens(request)).toBeLessThanOrEqual(
          teachingModelBudget(selected).inputTokens,
        );
        const result = createAssistantMessageEventStream();
        result.push({
          type: 'done',
          reason: 'stop',
          message: assistant('Earlier discussion summarized.'),
        });
        return result;
      });
      const runtime = createTeachingContextProjection(stream);
      const latest = { role: 'user' as const, content: 'Please continue.', timestamp: 1 };
      const context: Context = {
        systemPrompt: 'Current authoritative policy',
        messages: [
          {
            role: 'user',
            content: '\\"\n中文🧠 Earlier relevant discussion. '.repeat(1500),
            timestamp: 0,
          },
          latest,
        ],
      };
      try {
        expect(estimatedRequestTokens({ ...context, messages: [latest] })).toBeLessThan(
          teachingModelBudget(target).inputTokens,
        );
        const projected = await runtime.prepare(context, { ...window, studentTurns: 2 }, target);
        expect(projected.messages).toContainEqual(latest);
        expect(stream).toHaveBeenCalled();
        expect(estimatedRequestTokens(projected)).toBeLessThanOrEqual(
          teachingModelBudget(target).inputTokens,
        );
      } finally {
        runtime.dispose();
      }
    },
  );
  it('restores a checkpoint after restart and across stages without resummarizing old dialogue', async () => {
    let checkpoint: TeachingContextCheckpoint | undefined;
    const original = longContext(),
      before = structuredClone(original);
    const first = createTeachingContextProjection(
      summarizer('Observed previous work; approval must be revalidated.'),
      {
        saveCheckpoint: async (value) => {
          checkpoint = structuredClone(value);
        },
      },
    );
    await first.prepare(original, window, model);
    first.dispose();
    expect(checkpoint).toBeDefined();
    const restored = readTeachingContextCheckpoint([
      {
        type: 'custom',
        id: 'derived',
        parentId: 'raw',
        timestamp: new Date().toISOString(),
        customType: TEACHING_CONTEXT_ENTRY,
        data: checkpoint,
      },
    ]);
    const next = summarizer(),
      runtime = createTeachingContextProjection(next, { checkpoint: restored });
    const input = {
      role: 'user' as const,
      content: 'Which part should I review next?',
      timestamp: 21,
    };
    const context = {
      ...original,
      systemPrompt: 'NEW stage and file version; no approval.',
      messages: [...original.messages, input],
    };
    const projected = await runtime.prepare(
      context,
      { stageKey: 'second:3', studentTurns: 1 },
      model,
    );
    expect(next).not.toHaveBeenCalled();
    expect(projected.messages).toContainEqual(input);
    expect(projected.systemPrompt).toContain('NEW stage and file version; no approval.');
    expect(projected.systemPrompt).toContain('Observed previous work');
    expect(original).toEqual(before);
    runtime.dispose();
  });

  it('extends a checkpoint using only new history and rejects a mismatched source prefix', async () => {
    let checkpoint: TeachingContextCheckpoint | undefined;
    const context = longContext(),
      first = createTeachingContextProjection(summarizer('Initial evidence summary'), {
        saveCheckpoint: async (value) => {
          checkpoint = value;
        },
      });
    await first.prepare(context, window, model);
    first.dispose();
    const covered = checkpoint!.coveredMessages;
    const more = {
      ...context,
      messages: [
        ...context.messages,
        { role: 'user' as const, content: 'NEW HISTORY '.repeat(6000), timestamp: 21 },
        { role: 'user' as const, content: 'Please explain this revision.', timestamp: 22 },
      ],
    };
    const next = summarizer('Updated evidence summary');
    const resumed = createTeachingContextProjection(next, { checkpoint });
    await resumed.prepare(more, window, model);
    const sent = JSON.stringify(next.mock.calls.map((call) => call[1]));
    expect(sent).not.toContain('Historical learner 0:');
    expect(sent).toContain('NEW HISTORY');
    expect(covered).toBeGreaterThan(0);
    resumed.dispose();
    const changed = structuredClone(context);
    changed.messages[0] = {
      role: 'user',
      content: 'DIFFERENT ROLE HISTORY '.repeat(2000),
      timestamp: 0,
    };
    const fresh = summarizer('Recomputed facts'),
      other = createTeachingContextProjection(fresh, { checkpoint });
    const result = await other.prepare(changed, window, model);
    expect(fresh).toHaveBeenCalled();
    expect(result.systemPrompt).not.toContain('Initial evidence summary');
    other.dispose();
  });

  it('summarizes full tool-result tails with identities and excludes unverified old thinking', async () => {
    const tool: Context['messages'][number] = {
      role: 'toolResult',
      toolCallId: 'long-test',
      toolName: 'collect_build',
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'stdout '.repeat(15000) +
            'TAIL: failing check delete zero; revision=19; hash=actual-file',
        },
      ],
      timestamp: 0,
    };
    const source: Context['messages'] = [
      { role: 'user', content: 'Review the real result.', timestamp: 0 },
      {
        ...assistant(''),
        content: [
          { type: 'thinking', thinking: 'UNVERIFIED OLD GUESS' },
          {
            type: 'toolCall',
            id: 'long-test',
            name: 'collect_build',
            arguments: { commandId: 'existing-command' },
          },
        ],
      },
      tool,
      { role: 'user', content: 'Why did this check fail?', timestamp: 1 },
    ];
    const serial = serializeTeachingHistory(source);
    expect(serial).toContain('TAIL: failing check delete zero');
    expect(serial).toContain('existing-command');
    expect(serial).toContain('"isError":true');
    expect(serial).not.toContain('UNVERIFIED OLD GUESS');
    const stream = summarizer(),
      runtime = createTeachingContextProjection(stream);
    const result = await runtime.prepare(
      { systemPrompt: 'Current authoritative policy', messages: source },
      { ...window, studentTurns: 2 },
      model,
    );
    expect(JSON.stringify(stream.mock.calls.map((call) => call[1]))).toContain(
      'TAIL: failing check delete zero',
    );
    expect(result.messages).toEqual([source.at(-1)]);
    expect(estimatedRequestTokens(result)).toBeLessThan(teachingModelBudget(model).inputTokens);
    runtime.dispose();
  });

  it('includes the growing previous summary in every small-window chunk budget', async () => {
    const target = { ...model, contextWindow: 8192 };
    const saved = vi.fn();
    const stream = vi.fn<StreamFn>((selected, request, options) => {
      expect(estimatedRequestTokens(request)).toBeLessThanOrEqual(
        teachingModelBudget(selected).inputTokens,
      );
      expect(options?.maxTokens).toBe(selected.maxTokens);
      expect(options?.reasoning).toBeUndefined();
      const payload = JSON.parse(request.messages[0]!.content as string);
      expect(payload.history.isWellFormed()).toBe(true);
      if (stream.mock.calls.length > 1)
        expect(payload.previousSummary).toBe('Known learner choice. '.repeat(45));
      const result = createAssistantMessageEventStream();
      result.push({
        type: 'done',
        reason: 'stop',
        message: assistant('Known learner choice. '.repeat(45)),
      });
      return result;
    });
    const runtime = createTeachingContextProjection(stream, { saveCheckpoint: saved });
    try {
      const context: Context = {
        systemPrompt: 'Policy',
        messages: [
          { role: 'user', content: '\\"\n中文🧠'.repeat(7000), timestamp: 0 },
          { role: 'user', content: 'Please continue.', timestamp: 1 },
        ],
      };
      await runtime.prepare(context, { ...window, studentTurns: 2 }, target);
      expect(stream.mock.calls.length).toBeGreaterThan(2);
      expect(saved).toHaveBeenCalledOnce();
    } finally {
      runtime.dispose();
    }
  });
  it('does not publish a checkpoint after summary cancellation or a failed durable append', async () => {
    const save = vi.fn(async () => {
      throw new Error('lease lost during checkpoint append');
    });
    const runtime = createTeachingContextProjection(summarizer(), { saveCheckpoint: save });
    const context = longContext(),
      before = structuredClone(context);
    await expect(runtime.prepare(context, window, model)).rejects.toThrow('lease lost');
    expect(save).toHaveBeenCalledOnce();
    expect(context).toEqual(before);
    runtime.dispose();
    const controller = new AbortController(),
      cancelledSave = vi.fn();
    const stream = summarizer();
    stream.mockImplementation(() => {
      controller.abort();
      const result = createAssistantMessageEventStream();
      result.push({ type: 'done', reason: 'stop', message: assistant('Late summary') });
      return result;
    });
    const cancelled = createTeachingContextProjection(stream, { saveCheckpoint: cancelledSave });
    await expect(cancelled.prepare(context, window, model, controller.signal)).rejects.toThrow();
    expect(cancelledSave).not.toHaveBeenCalled();
    cancelled.dispose();
  });
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
    expect(result.systemPrompt).toContain('not current learner feedback');
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
  it('budgets escaped code and multilingual text in summary requests as well as the teaching request', async () => {
    const stream = summarizer(),
      runtime = createTeachingContextProjection(stream);
    const context: Context = {
      systemPrompt: 'Current authoritative policy',
      messages: [
        { role: 'user', content: '\\"\n中文🧠'.repeat(6000), timestamp: 0 },
        { role: 'user', content: 'Review the unchanged current file.', timestamp: 1 },
      ],
    };
    const projected = await runtime.prepare(context, { ...window, studentTurns: 2 }, model);
    expect(stream).toHaveBeenCalled();
    for (const [target, request] of stream.mock.calls)
      expect(estimatedRequestTokens(request)).toBeLessThanOrEqual(
        teachingModelBudget(target).inputTokens,
      );
    expect(estimatedRequestTokens(projected)).toBeLessThanOrEqual(
      teachingModelBudget(model).inputTokens,
    );
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
  it('refuses a nonempty token-truncated summary instead of persisting partial memory', async () => {
    const save = vi.fn();
    const runtime = createTeachingContextProjection(
      () => {
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: 'done',
          reason: 'length',
          message: { ...assistant('Incomplete prior facts'), stopReason: 'length' },
        });
        return stream;
      },
      { saveCheckpoint: save },
    );
    await expect(runtime.prepare(longContext(), window, model)).rejects.toThrow(
      'PBL_CONTEXT_COMPACTION_FAILED',
    );
    expect(save).not.toHaveBeenCalled();
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
