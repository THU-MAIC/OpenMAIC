import { convertToLlm, type AgentTool } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary, WhiteboardActionRecord } from '@/lib/orchestration/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import { buildDirectorPrompt, buildUserPrompt, toHistoryMessages } from './prompts';
import { createDirectorCompactionRuntime } from './director-compaction';
import type { DirectorToolTraceEntry, SendEvent } from './types';
import { buildCallAgentTool } from './tools/call-agent';
import { buildCloseSessionTool } from './tools/close-session';
import { buildCueUserTool } from './tools/cue-user';
import {
  buildReadSceneTool,
  type DirectorSceneEvidenceMetadata,
  type DirectorSceneEvidencePacket,
} from './tools/read-scene';
import {
  buildDirectorWebSearchTool,
  type DirectorWebEvidencePacket,
  type DirectorWebEvidenceMetadata,
} from './tools/web-search';

function formatWebEvidenceForDelegation(evidence: DirectorWebEvidencePacket): string {
  return [
    `Query: ${evidence.query}`,
    `Retrieved at: ${evidence.retrievedAt}`,
    evidence.answer ? `Search answer: ${evidence.answer}` : '',
    'Exact sources:',
    ...evidence.sources.map(
      (source, index) =>
        `${index + 1}. ${source.title}\nURL: ${source.url}\nExcerpt: ${source.excerpt}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSceneEvidenceForDelegation(evidence: DirectorSceneEvidencePacket[]): string {
  return evidence.map((packet) => packet.content).join('\n\n');
}

export async function runPiDirectorLoop(opts: {
  body: StatelessChatRequest;
  agentConfigs: AgentConfig[];
  send: SendEvent;
  languageModel: LanguageModel;
  thinkingConfig: ThinkingConfig;
  maxOutputTokens?: number;
  contextWindow?: number;
  abortSignal: AbortSignal;
  signal: AbortSignal;
  maxAgentTurns: number;
  maxActionsPerAgent: number;
  enableWhiteboardTools: boolean;
  enableWebSearch?: boolean;
}): Promise<void> {
  let totalAgents = 0;
  let totalActions = 0;
  let agentHadContent = false;
  let userCued = false;
  let sessionClosed = false;
  let endReason: string | undefined;
  let directorToolCalls = 0;
  const pendingSceneEvidence = new Map<string, DirectorSceneEvidencePacket>();
  let latestWebEvidence: DirectorWebEvidencePacket | undefined;
  const directorToolTrace: DirectorToolTraceEntry[] = [];
  const maxDirectorToolCalls = Math.max(opts.maxAgentTurns * 3, opts.maxAgentTurns + 3);
  const piAgentResponses: AgentTurnSummary[] = [];
  const piWhiteboardLedger: WhiteboardActionRecord[] = [];
  const getAgentTurnCount = (): number => piAgentResponses.length;
  const isTeachingSubstantiveTurn = (summary: AgentTurnSummary): boolean => {
    const agent = opts.agentConfigs.find((candidate) => candidate.id === summary.agentId);
    return (
      (agent?.role === 'teacher' || agent?.role === 'assistant') &&
      (summary.contentPreview.trim().length > 0 || summary.actionCount > 0)
    );
  };
  const hasTeachingSubstantiveTurn = (): boolean =>
    piAgentResponses.some(isTeachingSubstantiveTurn);
  const hasVisibleAgentTurn = (): boolean =>
    piAgentResponses.some((summary) => summary.contentPreview.trim().length > 0);
  const hasAgentContent = (): boolean =>
    piAgentResponses.some(
      (summary) => summary.contentPreview.trim().length > 0 || summary.actionCount > 0,
    );
  const cueUser = async (
    data: Extract<StatelessEvent, { type: 'cue_user' }>['data'],
  ): Promise<boolean> => {
    if (userCued) return false;
    userCued = true;
    await opts.send({ type: 'cue_user', data });
    return true;
  };
  const closeSession = async (data: { endReason?: string }): Promise<boolean> => {
    if (sessionClosed || userCued) return false;
    sessionClosed = true;
    endReason = data.endReason;
    return true;
  };

  const streamFn = createCallLlmStreamFn({
    languageModel: opts.languageModel,
    maxOutputTokens: opts.maxOutputTokens,
    thinkingConfig: opts.thinkingConfig,
    source: 'pi-chat-director',
    abortSignal: opts.abortSignal,
  });
  const compactionRuntime = createDirectorCompactionRuntime({
    streamFn,
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens,
  });

  const tools: AgentTool[] = [
    buildReadSceneTool({
      body: opts.body,
      onEvidence: (evidence) => {
        pendingSceneEvidence.set(evidence.details.sceneId, evidence);
      },
    }),
    ...(opts.enableWebSearch
      ? [
          buildDirectorWebSearchTool({
            stageId: opts.body.storeState.stage?.id,
            onSearchStart: () => {
              latestWebEvidence = undefined;
            },
            onEvidence: (evidence) => {
              latestWebEvidence = evidence;
            },
          }),
        ]
      : []),
    buildCallAgentTool({
      body: opts.body,
      agentConfigs: opts.agentConfigs,
      send: opts.send,
      languageModel: opts.languageModel,
      onAgentDone: (summary) => {
        totalAgents += 1;
        if (summary.contentPreview || summary.actionCount > 0) agentHadContent = true;
        piAgentResponses.push(summary);
      },
      onActionDone: (record) => {
        totalActions += 1;
        if (record) piWhiteboardLedger.push(record);
      },
      thinkingConfig: opts.thinkingConfig,
      maxOutputTokens: opts.maxOutputTokens,
      abortSignal: opts.abortSignal,
      maxAgentTurns: opts.maxAgentTurns,
      getAgentTurnCount,
      getAgentResponses: () => [
        ...(opts.body.directorState?.agentResponses ?? []),
        ...piAgentResponses,
      ],
      // storeState is already the request-start whiteboard snapshot, so replay
      // only mutations produced during this request in child-agent prompts.
      getWhiteboardLedger: () => piWhiteboardLedger,
      maxActionsPerAgent: opts.maxActionsPerAgent,
      enableWhiteboardTools: opts.enableWhiteboardTools,
      isUserCued: () => userCued,
      isSessionClosed: () => sessionClosed,
      takeSceneEvidence: () => {
        if (pendingSceneEvidence.size === 0) return undefined;
        const packets = [...pendingSceneEvidence.values()];
        pendingSceneEvidence.clear();
        return {
          content: formatSceneEvidenceForDelegation(packets),
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
      },
      takeWebEvidence: () => {
        const evidence = latestWebEvidence;
        latestWebEvidence = undefined;
        if (!evidence) return undefined;
        const metadata: DirectorWebEvidenceMetadata = {
          query: evidence.query,
          retrievedAt: evidence.retrievedAt,
          sourceCount: evidence.sources.length,
        };
        return {
          content: formatWebEvidenceForDelegation(evidence),
          metadata,
        };
      },
    }),
    buildCloseSessionTool({
      closeSession,
      canCloseSession: hasVisibleAgentTurn,
      isUserCued: () => userCued,
    }),
    buildCueUserTool({
      cueUser,
      getLastAgentId: () => piAgentResponses.at(-1)?.agentId,
      canCueUser: hasTeachingSubstantiveTurn,
      cueUserSkipReason: 'no_substantive_teaching_turn',
      isSessionClosed: () => sessionClosed,
    }),
  ];

  const director = buildAgent({
    streamFn,
    systemPrompt: buildDirectorPrompt(opts.body, opts.agentConfigs, opts.maxAgentTurns, {
      enableWebSearch: opts.enableWebSearch,
    }),
    tools,
    allowedToolNames: new Set(tools.map((tool) => tool.name)),
    history: toHistoryMessages(opts.body.messages, null),
    transformContext: compactionRuntime.transformContext,
    convertToLlm,
    afterToolCall: (context) => {
      directorToolCalls += 1;
      const evidenceStatus =
        context.toolCall.name === 'read_scene' || context.toolCall.name === 'web_search'
          ? (context.result.details as { status?: string } | undefined)?.status
          : undefined;
      const evidenceError = evidenceStatus !== undefined && evidenceStatus !== 'ok';
      const isError = context.isError || evidenceError;
      const resultPreview = context.result.content
        .map((content) => (content.type === 'text' ? content.text : '[image]'))
        .join('\n')
        .slice(0, 800);
      directorToolTrace.push({
        sequence: directorToolCalls,
        toolName: context.toolCall.name,
        args: context.args,
        isError,
        resultPreview,
        details: context.result.details,
      });
      const terminate = sessionClosed || userCued || directorToolCalls >= maxDirectorToolCalls;
      if (!terminate && !evidenceError) return undefined;
      return {
        ...(terminate ? { terminate: true } : {}),
        ...(evidenceError ? { isError: true } : {}),
      };
    },
  });

  try {
    await director.prompt(buildUserPrompt(opts.body));
    await director.waitForIdle();
  } finally {
    compactionRuntime.dispose();
  }

  if (opts.signal.aborted) return;

  if (!sessionClosed && !userCued && hasAgentContent()) {
    await cueUser({ fromAgentId: piAgentResponses.at(-1)?.agentId });
  }

  await opts.send({
    type: 'done',
    data: {
      totalActions,
      totalAgents,
      agentHadContent,
      cueUserReceived: userCued,
      sessionClosed,
      endReason,
      directorCompaction: compactionRuntime.getTrace(),
      directorToolTrace,
      directorState: {
        turnCount: getAgentTurnCount(),
        agentResponses: [...(opts.body.directorState?.agentResponses ?? []), ...piAgentResponses],
        // Return only this turn's whiteboard mutations. The cross-turn board
        // state is carried by storeState's request-start snapshot, and Pi child
        // prompts replay only the current-turn ledger (see getWhiteboardLedger
        // above), so persisting the historical ledger just inflated session
        // state and follow-up payloads without being read back.
        whiteboardLedger: piWhiteboardLedger,
      },
    },
  });
}
