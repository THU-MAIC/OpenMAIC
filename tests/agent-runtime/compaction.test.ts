/**
 * Agent runtime compaction: the shared pi-native compaction runtime wired
 * through the agent-runtime adapter (lib/server/agent-runtime/compaction.ts).
 *
 * Pins the runner-relevant contract:
 *  - transformContext compresses when the transcript crosses the window;
 *  - it passes the transcript through unchanged below the threshold;
 *  - the compacted sequence is LLM-legal through pi's convertToLlm (the
 *    compactionSummary entry becomes a leading user message);
 *  - transformContext never mutates its input, so the checkpointed transcript
 *    keeps the raw, uncompacted form.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  convertToLlm,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  InMemorySessionRepo,
  Session,
  shouldCompact,
  type AgentMessage,
  type SessionStorage,
  type SessionTreeEntry,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { PROVIDERS } from '@/lib/ai/providers';
import {
  estimateFullContextTokens,
  MAX_SUMMARY_CHUNK_CALLS,
  resolveCompactionKeepRecentTokens,
  resolveCompactionTargetTokens,
} from '@/lib/agent/runtime/compaction-runtime';
import { createAgentCompactionRuntime } from '@/lib/server/agent-runtime/compaction';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function summaryStream(summary: string, callCount: () => void): StreamFn {
  return ((_model, _context, _options) => {
    callCount();
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: summary }],
      api: 'test',
      provider: 'test',
      model: 'test-summary',
      usage: EMPTY_USAGE,
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
    return stream;
  }) as StreamFn;
}

function assistantText(text: string, timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp,
  } as AgentMessage;
}

function longHistory(): AgentMessage[] {
  return Array.from({ length: 10 }, (_, index) => ({
    role: 'user' as const,
    content: `history-${index}: ${'important course evidence '.repeat(35)}`,
    timestamp: index,
  }));
}

describe('agent runtime compaction runtime', () => {
  it('compacts after a smaller-window switch and restores the saved summary on the next run', async () => {
    // Synthetic windows isolate budget switching; these are not supplier limits.
    const session = await new InMemorySessionRepo().create();
    const raw = longHistory();
    const snapshot = structuredClone(raw);
    for (const message of raw) await session.appendMessage(message);
    const summarize = vi.fn();
    const makeRuntime = (currentSession: typeof session, contextWindow: number) =>
      createAgentCompactionRuntime({
        streamFn: summaryStream('Course facts and pending task preserved.', summarize),
        contextWindow,
        reservedOutputTokens: 120,
        settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
        budgetMessages: convertToLlm,
        compactionSession: { required: true, acquire: async () => currentSession },
      });

    const large = makeRuntime(session, 128_000);
    expect(await large.transformContext(raw)).toEqual(raw);
    expect(summarize).not.toHaveBeenCalled();
    large.dispose();

    const small = makeRuntime(session, 1_200);
    const compacted = await small.transformContext(raw);
    // The tiny synthetic window forces the summarized history into chunks.
    const summaryCalls = summarize.mock.calls.length;
    expect(summaryCalls).toBeGreaterThan(0);
    expect(small.getTrace().summaryCalls).toBe(summaryCalls);
    expect(compacted[0]?.role).toBe('compactionSummary');
    expect(estimateFullContextTokens({ messages: convertToLlm(compacted) })).toBeLessThan(1_080);
    expect(raw).toEqual(snapshot);
    const entries = await session.getEntries();
    expect(entries.filter((entry) => entry.type === 'message')).toHaveLength(raw.length);
    expect(entries.filter((entry) => entry.type === 'compaction')).toHaveLength(1);
    small.dispose();

    // Rehydrate serialized entries into a new Session/runtime, as a subsequent
    // worker would; this is an in-memory storage contract, not a PostgreSQL test.
    const restoreStorage = (await new InMemorySessionRepo().create()).getStorage();
    for (const entry of structuredClone(entries)) await restoreStorage.appendEntry(entry);
    const restored = new Session(restoreStorage);
    expect((await restored.buildContext()).messages).toEqual(compacted);
    const followup: AgentMessage = {
      role: 'user',
      content: 'Continue the pending task.',
      timestamp: 20,
    };
    await restored.appendMessage(followup);
    for (const window of [1_200, 128_000]) {
      const resumed = makeRuntime(restored, window);
      const view = await resumed.transformContext((await restored.buildContext()).messages);
      expect(view).toEqual([...compacted, followup]);
      expect(resumed.getTrace().triggerCount).toBe(0);
      expect(summarize).toHaveBeenCalledTimes(summaryCalls);
      resumed.dispose();
    }
    expect(
      (await restored.getEntries()).filter((entry) => entry.type === 'compaction'),
    ).toHaveLength(1);
  });

  it('estimates all message fields plus system and tool schemas without a CJK blind spot', () => {
    const chinese = '真实中文上下文'.repeat(600);
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'tiny anchored response' }],
        usage: { ...EMPTY_USAGE, input: 50, output: 10, totalTokens: 60 },
        stopReason: 'stop',
      },
      {
        role: 'toolResult',
        toolCallId: 'large-result',
        toolName: 'read_scene',
        content: [{ type: 'text', text: 'short visible content' }],
        details: { fullDocument: chinese },
        isError: false,
      },
    ] as unknown as AgentMessage[];
    const messageOnly = estimateFullContextTokens({ messages });
    const full = estimateFullContextTokens({
      messages,
      systemPrompt: chinese,
      tools: [
        {
          name: 'read_scene',
          description: chinese,
          parameters: { type: 'object', properties: { sceneId: { type: 'string' } } },
        },
      ],
    });

    // Three independent CJK payloads are counted at roughly one token/code
    // point, rather than the old usage anchor (60) or chars/4 estimate.
    expect(messageOnly).toBeGreaterThan(4_000);
    expect(full).toBeGreaterThan(messageOnly * 2.5);
    expect(full).toBeLessThan(messageOnly * 3.5);
  });

  it('compacts when the transcript crosses the window threshold', async () => {
    const onSummaryCall = vi.fn();
    const onCompaction = vi.fn();
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('Goal: keep stage-2 facts and pending ask_user.', onSummaryCall),
      contextWindow: 600,
      reservedOutputTokens: 200,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      onCompaction,
    });
    const history = longHistory();

    const compacted = await runtime.transformContext(history);
    const trace = runtime.getTrace();
    const event = trace.events[0];

    expect(compacted[0]?.role).toBe('compactionSummary');
    expect(compacted.length).toBeLessThan(history.length);
    expect(onSummaryCall).toHaveBeenCalledTimes(1);
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(onCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining('stage-2') }),
    );
    expect(trace).toMatchObject({
      contextWindow: 600,
      checkCount: 1,
      triggerCount: 1,
      failures: [],
    });
    expect(event).toBeDefined();
    expect(event?.tokensBefore).toBeGreaterThan(event?.tokensAfter ?? Number.MAX_SAFE_INTEGER);
    expect(event?.messagesBefore).toBeGreaterThan(event?.messagesAfter ?? Number.MAX_SAFE_INTEGER);
    expect(event?.firstKeptEntryId).toBeTruthy();
    expect(event?.summary).toContain('stage-2');
    runtime.dispose();
  });

  it('reads the durable in-memory PG session view but appends no boundary below threshold', async () => {
    const onSummaryCall = vi.fn();
    const session = await new InMemorySessionRepo().create({ id: 'short-tree' });
    const history: AgentMessage[] = [{ role: 'user', content: 'short question', timestamp: 1 }];
    await session.appendMessage(history[0]!);
    const acquire = vi.fn(async () => session);
    const append = vi.spyOn(session.getStorage(), 'appendEntry');
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', onSummaryCall),
      contextWindow: 128_000,
      compactionSession: { acquire },
    });

    const transformed = await runtime.transformContext(history);

    expect(transformed).toEqual(history);
    expect(runtime.getTrace()).toMatchObject({ checkCount: 1, triggerCount: 0, events: [] });
    expect(onSummaryCall).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('emits an LLM-legal message sequence after compaction (leading summary user message)', async () => {
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('Summary of the compacted tail.', vi.fn()),
      contextWindow: 600,
      reservedOutputTokens: 200,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
    });

    const compacted = await runtime.transformContext(longHistory());
    const llm = convertToLlm(compacted);

    // The compactionSummary entry must convert to a leading USER message with
    // the "history compacted" preamble — the first thing the model reads.
    expect(llm.length).toBeGreaterThan(0);
    expect(llm[0]?.role).toBe('user');
    const firstText = (llm[0]!.content as { type: string; text: string }[])
      .map((block) => block.text)
      .join('');
    expect(firstText).toContain('compacted into the following summary');
    expect(firstText).toContain('Summary of the compacted tail.');
    // No custom role may leak into the LLM request, and nothing may precede
    // the summary message.
    const roles = llm.map((message) => message.role);
    expect(roles.every((role) => ['user', 'assistant', 'toolResult'].includes(role))).toBe(true);
    expect(roles).not.toContain('compactionSummary');
    runtime.dispose();
  });

  it('never mutates the input transcript (checkpoint stays raw)', async () => {
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused summary', vi.fn()),
      contextWindow: 600,
      reservedOutputTokens: 200,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
    });
    const history = longHistory();
    const snapshot = history.map((message) => ({ ...message }));

    await runtime.transformContext(history);

    expect(history).toEqual(snapshot);
    expect(history.some((message) => message.role === 'compactionSummary')).toBe(false);
    runtime.dispose();
  });

  it('lossily shrinks a pi no-op cut whose tail is oversized tool results', async () => {
    const onSummaryCall = vi.fn();
    const systemPrompt = '系统规则';
    const tools = [{ name: 'read_scene', description: 'read', parameters: { type: 'object' } }];
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('must not be called for an empty cut', onSummaryCall),
      contextWindow: 2_000,
      settings: { enabled: true, reserveTokens: 400, keepRecentTokens: 500 },
      systemPrompt,
      tools,
    });
    const assistant = {
      role: 'assistant',
      content: Array.from({ length: 4 }, (_, index) => ({
        type: 'toolCall',
        id: `call-${index}`,
        name: 'read_scene',
        arguments: { sceneId: `scene-${index}` },
      })),
      stopReason: 'toolUse',
      usage: EMPTY_USAGE,
    } as unknown as AgentMessage;
    const history: AgentMessage[] = [
      { role: 'user', content: '读取这些场景', timestamp: 1 },
      assistant,
      ...Array.from(
        { length: 4 },
        (_, index) =>
          ({
            role: 'toolResult',
            toolCallId: `call-${index}`,
            toolName: 'read_scene',
            content: [{ type: 'text', text: '场景正文'.repeat(1_200) }],
            details: { rawScene: '场景详情'.repeat(1_200) },
            isError: false,
            timestamp: index + 2,
          }) as unknown as AgentMessage,
      ),
    ];

    const before = estimateFullContextTokens({ messages: history, systemPrompt, tools });
    const transformed = await runtime.transformContext(history);
    const after = estimateFullContextTokens({ messages: transformed, systemPrompt, tools });

    expect(before).toBeGreaterThan(20_000);
    expect(after).toBeLessThan(1_600);
    expect(after).toBeLessThan(before);
    expect(transformed).not.toEqual(history);
    expect(transformed[0]?.role).toBe('compactionSummary');
    expect(JSON.stringify(transformed)).toContain('Oversized historical content omitted');
    expect(onSummaryCall).not.toHaveBeenCalled();
    expect(runtime.getTrace()).toMatchObject({ triggerCount: 1 });
    runtime.dispose();
  });

  it('fails compaction when the required CompactionEntry INSERT fails', async () => {
    const session = await new InMemorySessionRepo().create({ id: 'compaction-write-failure' });
    const raw = longHistory();
    for (const message of raw) await session.appendMessage(message);
    const storage = session.getStorage() as SessionStorage;
    const realAppend = storage.appendEntry.bind(storage);
    vi.spyOn(storage, 'appendEntry').mockImplementation(async (entry: SessionTreeEntry) => {
      if (entry.type === 'compaction') throw new Error('PG CompactionEntry INSERT failed');
      await realAppend(entry);
    });
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('Durable summary: stage-2 remains active.', vi.fn()),
      contextWindow: 600,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      compactionSession: { required: true, acquire: async () => session },
    });

    await expect(runtime.transformContext(raw)).rejects.toThrow('PG CompactionEntry INSERT failed');
    expect(runtime.getTrace().failures).toContain('PG CompactionEntry INSERT failed');
    expect((await session.getEntries()).some((entry) => entry.type === 'compaction')).toBe(false);
    runtime.dispose();
  });

  it('blocks an oversized required context when summary fails without altering history', async () => {
    const session = await new InMemorySessionRepo().create({ id: 'summary-provider-failure' });
    const raw = longHistory();
    for (const message of raw) await session.appendMessage(message);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createAgentCompactionRuntime({
      streamFn: (() => {
        throw new Error('summary provider unavailable');
      }) as StreamFn,
      contextWindow: 600,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      compactionSession: { required: true, acquire: async () => session },
    });

    await expect(runtime.transformContext(raw)).rejects.toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect((await session.buildContext()).messages).toEqual(raw);
    expect(runtime.getTrace()).toMatchObject({
      triggerCount: 0,
      lastSummaryFailure: {
        errorName: 'Error',
        timeoutOrAbort: false,
        modelRoute: 'agent-runtime',
      },
    });
    expect((await session.getEntries()).some((entry) => entry.type === 'compaction')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[compaction] summary failed; checking context budget',
      expect.objectContaining({ errorName: 'Error', timeoutOrAbort: false }),
    );
    runtime.dispose();
    warn.mockRestore();
  });

  it('does not persist or return a successful summary which is still over budget', async () => {
    const session = await new InMemorySessionRepo().create();
    const raw = longHistory();
    for (const message of raw) await session.appendMessage(message);
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('oversized summary '.repeat(1000), vi.fn()),
      contextWindow: 600,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      compactionSession: { required: true, acquire: async () => session },
    });
    await expect(runtime.transformContext(raw)).rejects.toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect((await session.getEntries()).filter((e) => e.type === 'compaction')).toHaveLength(0);
    expect((await session.buildContext()).messages).toEqual(raw);
    expect(runtime.getTrace().triggerCount).toBe(0);
    runtime.dispose();
    // Re-acquiring the unchanged tree with a healthy summary can recover.
    const retry = createAgentCompactionRuntime({
      streamFn: summaryStream('short summary', vi.fn()),
      contextWindow: 600,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      compactionSession: { required: true, acquire: async () => session },
    });
    const recovered = await retry.transformContext(raw);
    expect(estimateFullContextTokens({ messages: recovered })).toBeLessThan(480);
    expect((await session.buildContext()).messages).toEqual(recovered);
    retry.dispose();
  });

  it('logs a summary failure as metadata without conversation text', async () => {
    const session = await new InMemorySessionRepo().create();
    const raw = longHistory();
    for (const message of raw) await session.appendMessage(message);
    // A multiline quote of two history messages, as a provider might echo it.
    const secret = `${String((raw[3] as { content: unknown }).content)}\n\n${String(
      (raw[4] as { content: unknown }).content,
    )}`;
    const failWith = (errorMessage: string) =>
      (() => {
        const stream = createAssistantMessageEventStream();
        const error: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: 'test',
          provider: 'test',
          model: 'test',
          usage: EMPTY_USAGE,
          stopReason: 'error',
          errorMessage,
          timestamp: 1,
        };
        queueMicrotask(() => stream.push({ type: 'error', reason: 'error', error }));
        return stream;
      }) as StreamFn;
    const run = async (streamFn: StreamFn) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const runtime = createAgentCompactionRuntime({
        streamFn,
        contextWindow: 600,
        settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
        modelRouteLabel: 'agent slot model test:summary',
        compactionSession: { required: true, acquire: async () => session },
      });
      try {
        await expect(runtime.transformContext(raw)).rejects.toMatchObject({
          reason: 'summary_failed',
        });
        const calls = warn.mock.calls.filter(([line]) =>
          String(line).startsWith('[compaction] summary failed'),
        );
        expect(calls).toHaveLength(1);
        return { logged: calls[0]![1], trace: runtime.getTrace() };
      } finally {
        runtime.dispose();
        warn.mockRestore();
      }
    };

    const provider = await run(
      failWith(`[MODEL_REQUEST_FAILED] status 503: upstream overloaded ${'x'.repeat(400)}`),
    );
    expect(provider.logged).toMatchObject({
      errorName: 'CompactionError',
      errorCode: 'summarization_failed',
      providerCode: 'MODEL_REQUEST_FAILED',
      httpStatus: '503',
      timeoutOrAbort: false,
      modelRoute: 'agent slot model test:summary',
    });
    // No free-text error message is kept at all.
    expect(provider.logged).not.toHaveProperty('message');
    expect(JSON.stringify(provider.logged)).not.toContain('upstream overloaded');
    expect(provider.trace.lastSummaryFailure).toEqual(provider.logged);

    // A provider error that quotes the rejected (multiline) request leaks nothing.
    const echoed = await run(
      failWith(`request rejected:\n${secret}\n[MODEL_REQUEST_IDLE_TIMEOUT]`),
    );
    for (const text of [JSON.stringify(echoed.logged), JSON.stringify(echoed.trace)]) {
      expect(text).not.toContain('history-3');
      expect(text).not.toContain('history-4');
      expect(text).not.toContain('important course evidence');
    }
    expect(echoed.logged).not.toHaveProperty('message');
    expect(echoed.logged).toMatchObject({
      providerCode: 'MODEL_REQUEST_IDLE_TIMEOUT',
      timeoutOrAbort: true,
    });
    expect((await session.getEntries()).some((entry) => entry.type === 'compaction')).toBe(false);
  });

  it('also blocks when the summary stream settles with an error result instead of throwing', async () => {
    const session = await new InMemorySessionRepo().create();
    const raw = longHistory();
    for (const message of raw) await session.appendMessage(message);
    const runtime = createAgentCompactionRuntime({
      streamFn: (() => {
        const stream = createAssistantMessageEventStream();
        const error: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: 'test',
          provider: 'test',
          model: 'test',
          usage: EMPTY_USAGE,
          stopReason: 'error',
          errorMessage: 'summary denied',
          timestamp: 1,
        };
        queueMicrotask(() => stream.push({ type: 'error', reason: 'error', error }));
        return stream;
      }) as StreamFn,
      contextWindow: 600,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      compactionSession: { required: true, acquire: async () => session },
    });
    try {
      await expect(runtime.transformContext(raw)).rejects.toMatchObject({
        reason: 'summary_failed',
      });
      expect((await session.buildContext()).messages).toEqual(raw);
      expect((await session.getEntries()).filter((e) => e.type === 'compaction')).toHaveLength(0);
    } finally {
      runtime.dispose();
    }
  });

  it('checks read-time protocol additions before persisting a durable cut', async () => {
    const session = await new InMemorySessionRepo().create();
    const raw = longHistory();
    for (const message of raw) await session.appendMessage(message);
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('short summary', vi.fn()),
      contextWindow: 600,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      compactionSession: { required: true, acquire: async () => session },
      budgetMessages: (messages) => [
        ...messages,
        { role: 'user', content: 'protocol preamble '.repeat(200), timestamp: 1 },
      ],
    });
    try {
      await expect(runtime.transformContext(raw)).rejects.toMatchObject({
        reason: 'still_oversized',
      });
      expect((await session.getEntries()).filter((e) => e.type === 'compaction')).toHaveLength(0);
      expect((await session.buildContext()).messages).toEqual(raw);
    } finally {
      runtime.dispose();
    }
  });

  it('blocks invalid output reservations and disabled compaction cannot bypass admission', async () => {
    for (const overrides of [{ reservedOutputTokens: 600 }, { settings: { enabled: false } }]) {
      const runtime = createAgentCompactionRuntime({
        streamFn: summaryStream('summary', vi.fn()),
        contextWindow: 600,
        ...overrides,
      });
      await expect(runtime.transformContext(longHistory())).rejects.toThrow(
        'CONTEXT_BUDGET_EXCEEDED',
      );
      runtime.dispose();
    }
  });

  it('reports an uncompactable single durable message without silently dropping it', async () => {
    const session = await new InMemorySessionRepo().create();
    const raw: AgentMessage[] = [
      { role: 'user', content: 'large request '.repeat(1000), timestamp: 1 },
    ];
    await session.appendMessage(raw[0]!);
    const summary = vi.fn();
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', summary),
      contextWindow: 600,
      settings: { enabled: true, reserveTokens: 120, keepRecentTokens: 120 },
      compactionSession: { required: true, acquire: async () => session },
    });
    try {
      await expect(runtime.transformContext(raw)).rejects.toMatchObject({
        reason: 'no_compaction_boundary',
      });
      expect(summary).not.toHaveBeenCalled();
      expect((await session.buildContext()).messages).toEqual(raw);
    } finally {
      runtime.dispose();
    }
  });

  it('compacts a CJK history that crosses the target although pi sizes it far smaller', async () => {
    // pi's own chars/4 estimate sees ~4.5K tokens here, below the kept tail
    // budget, so its default cut keeps everything; this runtime counts ~18K.
    const session = await new InMemorySessionRepo().create();
    const history: AgentMessage[] = [
      { role: 'user', content: '请讲解'.repeat(2_000), timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '课堂内容'.repeat(1_500) }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: 2,
      } as AgentMessage,
      { role: 'user', content: '继续下一部分'.repeat(1_000), timestamp: 3 },
    ];
    for (const message of history) await session.appendMessage(message);
    const summarize = vi.fn();
    const systemPrompt = 's'.repeat(71_200);
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('Summary of the earlier lesson.', summarize),
      contextWindow: 64_000,
      reservedOutputTokens: 32_000,
      systemPrompt,
      compactionSession: { required: true, acquire: async () => session },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(estimateFullContextTokens({ messages: history, systemPrompt })).toBeGreaterThan(
        runtime.getTrace().targetTokens,
      );
      const transformed = await runtime.transformContext(history);

      expect(summarize).toHaveBeenCalledOnce();
      expect(transformed[0]?.role).toBe('compactionSummary');
      expect(transformed.at(-1)).toEqual(history[2]);
      expect(estimateFullContextTokens({ messages: transformed, systemPrompt })).toBeLessThan(
        runtime.getTrace().targetTokens,
      );
      expect((await session.getEntries()).filter((e) => e.type === 'compaction')).toHaveLength(1);
    } finally {
      runtime.dispose();
      warn.mockRestore();
    }
  });

  it('cuts past an oversized recent message before paying for one bounded summary', async () => {
    const session = await new InMemorySessionRepo().create();
    const reply = (text: string, timestamp: number) =>
      ({
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp,
      }) as AgentMessage;
    const history: AgentMessage[] = [
      ...Array.from({ length: 4 }, (_, index) => [
        {
          role: 'user',
          content: `q${index} ${'a'.repeat(4_000)}`,
          timestamp: index * 2,
        } as AgentMessage,
        reply(`r${index} ${'b'.repeat(4_000)}`, index * 2 + 1),
      ]).flat(),
      { role: 'user', content: 'show the whole document', timestamp: 20 },
      // A single reply that the default kept tail (≥ keepRecentTokens) must include.
      reply(`document ${'d'.repeat(96_000)}`, 21),
      { role: 'user', content: 'now shorten it', timestamp: 22 },
    ];
    for (const message of history) await session.appendMessage(message);
    const maxTokens: unknown[] = [];
    const summaryFn = summaryStream('Summary: a long document was shown.', vi.fn());
    const runtime = createAgentCompactionRuntime({
      streamFn: ((model, context, options) => {
        maxTokens.push(options?.maxTokens);
        return summaryFn(model, context, options);
      }) as StreamFn,
      contextWindow: 40_000,
      settings: { reserveTokens: 10_000, keepRecentTokens: 5_000 },
      compactionSession: { required: true, acquire: async () => session },
    });
    try {
      const target = runtime.getTrace().targetTokens;
      expect(estimateFullContextTokens({ messages: history })).toBeGreaterThan(target);
      const transformed = await runtime.transformContext(history);

      // One summary call (no split turn), bounded by the summary allowance.
      expect(maxTokens).toHaveLength(1);
      expect(maxTokens[0]).toBeLessThanOrEqual(Math.floor(target * 0.25));
      expect(transformed.map((message) => message.role)).toEqual(['compactionSummary', 'user']);
      expect(transformed[1]).toEqual(history.at(-1));
      expect(estimateFullContextTokens({ messages: transformed })).toBeLessThan(target);
      expect((await session.getEntries()).filter((e) => e.type === 'compaction')).toHaveLength(1);
      // Raw entries are kept.
      expect((await session.getEntries()).filter((e) => e.type === 'message')).toHaveLength(
        history.length,
      );
    } finally {
      runtime.dispose();
    }
  });

  it('summarizes history larger than the summary window in bounded chunks', async () => {
    const session = await new InMemorySessionRepo().create();
    const history = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0
        ? ({
            role: 'user',
            content: `q${index} ${'u'.repeat(2_000)}`,
            timestamp: index,
          } as AgentMessage)
        : assistantText(`a${index} ${'v'.repeat(2_000)}`, index),
    );
    for (const message of history) await session.appendMessage(message);
    const requests: number[] = [];
    const summaryFn = summaryStream('Rolling summary.', vi.fn());
    const runtime = createAgentCompactionRuntime({
      streamFn: ((model, context, options) => {
        requests.push(
          estimateFullContextTokens({
            systemPrompt: context.systemPrompt,
            messages: context.messages as AgentMessage[],
          }) + Number(options?.maxTokens ?? 0),
        );
        return summaryFn(model, context, options);
      }) as StreamFn,
      contextWindow: 16_000,
      compactionSession: { required: true, acquire: async () => session },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const transformed = await runtime.transformContext(history);

      expect(transformed[0]?.role).toBe('compactionSummary');
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.length).toBeLessThanOrEqual(MAX_SUMMARY_CHUNK_CALLS + 1);
      // No single summary request (input + output allowance) exceeds the window.
      expect(Math.max(...requests)).toBeLessThanOrEqual(16_000);
      expect(runtime.getTrace().summaryCalls).toBe(requests.length);
      expect(runtime.getTrace().events[0]?.summaryCalls).toBe(requests.length);
      expect(warn).toHaveBeenCalledWith(
        '[compaction] summarized oversized history in chunks',
        expect.objectContaining({ chunkCalls: requests.length - 1, contextWindow: 16_000 }),
      );
      expect((await session.getEntries()).filter((e) => e.type === 'compaction')).toHaveLength(1);
    } finally {
      runtime.dispose();
      warn.mockRestore();
    }
  });

  it('blocks before any summary call when chunking would exceed the call bound', async () => {
    const session = await new InMemorySessionRepo().create();
    const history = Array.from({ length: 400 }, (_, index) =>
      index % 2 === 0
        ? ({
            role: 'user',
            content: `q${index} ${'u'.repeat(2_000)}`,
            timestamp: index,
          } as AgentMessage)
        : assistantText(`a${index} ${'v'.repeat(2_000)}`, index),
    );
    for (const message of history) await session.appendMessage(message);
    const summarize = vi.fn();
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', summarize),
      contextWindow: 16_000,
      compactionSession: { required: true, acquire: async () => session },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Planned, not attempted: no summary call is paid for, and the reason
      // says so — a resend only adds to this history, so it blocks for good
      // instead of reading as a retryable summary failure.
      await expect(runtime.transformContext(history)).rejects.toMatchObject({
        reason: 'summary_input_too_large',
      });
      expect(summarize).not.toHaveBeenCalled();
      expect(runtime.getTrace().lastSummaryFailure).toMatchObject({
        errorName: 'SummaryInputTooLargeError',
        errorCode: 'chunk_limit',
      });
      expect((await session.getEntries()).some((entry) => entry.type === 'compaction')).toBe(false);
    } finally {
      runtime.dispose();
      warn.mockRestore();
    }
  });

  it('blocks before any summary call when one message to summarize exceeds the summary window', async () => {
    const session = await new InMemorySessionRepo().create();
    // One early message larger than any summary request can carry, then a
    // short recent tail the cut can keep: compaction must summarize the giant
    // and cannot, whatever the provider does.
    const history: AgentMessage[] = [
      { role: 'user', content: `giant ${'g'.repeat(100_000)}`, timestamp: 0 } as AgentMessage,
      assistantText('ack', 1),
      ...Array.from({ length: 6 }, (_, index) =>
        index % 2 === 0
          ? ({ role: 'user', content: `q${index} short`, timestamp: index + 2 } as AgentMessage)
          : assistantText(`a${index} short`, index + 2),
      ),
    ];
    for (const message of history) await session.appendMessage(message);
    const summarize = vi.fn();
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', summarize),
      contextWindow: 16_000,
      compactionSession: { required: true, acquire: async () => session },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runtime.transformContext(history)).rejects.toMatchObject({
        reason: 'summary_input_too_large',
      });
      expect(summarize).not.toHaveBeenCalled();
      expect(runtime.getTrace().lastSummaryFailure).toMatchObject({
        errorName: 'SummaryInputTooLargeError',
        errorCode: 'message_too_large',
      });
      expect((await session.getEntries()).some((entry) => entry.type === 'compaction')).toBe(false);
    } finally {
      runtime.dispose();
      warn.mockRestore();
    }
  });

  it('prefers a later turn boundary over a split-turn cut so one summary request is made', async () => {
    const session = await new InMemorySessionRepo().create();
    const history: AgentMessage[] = [
      ...Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? ({
              role: 'user',
              content: `q${index} ${'u'.repeat(19_200)}`,
              timestamp: index,
            } as AgentMessage)
          : assistantText(`a${index} ${'v'.repeat(19_200)}`, index),
      ),
      { role: 'user', content: 'read the attached scene', timestamp: 30 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-scene', name: 'read_scene', arguments: {} }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: EMPTY_USAGE,
        stopReason: 'toolUse',
        timestamp: 31,
      } as AgentMessage,
      {
        role: 'toolResult',
        toolCallId: 'call-scene',
        toolName: 'read_scene',
        content: [{ type: 'text', text: 's'.repeat(84_000) }],
        isError: false,
        timestamp: 32,
      } as AgentMessage,
      assistantText('Got it', 33),
      { role: 'user', content: 'next', timestamp: 34 },
    ];
    for (const message of history) await session.appendMessage(message);
    const summarize = vi.fn();
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('Summary of the lesson so far.', summarize),
      contextWindow: 128_000,
      compactionSession: { required: true, acquire: async () => session },
    });
    try {
      expect(estimateFullContextTokens({ messages: history })).toBeGreaterThan(
        runtime.getTrace().targetTokens,
      );
      const transformed = await runtime.transformContext(history);

      // pi's default-sized cut lands on "Got it" (a split turn: two requests).
      expect(summarize).toHaveBeenCalledOnce();
      expect(transformed.map((message) => message.role)).toEqual(['compactionSummary', 'user']);
      expect(transformed[1]).toEqual(history.at(-1));
    } finally {
      runtime.dispose();
    }
  });

  it('blocks without a summary when the latest user message alone exceeds the budget', async () => {
    const session = await new InMemorySessionRepo().create();
    const history: AgentMessage[] = [
      ...longHistory(),
      { role: 'user', content: 'huge '.repeat(20_000), timestamp: 30 },
    ];
    for (const message of history) await session.appendMessage(message);
    const summarize = vi.fn();
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', summarize),
      contextWindow: 20_000,
      compactionSession: { required: true, acquire: async () => session },
    });
    try {
      await expect(runtime.transformContext(history)).rejects.toMatchObject({
        reason: 'still_oversized',
      });
      expect(summarize).not.toHaveBeenCalled();
      expect((await session.getEntries()).some((entry) => entry.type === 'compaction')).toBe(false);
    } finally {
      runtime.dispose();
    }
  });

  it('reports a keep-budget clamp once, not on every model call', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let call = 0; call < 3; call += 1) {
        createAgentCompactionRuntime({
          streamFn: summaryStream('unused', vi.fn()),
          contextWindow: 48_000,
          settings: { keepRecentTokens: 20_000 },
          systemPrompt: 'p'.repeat(100_000),
        }).dispose();
      }
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes('safe tail budget')),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('convertToLlm turns a compaction entry into a user message with the preamble', () => {
    const entry = createCompactionSummaryMessage(
      'course facts preserved',
      10_000,
      String(Date.now()),
    );
    const llm = convertToLlm([
      entry,
      { role: 'user', content: 'kept after compaction', timestamp: 1 },
    ]);

    expect(llm[0]?.role).toBe('user');
    const text = (llm[0]!.content as { type: string; text: string }[])
      .map((block) => block.text)
      .join('');
    expect(text).toContain('compacted into the following summary');
    expect(text).toContain('course facts preserved');
    expect(llm[1]).toMatchObject({ role: 'user', content: 'kept after compaction' });
  });
});

describe('window-scaled compaction thresholds', () => {
  it('reserves a large wire output share of a 1M window before compacting', () => {
    const contextWindow = 1_048_576;
    const reserveTokens = 16_384;
    const wireMaxOutputTokens = 393_216;
    const targetTokens = resolveCompactionTargetTokens(
      contextWindow,
      reserveTokens,
      wireMaxOutputTokens,
    );

    expect(targetTokens).toBe(655_360);
    expect(resolveCompactionTargetTokens(20_000, 8_000, 2_000)).toBe(12_000);
    expect(
      shouldCompact(671_487, contextWindow, {
        enabled: true,
        reserveTokens: contextWindow - targetTokens,
        keepRecentTokens: 20_000,
      }),
    ).toBe(true);
    expect(671_487 + wireMaxOutputTokens).toBe(1_064_703);
    expect(671_487 + wireMaxOutputTokens).toBeGreaterThan(contextWindow);
  });

  it('never makes the safety target non-positive or larger than a tiny context window', () => {
    expect(resolveCompactionTargetTokens(2_000, 500, 2_000)).toBe(2_000);
    expect(resolveCompactionTargetTokens(32_768, 4_096, 98_304)).toBe(4_096);
    expect(resolveCompactionTargetTokens(5_000, 100, 4_999)).toBe(1);
  });

  it('audits all catalog contexts and extreme route pins without a keep/target inversion', () => {
    const rows = Object.values(PROVIDERS).flatMap((provider) =>
      provider.models
        .filter((model) => model.contextWindow !== undefined)
        .map((model) => {
          const contextWindow = model.contextWindow!;
          const outputTokens = model.outputWindow ?? 8_192;
          const targetTokens = resolveCompactionTargetTokens(
            contextWindow,
            DEFAULT_COMPACTION_SETTINGS.reserveTokens,
            outputTokens,
          );
          const keepRecentTokens = Math.min(
            DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
            Math.floor(contextWindow / 2),
          );
          return {
            id: `${provider.id}:${model.id}`,
            unsalvageable: outputTokens >= contextWindow,
            targetTokens,
            keepRecentTokens,
            clampedKeepRecentTokens: resolveCompactionKeepRecentTokens(
              keepRecentTokens,
              targetTokens,
              0,
            ),
          };
        }),
    );
    const routePins = [
      {
        id: 'pin:32k/16k',
        contextWindow: 32_768,
        reserveTokens: 16_384,
        outputTokens: 16_384,
      },
      {
        id: 'pin:32k/128k',
        contextWindow: 32_768,
        reserveTokens: 16_384,
        outputTokens: 128_000,
      },
      {
        id: 'pin:near-total-output',
        contextWindow: 5_000,
        reserveTokens: 100,
        outputTokens: 4_999,
      },
      {
        id: 'pin:1m-large-output',
        contextWindow: 1_048_576,
        reserveTokens: 16_384,
        outputTokens: 393_216,
      },
    ].map(({ id, contextWindow, reserveTokens, outputTokens }) => {
      const targetTokens = resolveCompactionTargetTokens(
        contextWindow,
        reserveTokens,
        outputTokens,
      );
      const keepRecentTokens = Math.min(
        DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
        Math.floor(contextWindow / 2),
      );
      return {
        id,
        targetTokens,
        keepRecentTokens,
        clampedKeepRecentTokens: resolveCompactionKeepRecentTokens(
          keepRecentTokens,
          targetTokens,
          0,
        ),
      };
    });

    expect(rows.every(({ targetTokens }) => targetTokens > 0)).toBe(true);
    expect(
      [...rows, ...routePins].every(
        ({ targetTokens, clampedKeepRecentTokens }) => clampedKeepRecentTokens < targetTokens,
      ),
    ).toBe(true);
    expect(
      [...rows, ...routePins].every(
        ({ targetTokens, keepRecentTokens, clampedKeepRecentTokens }) =>
          clampedKeepRecentTokens === Math.min(keepRecentTokens, Math.floor(targetTokens * 0.75)),
      ),
    ).toBe(true);
    expect(routePins).toContainEqual({
      id: 'pin:32k/16k',
      targetTokens: 16_384,
      keepRecentTokens: 16_384,
      clampedKeepRecentTokens: 12_288,
    });
    expect(routePins).toContainEqual({
      id: 'pin:near-total-output',
      targetTokens: 1,
      keepRecentTokens: 2_500,
      clampedKeepRecentTokens: 0,
    });
    expect(routePins).toContainEqual({
      id: 'pin:1m-large-output',
      targetTokens: 655_360,
      keepRecentTokens: 20_000,
      clampedKeepRecentTokens: 20_000,
    });
    expect(rows.filter(({ unsalvageable }) => unsalvageable).map(({ id }) => id)).toEqual([
      'grok:grok-4.6',
      'grok:grok-4.5',
      'grok:grok-build-0.1',
    ]);
  });

  it('makes a required durable 32K/16K cut after clamping an inverted keep budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSummaryCall = vi.fn();
    const systemPrompt = 's'.repeat(8_000);
    const session = await new InMemorySessionRepo().create({ id: 'required-inverted-keep' });
    const history = Array.from({ length: 6 }, (_, index) => ({
      role: 'user' as const,
      content: `history-${index}:${'x'.repeat(10_000)}`,
      timestamp: index,
    }));
    for (const message of history) await session.appendMessage(message);
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('Durable checkpoint summary.', onSummaryCall),
      contextWindow: 32_768,
      reservedOutputTokens: 16_384,
      settings: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 },
      systemPrompt,
      compactionSession: { required: true, acquire: async () => session },
    });

    const transformed = await runtime.transformContext(history);
    const trace = runtime.getTrace();

    expect(trace.targetTokens).toBe(16_384);
    expect(trace.keepRecentTokens).toBeLessThan(trace.targetTokens * 0.75);
    expect(trace.keepRecentTokens).toBeLessThan(trace.targetTokens);
    expect(trace.failures).toEqual([]);
    expect(trace.triggerCount).toBe(1);
    expect(onSummaryCall).toHaveBeenCalledOnce();
    expect(transformed[0]?.role).toBe('compactionSummary');
    expect(estimateFullContextTokens({ messages: transformed, systemPrompt })).toBeLessThan(
      trace.targetTokens,
    );
    expect((await session.getEntries()).some((entry) => entry.type === 'compaction')).toBe(true);
    runtime.dispose();
    warn.mockRestore();
  });

  it('reserves the effective wire output before the catalog context limit', async () => {
    const onSummaryCall = vi.fn();
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('Output-aware threshold summary.', onSummaryCall),
      contextWindow: 20_000,
      reservedOutputTokens: 8_000,
      settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 },
    });
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: 'user' as const,
      content: `history-${index}: ${'x'.repeat(6_000)}`,
      timestamp: index,
    }));
    const estimated = estimateFullContextTokens({ messages: history });

    expect(estimated).toBeGreaterThan(12_000);
    expect(estimated).toBeLessThan(18_000);
    const transformed = await runtime.transformContext(history);

    expect(transformed[0]?.role).toBe('compactionSummary');
    expect(onSummaryCall).toHaveBeenCalledOnce();
    expect(runtime.getTrace().triggerCount).toBe(1);
    runtime.dispose();
  });

  it.each([
    {
      label: 'agent slot model grok:grok-4.6',
      contextWindow: 500_000,
      outputTokens: 500_000,
    },
    {
      label: 'agent slot model with a 32K context pin',
      contextWindow: 32_768,
      outputTokens: 128_000,
    },
  ])(
    'keeps a positive target and warns loudly for invalid $label configuration',
    ({ label, contextWindow, outputTokens }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const runtime = createAgentCompactionRuntime({
        streamFn: summaryStream('unused', vi.fn()),
        contextWindow,
        reservedOutputTokens: outputTokens,
        modelRouteLabel: label,
      });

      expect(runtime.getTrace()).toMatchObject({
        effectiveOutputTokens: outputTokens,
        targetTokens: 4_096,
        triggerCount: 0,
        failures: [],
      });
      expect(warn).toHaveBeenCalledTimes(2);
      const operatorWarning = warn.mock.calls.find(([message]) => String(message).includes(label));
      expect(operatorWarning?.[0]).toContain(label);
      expect(operatorWarning?.[0]).toContain(
        `output reservation ${outputTokens} >= context window ${contextWindow}`,
      );
      expect(operatorWarning?.[0]).toContain('provider will reject requests');
      expect(operatorWarning?.[0]).toContain('fix the route or catalog configuration');
      runtime.dispose();
      warn.mockRestore();
    },
  );

  it('scales reserve/keep to a 16K window when no explicit settings are passed', () => {
    // Passing pi's fixed defaults (reserve 16384, keep 20000) as explicit
    // overrides would leave a 16K window with reserve == window, so
    // shouldCompact would trigger on EVERY round.
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', vi.fn()),
      contextWindow: 16_384,
    });
    const trace = runtime.getTrace();
    // reserve = min(16384, max(2048, window*0.2)) = 3276; keep = min(20000,
    // max(2048, window*0.25)) = 4096. Both strictly inside the window, so the
    // compaction threshold (window - reserve) is positive and the run does not
    // spin on every stream.
    expect(trace.reserveTokens).toBe(3_276);
    expect(trace.keepRecentTokens).toBe(4_096);
    expect(trace.reserveTokens).toBeLessThan(trace.contextWindow);
    expect(trace.contextWindow - trace.reserveTokens).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('scales reserve/keep to a 32K window without exceeding it', () => {
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', vi.fn()),
      contextWindow: 32_768,
    });
    const trace = runtime.getTrace();
    // reserve = min(16384, max(2048, 6553)) = 6553; keep = min(20000, max(2048, 8192)) = 8192.
    expect(trace.reserveTokens).toBe(6_553);
    expect(trace.keepRecentTokens).toBe(8_192);
    // reserve + keep < window: a compaction actually shrinks below the window
    // instead of burning without reducing.
    expect(trace.reserveTokens + trace.keepRecentTokens).toBeLessThan(trace.contextWindow);
    runtime.dispose();
  });

  it('clamps EXPLICIT overrides to the window ratios (reserve ≤ window/4, keep ≤ window/2)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', vi.fn()),
      contextWindow: 32_768,
      // The old default values, as an operator might set them explicitly.
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    });
    const trace = runtime.getTrace();
    expect(trace.reserveTokens).toBe(8_192); // 32768 / 4
    expect(trace.keepRecentTokens).toBe(16_384); // 32768 / 2
    expect(trace.reserveTokens + trace.keepRecentTokens).toBeLessThan(trace.contextWindow);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/reserveTokens/);
    expect(warn.mock.calls[1]?.[0]).toMatch(/keepRecentTokens/);
    warn.mockRestore();
    runtime.dispose();
  });

  it('keeps an explicit override that is already inside the window ratio', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createAgentCompactionRuntime({
      streamFn: summaryStream('unused', vi.fn()),
      contextWindow: 128_000,
      settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 8_192 },
    });
    expect(runtime.getTrace()).toMatchObject({ reserveTokens: 4_096, keepRecentTokens: 8_192 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    runtime.dispose();
  });
});
