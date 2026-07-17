import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary, WhiteboardActionRecord } from '@/lib/orchestration/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import { buildDirectorPrompt, buildUserPrompt, toHistoryMessages } from './prompts';
import type { SendEvent } from './types';
import { buildCallAgentTool } from './tools/call-agent';
import { buildCloseSessionTool } from './tools/close-session';
import { buildCueUserTool } from './tools/cue-user';

export async function runPiDirectorLoop(opts: {
  body: StatelessChatRequest;
  agentConfigs: AgentConfig[];
  send: SendEvent;
  languageModel: LanguageModel;
  thinkingConfig: ThinkingConfig;
  maxOutputTokens?: number;
  abortSignal: AbortSignal;
  signal: AbortSignal;
  maxAgentTurns: number;
  maxActionsPerAgent: number;
  enableWhiteboardTools: boolean;
}): Promise<void> {
  let totalAgents = 0;
  let totalActions = 0;
  let agentHadContent = false;
  let userCued = false;
  let sessionClosed = false;
  let teacherWrapUpUsed = false;
  let endReason: string | undefined;
  let directorToolCalls = 0;
  const maxDirectorToolCalls = Math.max(opts.maxAgentTurns * 3, opts.maxAgentTurns + 3);
  const piAgentResponses: AgentTurnSummary[] = [];
  const piWhiteboardLedger: WhiteboardActionRecord[] = [];
  const getNormalTurnCount = (): number =>
    piAgentResponses.filter((summary) => summary.turnKind !== 'wrap_up').length;
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

  const tools: AgentTool[] = [
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
      getAgentTurnCount: getNormalTurnCount,
      getAgentResponses: () => [
        ...(opts.body.directorState?.agentResponses ?? []),
        ...piAgentResponses,
      ],
      // storeState is already the request-start whiteboard snapshot, so replay
      // only mutations produced during this request in child-agent prompts.
      getWhiteboardLedger: () => piWhiteboardLedger,
      maxActionsPerAgent: opts.maxActionsPerAgent,
      enableWhiteboardTools: opts.enableWhiteboardTools,
      isTeacherWrapUpUsed: () => teacherWrapUpUsed,
      onTeacherWrapUpDone: () => {
        teacherWrapUpUsed = true;
      },
      isUserCued: () => userCued,
      isSessionClosed: () => sessionClosed,
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
    systemPrompt: buildDirectorPrompt(opts.body, opts.agentConfigs, opts.maxAgentTurns),
    tools,
    allowedToolNames: new Set(tools.map((tool) => tool.name)),
    history: toHistoryMessages(opts.body.messages),
    afterToolCall: () => {
      directorToolCalls += 1;
      if (sessionClosed || userCued || directorToolCalls >= maxDirectorToolCalls) {
        return { terminate: true };
      }
      return undefined;
    },
  });

  await director.prompt(buildUserPrompt(opts.body));
  await director.waitForIdle();

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
      directorState: {
        turnCount: getNormalTurnCount(),
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
