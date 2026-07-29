import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { createDirectorCompactionRuntime } from '@/lib/chat/pi/director-compaction';
import { toHistoryMessages } from '@/lib/chat/pi/prompts';

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

function longHistory(): AgentMessage[] {
  return Array.from({ length: 10 }, (_, index) => ({
    role: 'user' as const,
    content: `history-${index}: ${'important classroom evidence '.repeat(35)}`,
    timestamp: index,
  }));
}

function alternatingUiHistory() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    parts: [
      {
        type: 'text' as const,
        text: `turn-${index}: ${'important classroom evidence '.repeat(35)}`,
      },
    ],
  }));
}

describe('Pi Director compaction runtime', () => {
  it('uses Pi session preparation and compaction, then retains new messages', async () => {
    const onSummaryCall = vi.fn();
    const runtime = createDirectorCompactionRuntime({
      streamFn: summaryStream(
        'Goal: preserve scene-2 evidence and https://example.test/source.',
        onSummaryCall,
      ),
      contextWindow: 600,
      maxOutputTokens: 200,
      settings: { enabled: true, reserveTokens: 160, keepRecentTokens: 120 },
    });
    const history = longHistory();

    const compacted = await runtime.transformContext(history);
    const trace = runtime.getTrace();
    const event = trace.events[0];

    expect(compacted[0]?.role).toBe('compactionSummary');
    expect(compacted.length).toBeLessThan(history.length);
    expect(onSummaryCall).toHaveBeenCalledTimes(1);
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
    expect(event?.summary).toContain('scene-2 evidence');

    const tokenReduction = 1 - event!.tokensAfter / event!.tokensBefore;
    const messageReduction = 1 - event!.messagesAfter / event!.messagesBefore;
    expect(tokenReduction).toBeGreaterThan(0);
    expect(messageReduction).toBeGreaterThan(0);
    console.info(
      '[COMPACTION-TRIGGER-01]',
      JSON.stringify({
        checkCount: trace.checkCount,
        triggerCount: trace.triggerCount,
        failures: trace.failures,
        tokensBefore: event!.tokensBefore,
        tokensAfter: event!.tokensAfter,
        tokenReduction,
        messagesBefore: event!.messagesBefore,
        messagesAfter: event!.messagesAfter,
        messageReduction,
        firstKeptEntryId: event!.firstKeptEntryId,
        summary: event!.summary,
      }),
    );

    const nextMessage: AgentMessage = {
      role: 'user',
      content: 'NEW_FOLLOW_UP_AFTER_COMPACTION',
      timestamp: 99,
    };
    const continued = await runtime.transformContext([...history, nextMessage]);

    expect(continued[0]?.role).toBe('compactionSummary');
    expect(
      continued.some(
        (message) =>
          message.role === 'user' && message.content === 'NEW_FOLLOW_UP_AFTER_COMPACTION',
      ),
    ).toBe(true);
    expect(onSummaryCall).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('does not compact a short history below the real threshold', async () => {
    const onSummaryCall = vi.fn();
    const runtime = createDirectorCompactionRuntime({
      streamFn: summaryStream('unused', onSummaryCall),
      contextWindow: 128_000,
    });
    const history: AgentMessage[] = [{ role: 'user', content: 'short question', timestamp: 1 }];

    const transformed = await runtime.transformContext(history);

    expect(transformed).toEqual(history);
    expect(runtime.getTrace()).toMatchObject({ checkCount: 1, triggerCount: 0, events: [] });
    expect(onSummaryCall).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('compacts real alternating UI history even when imported assistant usage is zero', async () => {
    const onSummaryCall = vi.fn();
    const runtime = createDirectorCompactionRuntime({
      streamFn: summaryStream(
        'Preserve the current lesson goal and scene evidence.',
        onSummaryCall,
      ),
      contextWindow: 600,
      maxOutputTokens: 200,
      settings: { enabled: true, reserveTokens: 160, keepRecentTokens: 120 },
    });
    const history = toHistoryMessages(alternatingUiHistory(), null);

    const compacted = await runtime.transformContext(history);

    expect(compacted[0]?.role).toBe('compactionSummary');
    expect(onSummaryCall).toHaveBeenCalled();
    expect(runtime.getTrace()).toMatchObject({ checkCount: 1, triggerCount: 1, failures: [] });
    expect(runtime.getTrace().events[0]?.tokensBefore).toBeGreaterThan(440);
    expect(runtime.getTrace().events[0]?.tokensAfter).toBeLessThan(
      runtime.getTrace().events[0]?.tokensBefore ?? 0,
    );
    runtime.dispose();
  });

  it('falls back to the default context window for invalid model metadata', () => {
    const runtime = createDirectorCompactionRuntime({
      streamFn: summaryStream('unused', vi.fn()),
      contextWindow: Number.NaN,
    });

    expect(runtime.getTrace().contextWindow).toBe(128_000);
    runtime.dispose();
  });

  it('allows the Director to retain all UI history before compaction', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: `message ${index}` }],
    }));

    expect(toHistoryMessages(messages)).toHaveLength(12);
    expect(toHistoryMessages(messages, null)).toHaveLength(20);
  });
});
