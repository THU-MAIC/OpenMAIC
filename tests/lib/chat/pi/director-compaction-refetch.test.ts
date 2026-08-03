import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import { convertToLlm, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createDirectorCompactionRuntime } from '@/lib/chat/pi/director-compaction';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import {
  buildReadSceneTool,
  type DirectorSceneEvidenceMetadata,
  type DirectorSceneEvidencePacket,
} from '@/lib/chat/pi/tools/read-scene';

const mocks = vi.hoisted(() => ({
  childContexts: [] as string[],
}));

vi.mock('@/lib/agent/runtime/stream-fn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/runtime/stream-fn')>();
  const { createAssistantMessageEventStream: createStream } = await import('@earendil-works/pi-ai');
  return {
    ...actual,
    createCallLlmStreamFn: vi.fn(
      () =>
        ((_model, context) => {
          mocks.childContexts.push(contextText(context));
          const stream = createStream();
          const message = assistantText(SCENE_TRUTH);
          queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
          return stream;
        }) as StreamFn,
    ),
  };
});
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const SUMMARY_MARKER = 'COMPACTED_MEMORY_MARKER';
const TARGET_SCENE_ID = 'scene-light';
const SCENE_TRUTH = 'Light energy drives ATP production.';
const STALE_PACKET_MARKER = 'STALE_PRECOMPACTION_PACKET';

function assistantText(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'deterministic-test',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    ...assistantText(''),
    content: [{ type: 'toolCall', id, name, arguments: args }],
    stopReason: 'toolUse',
  };
}

function messageText(message: Context['messages'][number]): string {
  if (message.role === 'user') {
    return typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
  }
  if (message.role === 'assistant') {
    return message.content
      .map((part) =>
        part.type === 'text'
          ? part.text
          : part.type === 'toolCall'
            ? `${part.name}(${JSON.stringify(part.arguments)})`
            : '',
      )
      .join('\n');
  }
  return `${message.toolName}: ${message.content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join('\n')}`;
}

function contextText(context: Context): string {
  return context.messages.map(messageText).join('\n');
}

function deterministicSummaryStream(): StreamFn {
  return ((_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    const message = assistantText(
      `${SUMMARY_MARKER}: preserve the early classroom goal and scene identity ${TARGET_SCENE_ID}; ` +
        'the previously attached scene evidence was already consumed and must be fetched again.',
    );
    queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
    return stream;
  }) as StreamFn;
}

function longHistory(): AgentMessage[] {
  return Array.from({ length: 10 }, (_, index) => ({
    role: 'user' as const,
    content:
      index === 0
        ? `Early goal: explain the light-reaction mechanism using scene identity ${TARGET_SCENE_ID}. ${'classroom context '.repeat(45)}`
        : `history-${index}: ${'important classroom evidence '.repeat(45)}`,
    timestamp: index,
  }));
}

function makeBody(): StatelessChatRequest {
  return {
    messages: [],
    storeState: {
      stage: {
        id: 'stage-1',
        name: 'Photosynthesis',
        createdAt: 1,
        updatedAt: 50,
      },
      outlines: [
        {
          id: 'outline-light',
          type: 'slide',
          title: 'Light reactions',
          description: 'How light energy becomes chemical energy.',
          keyPoints: ['chlorophyll absorbs light', 'ATP and NADPH are produced'],
          order: 2,
        },
      ],
      scenes: [
        {
          id: TARGET_SCENE_ID,
          outlineId: 'outline-light',
          stageId: 'stage-1',
          title: 'Light reactions',
          order: 2,
          type: 'slide',
          updatedAt: 42,
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'equation',
                  type: 'text',
                  content: SCENE_TRUTH,
                  left: 40,
                  top: 60,
                  width: 400,
                  height: 80,
                },
              ],
            } as never,
          },
        },
      ],
      currentSceneId: TARGET_SCENE_ID,
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: { agentIds: ['teacher-1'] },
    apiKey: '',
  } as StatelessChatRequest;
}

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'AI Teacher',
  role: 'teacher',
  persona: 'Teach only from supplied evidence.',
  avatar: '',
  color: '#3366ff',
  allowedActions: [],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

describe('Pi Director post-compaction refetch', () => {
  it('COMPACTION-REFETCH-01 preserves memory, refetches, and binds only fresh scene evidence', async () => {
    mocks.childContexts.length = 0;
    const body = makeBody();
    const pendingSceneEvidence = new Map<string, DirectorSceneEvidencePacket>();
    const installedPackets: DirectorSceneEvidencePacket[] = [];
    const consumedPackets: DirectorSceneEvidencePacket[][] = [];
    let installCount = 0;

    const readScene = buildReadSceneTool({
      body,
      onEvidence: (evidence) => {
        installCount += 1;
        const installed =
          installCount === 1
            ? { ...evidence, content: `${evidence.content}\n${STALE_PACKET_MARKER}` }
            : evidence;
        installedPackets.push(installed);
        pendingSceneEvidence.set(installed.details.sceneId, installed);
      },
    });
    const takeSceneEvidence = () => {
      if (pendingSceneEvidence.size === 0) return undefined;
      const packets = [...pendingSceneEvidence.values()];
      pendingSceneEvidence.clear();
      consumedPackets.push(packets);
      return {
        content: packets.map((packet) => packet.content).join('\n\n'),
        metadata: packets.map(
          (packet): DirectorSceneEvidenceMetadata => ({
            sceneId: packet.details.sceneId,
            title: packet.details.title,
            sceneType: packet.details.sceneType,
            order: packet.details.order,
            revision: packet.details.revision,
            source: packet.details.source,
          }),
        ),
      };
    };

    // Establish and consume a pre-compaction packet through the same request-scoped
    // evidence store. This packet must never be the one attached after compaction.
    await readScene.execute('pre-compaction-read', { sceneId: TARGET_SCENE_ID });
    const preCompactionPacket = takeSceneEvidence()?.content;
    expect(preCompactionPacket).toContain(STALE_PACKET_MARKER);
    expect(pendingSceneEvidence.size).toBe(0);

    const compactionRuntime = createDirectorCompactionRuntime({
      streamFn: deterministicSummaryStream(),
      contextWindow: 600,
      maxOutputTokens: 200,
      settings: { enabled: true, reserveTokens: 160, keepRecentTokens: 120 },
    });
    const events: StatelessEvent[] = [];
    const childTurns: AgentTurnSummary[] = [];
    const callAgent = buildCallAgentTool({
      body,
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: (summary) => childTurns.push(summary),
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 2,
      getAgentTurnCount: () => childTurns.length,
      getAgentResponses: () => childTurns,
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 0,
      enableWhiteboardTools: false,
      takeSceneEvidence,
    });

    const directorContexts: string[] = [];
    const directorStream = ((_model, context) => {
      const text = contextText(context);
      directorContexts.push(text);
      const stream = createAssistantMessageEventStream();
      const hasReadResult = context.messages.some(
        (message) => message.role === 'toolResult' && message.toolName === 'read_scene',
      );
      const hasCallAgentResult = context.messages.some(
        (message) => message.role === 'toolResult' && message.toolName === 'call_agent',
      );
      let message: AssistantMessage;
      if (!text.includes(SUMMARY_MARKER)) {
        message = assistantText('MISSING_COMPACTION_SUMMARY');
      } else if (!hasReadResult) {
        message = assistantToolCall('post-read', 'read_scene', { sceneId: TARGET_SCENE_ID });
      } else if (!hasCallAgentResult) {
        message = assistantToolCall('post-delegate', 'call_agent', {
          agentId: teacher.id,
          instruction: 'Use the freshly read scene evidence to explain the mechanism.',
        });
      } else {
        message = assistantText('Post-compaction evidence-based delegation completed.');
      }
      const reason = message.stopReason === 'toolUse' ? 'toolUse' : 'stop';
      queueMicrotask(() => stream.push({ type: 'done', reason, message }));
      return stream;
    }) as StreamFn;

    const toolTrace: Array<{
      toolName: string;
      args: unknown;
      isError: boolean;
      details: unknown;
    }> = [];
    const director = buildAgent({
      streamFn: directorStream,
      systemPrompt: 'Use read_scene before delegating a scene-dependent answer.',
      tools: [readScene, callAgent],
      allowedToolNames: new Set(['read_scene', 'call_agent']),
      history: longHistory(),
      transformContext: compactionRuntime.transformContext,
      convertToLlm,
      afterToolCall: (context) => {
        toolTrace.push({
          toolName: context.toolCall.name,
          args: context.args,
          isError: context.isError,
          details: context.result.details,
        });
        return undefined;
      },
    });

    try {
      await director.prompt(
        'Continue the early classroom goal. Answer the mechanism question whose scene identity was established earlier.',
      );
      await director.waitForIdle();

      const compactionTrace = compactionRuntime.getTrace();
      const postRead = toolTrace.find((entry) => entry.toolName === 'read_scene');
      const postDelegation = toolTrace.find((entry) => entry.toolName === 'call_agent');
      const visibleChildAnswer = childTurns.map((turn) => turn.contentPreview).join('\n');

      expect(compactionTrace.triggerCount).toBeGreaterThanOrEqual(1);
      expect(compactionTrace.failures).toEqual([]);
      expect(directorContexts[0]).toContain(SUMMARY_MARKER);
      expect(postRead).toMatchObject({
        args: { sceneId: TARGET_SCENE_ID },
        isError: false,
        details: {
          status: 'ok',
          sceneId: TARGET_SCENE_ID,
          revision: '42',
          source: 'request_start_snapshot',
        },
      });
      expect(postDelegation).toMatchObject({
        isError: false,
        details: {
          agentId: teacher.id,
          sceneEvidence: [
            {
              sceneId: TARGET_SCENE_ID,
              revision: '42',
              source: 'request_start_snapshot',
            },
          ],
        },
      });
      expect(installedPackets.length).toBeGreaterThanOrEqual(2);
      expect(consumedPackets).toHaveLength(2);
      expect(consumedPackets[1]?.[0]).not.toBe(consumedPackets[0]?.[0]);
      expect(mocks.childContexts[0]).toContain(`sceneId=${TARGET_SCENE_ID}`);
      expect(mocks.childContexts[0]).toContain('revision=42');
      expect(mocks.childContexts[0]).toContain('source=request_start_snapshot');
      expect(mocks.childContexts[0]).not.toContain(STALE_PACKET_MARKER);
      expect(mocks.childContexts[0]).toContain(SCENE_TRUTH);
      expect(visibleChildAnswer).toContain(SCENE_TRUTH);
      expect(events.some((event) => event.type === 'agent_start')).toBe(true);
      console.info(
        '[COMPACTION-REFETCH-01]',
        JSON.stringify({
          compactionTriggerCount: compactionTrace.triggerCount,
          postCompactionReadSceneCount: toolTrace.filter(
            (entry) => entry.toolName === 'read_scene' && !entry.isError,
          ).length,
          callAgentSceneEvidence: (
            postDelegation?.details as { sceneEvidence?: DirectorSceneEvidenceMetadata[] }
          )?.sceneEvidence,
          stalePacketReused: mocks.childContexts[0]?.includes(STALE_PACKET_MARKER) ?? false,
          finalChildAnswer: visibleChildAnswer,
        }),
      );
    } finally {
      compactionRuntime.dispose();
    }
  });
});
