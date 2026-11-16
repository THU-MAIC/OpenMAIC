import { describe, expect, it, vi } from 'vitest';
import { estimateTokens, type AgentMessage } from '@earendil-works/pi-agent-core';
import {
  createDirectorTailStateTransform,
  DIRECTOR_STATE_PREFIX,
} from '@/lib/chat/pi/director-tail-state';
import { createDirectorCompactionRuntime } from '@/lib/chat/pi/director-compaction';
import type { WhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import type { StatelessChatRequest } from '@/lib/types/chat';

const body = {
  storeState: { scenes: [], whiteboardOpen: false },
} as unknown as StatelessChatRequest;
const parse = (messages: AgentMessage[]) =>
  JSON.parse((messages.at(-1) as { content: string }).content.slice(DIRECTOR_STATE_PREFIX.length));

describe('Director transient board state', () => {
  it('refetches after compaction, budgets the tail, and leaves history and summaries untouched', async () => {
    let triggerCount = 0;
    const history: AgentMessage[] = [
      { role: 'user', content: 'Explain the diagram', timestamp: 0 },
    ];
    const before = structuredClone(history);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: null, lastSeq: null, whiteboard: null })
      .mockResolvedValueOnce({
        sessionId: 's',
        lastSeq: 2,
        whiteboard: { id: 'b', elements: [], viewportSize: 1000, viewportRatio: 0.5625 },
      })
      .mockRejectedValueOnce(new Error('read unavailable'));
    const transformContext = vi.fn(
      async (messages: AgentMessage[], _signal?: AbortSignal, tokens?: number) => {
        expect(tokens).toBeGreaterThan(0);
        triggerCount++;
        return messages;
      },
    );
    const transform = createDirectorTailStateTransform({
      body,
      stageId: 'stage',
      service: { read } as unknown as WhiteboardRuntimeService,
      getAgentResponses: () => [],
      compaction: { transformContext, getTrace: () => ({ triggerCount }) as never, dispose() {} },
    });
    expect(parse(await transform(history)).whiteboard.lastSeq).toBe(2);
    expect(transformContext.mock.calls[0]![0]).toEqual(before);
    expect(history).toEqual(before);
    // No further compaction: a failed read must replace the current observation, not look empty.
    transformContext.mockImplementationOnce(async (messages) => messages);
    const failed = await transform(history);
    expect(failed).toHaveLength(2);
    expect(parse(failed).whiteboard).toEqual({
      status: 'read_failed',
      stageId: 'stage',
      code: 'WHITEBOARD_READ_FAILED',
    });
  });

  it('refreshes after a failed compaction attempt as well', async () => {
    const read = vi.fn().mockResolvedValue({ sessionId: null, lastSeq: null, whiteboard: null });
    const failures: string[] = [];
    const transform = createDirectorTailStateTransform({
      body,
      stageId: 'stage',
      service: { read } as unknown as WhiteboardRuntimeService,
      getAgentResponses: () => [],
      compaction: {
        transformContext: async (m) => {
          failures.push('offline');
          return m;
        },
        getTrace: () => ({ triggerCount: 0, failures: [...failures] }) as never,
        dispose() {},
      },
    });
    await transform([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('uses transient input in the real compaction decision without persisting it', async () => {
    const runtime = createDirectorCompactionRuntime({
      streamFn: vi.fn(() => {
        throw new Error('offline summary failure');
      }),
      contextWindow: 8000,
      settings: { reserveTokens: 2000, keepRecentTokens: 2000 },
    });
    const messages: AgentMessage[] = [{ role: 'user', content: 'x'.repeat(20000), timestamp: 0 }];
    await runtime.transformContext(messages);
    expect(runtime.getTrace().triggerCount).toBe(0);
    const transient = { role: 'user' as const, content: 'tail'.repeat(1200), timestamp: 0 };
    await runtime.transformContext(messages, undefined, estimateTokens(transient));
    expect(runtime.getTrace().failures.length).toBeGreaterThan(0);
    expect(JSON.stringify(await runtime.transformContext(messages))).not.toContain('tail');
    runtime.dispose();
  });
});
