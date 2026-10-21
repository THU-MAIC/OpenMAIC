/**
 * In-process Pi classroom run shared by the orchestration evals.
 *
 * Calls the real runPiDirectorLoop with the defaults /api/chat/pi applies to
 * an in-class request: agent configs and budgets from lib/chat/pi/config,
 * whiteboard tools on (the app always enables them for classroom requests),
 * thinking off, and the legacy child runtime. The model resolved for the eval
 * drives the whole chain — Director and child alike — as the route does.
 *
 * This bypasses the HTTP route, so it does not exercise the route's model
 * authorization or tool-capability checks.
 */

import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';
import {
  getPiMaxActionsPerAgent,
  getPiMaxAgentTurns,
  resolveAgentConfigs,
} from '@/lib/chat/pi/config';
import type { DirectorToolTraceEntry } from '@/lib/chat/pi/types';
import { getActionsForRole } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { resolveEvalModel } from '../shared/resolve-model';
import type { ScenarioAgent } from './types';

export type EvalModel = Pick<Awaited<ReturnType<typeof resolveEvalModel>>, 'model' | 'modelInfo'>;

export type PiDone = Extract<StatelessEvent, { type: 'done' }>['data'];

type RequestAgentConfig = NonNullable<StatelessChatRequest['config']['agentConfigs']>[number];

/** A scenario agent as a request agent config, with its role's canonical actions. */
export function scenarioAgentConfig(
  agent: ScenarioAgent & { persona?: string },
): RequestAgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    persona: agent.persona ?? '',
    avatar: '',
    color: '#6d28d9',
    allowedActions: getActionsForRole(agent.role),
    priority: agent.priority,
  };
}

export interface PiRun {
  events: StatelessEvent[];
  done: PiDone;
}

/**
 * Run one Pi classroom request. Throws when the run fails, is aborted, or
 * ends without a done event — callers count that as a run error.
 */
export async function runPiClassroomRequest(
  request: StatelessChatRequest,
  evalModel: EvalModel,
  signal?: AbortSignal,
): Promise<PiRun> {
  const body: StatelessChatRequest = {
    ...request,
    config: { ...request.config, piEnableWhiteboardTools: true },
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });

  const events: StatelessEvent[] = [];
  try {
    await runPiDirectorLoop({
      body,
      agentConfigs: resolveAgentConfigs(body),
      send: async (event) => {
        events.push(event);
      },
      languageModel: evalModel.model,
      thinkingConfig: { mode: 'disabled', enabled: false },
      maxOutputTokens: evalModel.modelInfo?.outputWindow,
      contextWindow: evalModel.modelInfo?.contextWindow,
      abortSignal: controller.signal,
      signal: controller.signal,
      maxAgentTurns: getPiMaxAgentTurns(body),
      maxActionsPerAgent: getPiMaxActionsPerAgent(body),
      enableWhiteboardTools: true,
      childRuntimeMode: 'legacy',
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }

  if (controller.signal.aborted) throw new Error('Pi run aborted');
  const done = events.find(
    (event): event is Extract<StatelessEvent, { type: 'done' }> => event.type === 'done',
  );
  if (!done) throw new Error('Pi run ended without a done event');
  return { events, done: done.data };
}

/** The Director's call_agent tool calls in the order they ran. */
export function callAgentTrace(done: PiDone): DirectorToolTraceEntry[] {
  return (done.directorToolTrace ?? []).filter((entry) => entry.toolName === 'call_agent');
}
