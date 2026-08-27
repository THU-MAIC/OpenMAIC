/**
 * Lease-coordinated background execution for durable agent conversations.
 *
 * Every application process may run this loop. PostgreSQL is the authority for
 * claims, lease generations, event ordering, cancellation, and conversation
 * recovery. A client connection is never part of the execution lifetime.
 */
import { randomUUID } from 'node:crypto';
import { Session, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core';
import {
  AgentSessionLeaseLostError,
  type AgentSessionClaimReason,
  type AgentSessionMeta,
  type AgentSessionUserMessage,
  type ClaimedAgentSession,
} from '@openmaic/storage';

import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { HOST_AGENT_LIFECYCLE as LIFECYCLE } from '@/lib/agent-runtime/lifecycle';
import { createLogger } from '@/lib/logger';

import { resolveAgentDriverModel } from './agent-driver-model';
import { buildAskUserTool } from './ask-user';
import { agentRuntimeConfig as config } from './config';
import { buildCreateSkillTool } from './create-skill';
import {
  buildDslCourseToolset,
  withOwnerStageAuthorization,
  type CourseStore,
} from './course-tools';
import {
  buildCurriculumTools,
  CURRICULUM_ALLOWLIST,
  CURRICULUM_TOOLS_PROMPT,
  probeStageAccess,
} from './curriculum-tools';
import {
  buildFetchUrlTool,
  fetchPromptBlock,
  untrustedContentPolicyPromptBlock,
} from './fetch-url';
import { assembleRunnerTools, buildRunnerCoursePrompt } from './runner-contract';
import { buildMaterialTools, MATERIAL_TOOL_NAMES } from './material-tools';
import { buildRosterTools, ROSTER_TOOL_NAMES, ROSTER_TOOLS_PROMPT } from './roster-tools';
import {
  buildVoiceCloneTools,
  hasConfiguredVoiceRegistrationCapability,
  VOICE_CLONE_TOOL_NAMES,
  voiceCloneToolsPrompt,
} from './voice-clone-tools';
import type { RegisteredVoiceInfo } from '@/lib/audio/voice-catalog';
import { buildSkillEditTools, SKILL_EDIT_TOOL_NAMES } from './skill-edit-tools';
import { buildWebSearchTool, resolveWebSearchCapability, searchPromptBlock } from './web-search';
import { buildSkillPreload, preloadUserMessage } from './skill-preload';
import { listSessionMaterials, sessionMaterialsPromptBlock } from './session-materials';
import {
  availableSkillsPromptBlock,
  createNativeSkillReadTool,
  findSkill,
  listSkills,
} from './skills';
import { registerSessionUrls } from './session-urls';
import { buildScenePreviewTools } from './scene-preview';
import {
  AgentSessionEntryStorage,
  loadSessionEntryHistory,
  type SessionEntryHistory,
} from './entry-tree-storage';
import { planResume, type ResumeAction } from './resume';
import {
  appendInterruptedToolCallResults,
  repairOrphanedToolCalls,
  trackToolCallMessage,
  type PendingToolCall,
} from './tool-call-integrity';
import { getAgentSessionStore } from './store';
import { subscribeAgentEventWakeup } from './event-notify-bus';
import { getOwnerScopedDocumentStore } from './owner-scoped-documents';

const log = createLogger('AgentRunner');
const WORKER_ID = `${randomUUID().slice(0, 8)}:${process.pid}`;
const SESSION_WAKEUP_FALLBACK_MS = 5_000;
const MESSAGE_UPDATE_MIN_INTERVAL_MS = 150;

/** The runner's always-registered tool; additional tools are capability-gated. */
export const MINIMAL_AGENT_TOOL_NAMES = new Set(['ask_user']);

/**
 * System prompt for a run with the given registered toolset, assembled by
 * `buildRunnerCoursePrompt` (runner-contract.ts): the shared base lines from
 * course-tools.ts, the DSL compatibility block (always present), and every
 * capability block that is actually registered — the web-search block only
 * when a web-search backend is configured, the curriculum block always, the
 * skill discovery block when skills are installed, the fetch_url guidance
 * and untrusted-content policy always (fetch_url is always registered), and
 * the session-materials block only when the session has materials.
 */
function isLeaseLostError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    if (current instanceof AgentSessionLeaseLostError) return true;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A required tree write cannot be downgraded to telemetry. */
export async function writeRequiredSessionEntry(
  write: () => Promise<void>,
  onLeaseLost: () => void,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (isLeaseLostError(error)) {
      onLeaseLost();
      return;
    }
    throw error;
  }
}

interface RunResultMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function messageContentLength(message: unknown): number {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 0;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((length, block) => {
    if (typeof block === 'string') return length + block.length;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return length;
    const text = (block as { text?: unknown }).text;
    const thinking = (block as { thinking?: unknown }).thinking;
    return (
      length +
      (typeof text === 'string' ? text.length : 0) +
      (typeof thinking === 'string' ? thinking.length : 0)
    );
  }, 0);
}

function slimRunResultMessage(message: unknown): RunResultMessage {
  const source = (message ?? {}) as RunResultMessage;
  return {
    role: source.role,
    stopReason: source.stopReason,
    errorMessage: source.errorMessage,
  };
}

const TOOL_RESULT_LOG_FIELDS = ['role', 'toolCallId', 'toolName', 'isError', 'timestamp'] as const;

function slimToolResultsForLog(toolResults: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(toolResults)) return null;
  const results: Record<string, unknown>[] = [];
  for (const result of toolResults) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const source = result as Record<string, unknown>;
    if (
      source.role !== 'toolResult' ||
      typeof source.toolCallId !== 'string' ||
      typeof source.toolName !== 'string' ||
      typeof source.isError !== 'boolean' ||
      typeof source.timestamp !== 'number' ||
      !Array.isArray(source.content)
    ) {
      return null;
    }
    const slimmed: Record<string, unknown> = {};
    for (const field of TOOL_RESULT_LOG_FIELDS) slimmed[field] = source[field];
    results.push(slimmed);
  }
  return results;
}

/** Keep replay payloads small without mutating pi's recovery transcript. */
export function slimEventDataForLog(type: string, data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const source = data as Record<string, unknown>;

  if (type === 'agent_end' && Array.isArray(source.messages)) {
    const last = source.messages[source.messages.length - 1];
    return {
      ...source,
      messageCount: source.messages.length,
      lastMessageContentLength: messageContentLength(last),
      messages: last === undefined ? [] : [slimRunResultMessage(last)],
    };
  }

  if (type === 'turn_end') {
    const slimmed: Record<string, unknown> = {
      ...source,
      ...(source.message === undefined ? {} : { message: slimRunResultMessage(source.message) }),
    };
    if (source.toolResults !== undefined) {
      const toolResults = slimToolResultsForLog(source.toolResults);
      if (toolResults === null) {
        log.warn(
          'turn_end toolResults shape unrecognized; preserving original payload via deep clone',
        );
        try {
          slimmed.toolResults = structuredClone(source.toolResults);
        } catch (error) {
          log.warn(
            'turn_end toolResults deep clone failed; preserving original payload reference',
            error,
          );
          slimmed.toolResults = source.toolResults;
        }
      } else {
        slimmed.toolResults = toolResults;
      }
    }
    return slimmed;
  }

  if (type === 'tool_execution_update') {
    const slimmed = { ...source };
    delete slimmed.args;
    delete slimmed.partialResult;
    return slimmed;
  }

  if (type === 'message_start' || type === 'message_end') {
    const message = source.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const messageSource = message as Record<string, unknown>;
      if (messageSource.role === 'toolResult') {
        return { ...source, message: { ...messageSource, content: [] } };
      }
    }
  }
  return data;
}

/** The cap itself is a legal run; a claim after it is a verdict-only claim. */
export function isOverAttemptCap(meta: { attempt: number }): boolean {
  return meta.attempt > config.maxAttempts;
}

const RUN_LIFECYCLE_EVENT_TYPES = new Set<string>([
  LIFECYCLE.sessionStart,
  LIFECYCLE.sessionResumed,
  LIFECYCLE.sessionInterrupted,
  LIFECYCLE.sessionEnd,
]);

/** Runtime tripwire for the client's attempt-reset fence. */
export function markRunEventEmitted(alreadyEmitted: boolean, type: string): boolean {
  return alreadyEmitted || RUN_LIFECYCLE_EVENT_TYPES.has(type);
}

export const LENGTH_STOP_ERROR =
  'model output hit the max token limit and was truncated; this run did not finish';

export function terminalLoopError(
  messages: readonly AgentMessage[],
  errorMessage: string | undefined,
): string | undefined {
  if (errorMessage) return errorMessage;
  const lastAssistant = messages.findLast((message) => message.role === 'assistant') as
    | (AgentMessage & { stopReason?: unknown })
    | undefined;
  return lastAssistant?.stopReason === 'length' ? LENGTH_STOP_ERROR : undefined;
}

export type UndeliveredRequeueAction = 'none' | 'reset' | 'retry';

/** Classify undelivered work relative to the exact claim watermark. */
export function planUndeliveredRequeue(input: {
  logged: { seq: number; ts: number }[];
  handled: number;
  claimSeq: number;
  atVerdict: boolean;
}): UndeliveredRequeueAction {
  const undelivered = input.logged.slice(input.handled);
  if (undelivered.length === 0) return 'none';
  if (undelivered.some((message) => message.seq > input.claimSeq)) return 'reset';
  return input.atVerdict ? 'none' : 'retry';
}

export type RunStart = { kind: 'prompt'; text: string } | { kind: 'continue' };

export interface FollowUpMessage {
  text: string;
  materials?: Array<{
    materialId?: string;
    originalName?: string;
    mime?: string;
    bytes?: number;
  }>;
}

/** Derive delivery from the immutable entry sequence, not in-memory state. */
export function loggedMessageCursor(input: {
  transcriptUserCount: number;
  firstTranscriptUserText?: string;
  loggedCount: number;
  firstLoggedText?: string;
  idleAttach?: boolean;
}): { idle: boolean; delivered: number } {
  const idle = input.idleAttach === true;
  return {
    idle,
    delivered: idle ? input.transcriptUserCount : Math.max(0, input.transcriptUserCount - 1),
  };
}

export function composeFollowUpText(message: FollowUpMessage): string {
  if (!message.materials?.length) return message.text;
  const list = message.materials
    .map((material) => {
      const id = material.materialId ?? 'attached material';
      const mime = material.mime ?? 'unknown mime';
      return `"${material.originalName ?? id}" (${mime}, ${material.bytes ?? 0} bytes)`;
    })
    .join(', ');
  return `${message.text}\n\n[The user attached session material: ${list}. It is registered with this session; use use_material_media when it contains embeddable image, video, or audio bytes.]`;
}

export function planRunStart(input: {
  plan: ResumeAction;
  claimReason: AgentSessionClaimReason;
  pending: FollowUpMessage[];
  prompt: string;
  idleAttach?: boolean;
}): RunStart {
  if (input.plan.kind === 'start' && input.pending.length > 0 && input.idleAttach) {
    return { kind: 'prompt', text: composeFollowUpText(input.pending[0]!) };
  }
  if (input.plan.kind === 'start') return { kind: 'prompt', text: input.prompt };
  if (input.claimReason === 'queued' && input.pending.length > 0) {
    return { kind: 'prompt', text: composeFollowUpText(input.pending[0]!) };
  }
  return { kind: 'continue' };
}

export function shouldTerminateAfterToolCall(toolName: string, isError: boolean): boolean {
  return toolName === 'ask_user' && !isError;
}

/** Make successful ask_user termination sticky across a mixed tool batch. */
export function createAskUserTerminateLatch(): {
  shouldTerminate(toolName: string, isError: boolean): boolean;
} {
  let committed = false;
  return {
    shouldTerminate(toolName, isError) {
      if (shouldTerminateAfterToolCall(toolName, isError)) committed = true;
      return committed;
    },
  };
}

export interface AgentRunnerHandle {
  readonly workerId: string;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface RunContext {
  running: Map<string, { abort: AbortController }>;
  shuttingDown: boolean;
}

function toFollowUp(message: AgentSessionUserMessage): FollowUpMessage {
  return {
    text: message.text,
    ...(message.materials.length
      ? { materials: message.materials as FollowUpMessage['materials'] }
      : {}),
  };
}

function leaseMatches(
  session: AgentSessionMeta | null,
  workerId: string,
  attempt: number,
): boolean {
  return session?.lease?.workerId === workerId && session.attempt === attempt;
}

// Session execution is intentionally one large state machine: its nested
// finally blocks pair every timer, subscription, and agent listener with the
// exact lifetime in which it can fire.
export async function runSession(ctx: RunContext, meta: ClaimedAgentSession): Promise<void> {
  const id = meta.id;
  const attempt = meta.attempt;
  const claimSeq = meta.claimSeq;
  const abort = new AbortController();
  ctx.running.set(id, { abort });

  let store: Awaited<ReturnType<typeof getAgentSessionStore>>;
  try {
    store = await getAgentSessionStore();
  } catch (error) {
    ctx.running.delete(id);
    throw error;
  }
  let leaseLost = false;
  let cancelled = false;
  let chain: Promise<void> = Promise.resolve();
  let criticalWriteError: unknown;
  let entryWritesHealthy = true;
  let terminalFrameEmitted = false;

  const markLeaseLost = () => {
    leaseLost = true;
    abort.abort();
  };
  const enqueue = (write: () => Promise<void>, critical = false): void => {
    chain = chain.then(async () => {
      if (leaseLost || (critical && !entryWritesHealthy)) return;
      try {
        if (critical) await writeRequiredSessionEntry(write, markLeaseLost);
        else await write();
      } catch (error) {
        if (isLeaseLostError(error)) {
          markLeaseLost();
          return;
        }
        log.error(`session ${id}: ${critical ? 'entry' : 'event'} write failed`, error);
        if (critical && criticalWriteError === undefined) {
          entryWritesHealthy = false;
          criticalWriteError = error;
          abort.abort();
        }
      }
    });
  };
  const flushAll = async (propagateEntryFailure = true): Promise<void> => {
    await chain;
    if (propagateEntryFailure && criticalWriteError !== undefined && !leaseLost) {
      throw criticalWriteError;
    }
  };

  let entrySession: Session | undefined;
  const loadEntryHistory = async (): Promise<SessionEntryHistory> => {
    entrySession ??= new Session(
      await AgentSessionEntryStorage.open({ sessionId: id, workerId: WORKER_ID, attempt }),
    );
    return loadSessionEntryHistory(entrySession, {
      sessionId: id,
      hasPriorRun: await store.hasSessionRunHistory(id),
    });
  };

  let runEventEmitted = false;
  let tripwireViolated = false;
  let lastMessageUpdateAt = 0;
  let messageHadThinking = false;
  let thinkingEndPending = false;
  let thinkingEndEmitted = false;

  const appendEvent = (type: string, data: unknown, ts: number): void => {
    enqueue(async () => {
      const seq = await store.appendRunEvent(id, WORKER_ID, {
        ts,
        attempt,
        type,
        data: slimEventDataForLog(type, data),
      });
      if (seq === null) markLeaseLost();
    });
  };

  const emit = (type: string, data: unknown): void => {
    if (!markRunEventEmitted(runEventEmitted, type)) {
      if (!tripwireViolated) {
        tripwireViolated = true;
        log.error(
          `TRIPWIRE VIOLATION session ${id}: first runner event must be lifecycle, got ${type}`,
        );
        abort.abort();
      }
      return;
    }
    runEventEmitted = true;
    if (type === LIFECYCLE.sessionEnd) terminalFrameEmitted = true;
    // Once another worker owns the lease, both the event log and entry tree
    // reject this generation's writes. The new owner's session_resumed frame
    // is therefore the durable interruption marker for a lease steal.
    if (leaseLost) return;

    const now = Date.now();
    const endOwesThinkingEnd = type === 'message_end' && thinkingEndPending && !thinkingEndEmitted;
    if (type === 'message_start' || type === 'message_end') {
      lastMessageUpdateAt = 0;
      messageHadThinking = false;
      thinkingEndPending = false;
      thinkingEndEmitted = false;
    }
    if (type === 'message_start' || type === 'message_update') {
      const message = (data as { message?: { role?: string; content?: unknown[] } })?.message;
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        let hasThinking = false;
        let hasText = false;
        for (const block of message.content as Array<{
          type?: string;
          text?: string;
          thinking?: string;
        }>) {
          if (block?.type === 'thinking' && String(block.thinking ?? '').trim()) {
            hasThinking = true;
          }
          if (block?.type === 'text' && String(block.text ?? '').trim()) hasText = true;
        }
        if (hasThinking) messageHadThinking = true;
        if (hasText && messageHadThinking && !thinkingEndEmitted) thinkingEndPending = true;
      }
    }
    if (type === 'message_update') {
      if (now - lastMessageUpdateAt < MESSAGE_UPDATE_MIN_INTERVAL_MS) return;
      lastMessageUpdateAt = now;
    }

    appendEvent(type, data, now);
    if (type === 'message_update' && thinkingEndPending && !thinkingEndEmitted) {
      thinkingEndPending = false;
      thinkingEndEmitted = true;
      appendEvent(LIFECYCLE.thinkingEnd, {}, now);
    }
    if (endOwesThinkingEnd) {
      thinkingEndEmitted = true;
      appendEvent(LIFECYCLE.thinkingEnd, {}, now);
    }
  };

  /** Every terminal exit checks whether a durable message lacked a consumer. */
  const requeueIfUndelivered = async (why: string, atVerdict = false): Promise<void> => {
    try {
      const logged = await store.listUserMessages(id);
      const history = await loadEntryHistory();
      const users = history.cursorMessages.filter((message) => message.role === 'user');
      const handled = loggedMessageCursor({
        transcriptUserCount: users.length,
        firstTranscriptUserText:
          typeof users[0]?.content === 'string' ? users[0].content : undefined,
        loggedCount: logged.length,
        firstLoggedText: logged[0]?.text,
        idleAttach: meta.existingCourse,
      }).delivered;
      const action = planUndeliveredRequeue({ logged, handled, claimSeq, atVerdict });
      if (action === 'reset' && (await store.requeueSession(id))) {
        log.info(
          `session ${id}: ${logged.length - handled} fresh undelivered message(s) at ${why}; requeued with attempt reset`,
        );
      } else if (action === 'retry' && (await store.requeueForRetry(id))) {
        log.info(
          `session ${id}: ${logged.length - handled} stranded message(s) at ${why}; requeued preserving attempt`,
        );
      }
    } catch (error) {
      log.warn(`session ${id}: post-terminal requeue check (${why}) failed`, error);
    }
  };

  // A verdict claim never executes the model. A message posted after the
  // claim still receives one attended redemption through the common check.
  if (isOverAttemptCap(meta)) {
    try {
      const error =
        `session failed ${config.maxAttempts} consecutive unattended attempts; ` +
        'send a new message to retry';
      emit(LIFECYCLE.sessionEnd, { status: 'failed', error });
      await flushAll();
      await store.finishSession(id, WORKER_ID, { status: 'failed', error });
      await requeueIfUndelivered('over-cap verdict', true);
      return;
    } finally {
      await flushAll(false);
      ctx.running.delete(id);
    }
  }

  const heartbeatTimer = setInterval(() => {
    store
      .heartbeat(id, WORKER_ID)
      .then((held) => {
        if (!held && !leaseLost) {
          log.warn(`session ${id}: lease lost; aborting local run`);
          markLeaseLost();
        }
      })
      .catch((error) => log.warn(`session ${id}: heartbeat failed`, error));
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  // ── NOTIFY wakeup + low-frequency fallback ───────────────────────────────
  //
  // A user message (appendUserMessage/postUserMessage → insertEvent) and
  // requestCancel each send a {kind:'session', sessionId} NOTIFY in the SAME
  // transaction as their durable write. One shared subscription to that route
  // wakes on both — a message and a cancel are indistinguishable at the route
  // level, so each wake runs both cheap point reads (listUserMessages via the
  // drain and isCancelRequested via the cancel check).
  //
  // Deliberately ONE subscription, not two: the bus fans out per route key,
  // so two subscriptions to the same route would sit in the same subscriber
  // set and both fire on every wake anyway — one subscribe/unsubscribe pair
  // is also exactly one lifecycle pairing to get right (the timer-leak class
  // the reference fixed). The wakeup is lossy by design (NOTIFY is not
  // persisted; signals sent while the LISTEN connection is down are dropped),
  // so the polls are not deleted — they are demoted to a 5s correctness
  // backstop.
  let drainOnWake: (() => void) | null = null;
  const checkCancel = (): void => {
    store
      .isCancelRequested(id)
      .then((requested) => {
        if (requested) {
          cancelled = true;
          abort.abort();
        }
      })
      .catch(() => {});
  };
  const unsubscribeWakeup = subscribeAgentEventWakeup({ kind: 'session', sessionId: id }, () => {
    checkCancel();
    drainOnWake?.();
  });

  const cancelPoll = setInterval(checkCancel, SESSION_WAKEUP_FALLBACK_MS);
  cancelPoll.unref?.();

  try {
    const recovery = await loadEntryHistory();
    const historyMessages = recovery.messages;
    const plan = planResume(historyMessages);
    const plannedMessages = plan.kind === 'start' ? [] : plan.messages;
    // planResume now contains durable messages only; synthetic receipts are a
    // read-time provider view owned by repairOrphanedToolCalls.
    const retainedCount = plannedMessages.length;

    // planResume may strip an incomplete suffix. Reflect the truncation in the
    // append-only tree before execution; missing tool results are repaired at
    // the read boundary and are deliberately never persisted.
    if (retainedCount < historyMessages.length) {
      const targetId = retainedCount > 0 ? recovery.contextEntryIds[retainedCount - 1]! : null;
      await writeRequiredSessionEntry(async () => {
        await entrySession!.moveTo(targetId);
      }, markLeaseLost);
    }
    if (leaseLost) throw new AgentSessionLeaseLostError(id, WORKER_ID, attempt);
    // planResume still owns tail classification/truncation, but its synthetic
    // results are a read-time view only. The general repair below also covers
    // old middle-of-history orphans without mutating the entry tree.
    const contextRepair = repairOrphanedToolCalls(plannedMessages);
    const modelMessages = contextRepair.messages;
    const repairedToolCallIds = [
      ...new Set([
        ...(plan.kind === 'continue' ? plan.repairedToolCalls : []),
        ...contextRepair.repairedToolCalls,
      ]),
    ];

    // ── Skills ─────────────────────────────────────────────────────────────────
    // The installed set (builtins + this owner's user-authored skills) is loaded
    // once per run. An explicit API selection (the session's frozen `skillId`)
    // is validated here rather than at claim time; an unavailable skill is a
    // hard error. Automatic activation lives in the transcript: a successful pi
    // `read` of SKILL.md. An explicit selection stays authoritative for this
    // session rather than being silently replaced by a later model read.
    const installedSkills = await listSkills(meta.ownerId);
    const requestedSkill = await findSkill(meta.skillId, meta.ownerId);
    if (meta.skillId && !requestedSkill) {
      throw new Error(`session skill "${meta.skillId}" is unavailable for its owner`);
    }
    // NOTE: the reference runtime keeps an `activeSkill` pointer (an explicit
    // API selection, else the last successfully-read SKILL.md, else what the
    // turn NAMED via `preloadConstraintTarget`) that feeds the course toolset's
    // `getActiveSkill` and the deferred `checkScenesAgainstSkill`. Both belong
    // to the course-toolset slice; the preload below already delivers every
    // chosen skill as a durable `read`, which is what activation is made of.
    const skillReadTool = installedSkills.length
      ? createNativeSkillReadTool(installedSkills, () => undefined)
      : null;

    const loggedMessages = await store.listUserMessages(id);
    const historyUsers = recovery.cursorMessages.filter((message) => message.role === 'user');
    const cursor = loggedMessageCursor({
      transcriptUserCount: historyUsers.length,
      firstTranscriptUserText:
        typeof historyUsers[0]?.content === 'string' ? historyUsers[0].content : undefined,
      loggedCount: loggedMessages.length,
      firstLoggedText: loggedMessages[0]?.text,
      idleAttach: meta.existingCourse,
    });
    const followUpsDelivered = cursor.delivered;
    const pending = loggedMessages.slice(followUpsDelivered).map(toFollowUp);
    const idleAttach = cursor.idle;

    if (plan.kind === 'already-complete' && pending.length === 0) {
      emit(LIFECYCLE.sessionEnd, {
        status: 'succeeded',
        note: 'entry history already terminal',
      });
      await flushAll();
      await store.finishSession(id, WORKER_ID, {
        status: 'succeeded',
        resetAttempt: true,
      });
      await requeueIfUndelivered('early settle');
      return;
    }

    if (plan.kind === 'start' && (pending.length === 0 || !idleAttach)) {
      emit(LIFECYCLE.sessionStart, {
        workerId: WORKER_ID,
        pid: process.pid,
        prompt: meta.prompt,
      });
    } else {
      emit(LIFECYCLE.sessionResumed, {
        workerId: WORKER_ID,
        pid: process.pid,
        attempt,
        reason: plan.kind === 'start' || meta.claimReason === 'queued' ? 'follow_up' : 'crash',
        transcriptMessages: modelMessages.length,
        repairedToolCalls: repairedToolCallIds,
      });
    }

    const plannedStart = planRunStart({
      plan,
      claimReason: meta.claimReason,
      pending,
      prompt: meta.prompt,
      idleAttach,
    });
    const driver = await resolveAgentDriverModel();
    const streamFn = createCallLlmStreamFn({
      languageModel: driver.connection.model,
      maxOutputTokens: driver.wireMaxOutputTokens,
      omitMaxOutputTokens: driver.wireMaxOutputTokens === undefined,
      thinkingConfig: driver.connection.thinkingConfig,
      source: 'agent-runtime',
      abortSignal: abort.signal,
    });
    const askUserTool = buildAskUserTool({
      onUserQuestion: (question) => emit(LIFECYCLE.userQuestion, question),
    });
    // web_search is capability-registered: the tool exists in the toolset
    // exactly when this deployment has a working web-search backend. An
    // unconfigured deployment gets no tool, so the model never sees a dead one.
    // Every result URL is registered with this session's durable URL trust
    // gate before the tool result is returned (reference semantics).
    const search = resolveWebSearchCapability();
    const webSearchTools = search
      ? [
          buildWebSearchTool(search, (urls) =>
            registerSessionUrls(id, urls, 'web_search').then(() => undefined),
          ),
        ]
      : [];
    // The owner-bound document store: ONE store per run, bound to the claimed
    // session's owner, shared by every stage tool. The owner id is
    // deliberately absent from every model-visible parameter — the model cannot
    // forge a target owner. Reads are capability-by-id and foreign writes are
    // refused. `withPlainJsonDocumentWrites` strips
    // undefined-valued members at the write boundary so a JSON pointer `set`
    // that carries them never persists a JSON-null key (reference semantics).
    // `getAgentSessionStore` above already guards on DATABASE_URL, so the
    // provider can only be reached with a configured connection string.
    const ownerScopedStore = (await getOwnerScopedDocumentStore(meta.ownerId)) as CourseStore;
    // The owner probe is the tool layer's legality boundary: every course call
    // declares its stageId, and stageAccess resolves that stage against the
    // session owner (owned / foreign / missing / tombstoned) before the tool
    // touches the store. One probe factory is threaded into the course+DSL
    // toolset, the curriculum toolset, and the scene-preview tool (reference
    // semantics: three call sites, one probe).
    const stageAccess = (stageId: string) => probeStageAccess(meta.ownerId, stageId);
    // The stage read/patch toolset and the stage-level CRUD it needs. All of
    // them write through `ownerScopedStore`; every stageId-bearing tool is
    // owner-gated by `withOwnerStageAuthorization`, and patch_stage is marked
    // sequential by the shared STAGE_WRITER_TOOL_NAMES registry
    // (course-tools.ts).
    const dslTools = buildDslCourseToolset({
      store: ownerScopedStore,
      stageAccess,
      onCheckpoint: (info) => emit(LIFECYCLE.checkpoint, info),
      sessionId: id,
      abortSignal: abort.signal,
    });
    const curriculumTools = buildCurriculumTools({
      store: ownerScopedStore,
      ownerId: meta.ownerId,
      sessionId: id,
      stageAccess,
      onStageLink: (course) => emit(LIFECYCLE.stageLink, course),
      onLibraryChanged: (change) => emit(LIFECYCLE.libraryChanged, change),
      onCheckpoint: (info) => emit(LIFECYCLE.checkpoint, info),
    });
    // Scene preview is registered beside the course toolset with its own
    // owner probe (reference semantics) — it is not wrapped by the generic
    // stage authorization of the course toolset, and it refuses a foreign
    // stage with its own message shape. It contributes nothing when the
    // render service is not configured.
    const scenePreviewTools = buildScenePreviewTools({
      store: ownerScopedStore,
      stageAccess,
      ownerId: meta.ownerId,
    });
    // Session-scoped material tools and the materials prompt block are wired
    // from durable session identity on every start and resume (reference
    // semantics: the material tools are always registered alongside the
    // capability-gated web_search). The listing only feeds the prompt block;
    // the tools read through the same session-scoped store on each call.
    const materials = await listSessionMaterials(id);
    const materialTools = buildMaterialTools({ sessionId: id });
    // Session-scoped registered voices: register_voice appends here, and
    // list_voices / set_roster (roster-tools) read the same array, so a cloned
    // voice stays bindable within the session that registered it (in-session
    // loop by design, no persistence).
    const sessionRegisteredVoices: RegisteredVoiceInfo[] = [];
    // set_roster names a stage, so the roster toolset gets the same
    // fail-closed owner gate as the course/DSL toolset (the reference wraps
    // the merged course toolset, of which set_roster is a member).
    const rosterTools = withOwnerStageAuthorization(
      buildRosterTools({
        store: ownerScopedStore,
        onCheckpoint: (info) => emit(LIFECYCLE.checkpoint, info),
        sessionId: id,
        registeredVoices: sessionRegisteredVoices,
      }),
      { stageAccess },
    );
    // register_voice is capability-registered: the tool exists exactly when
    // this deployment has a working voice-registration backend (a served,
    // keyed provider whose adapter reports supportsRegistration). An
    // unconfigured deployment gets clip_audio but no register_voice, so the
    // model never sees a tool that can only throw.
    const voiceCloneTools = buildVoiceCloneTools({
      sessionId: id,
      registeredVoices: sessionRegisteredVoices,
    });
    const voiceRegistrationEnabled = hasConfiguredVoiceRegistrationCapability();
    const tools = assembleRunnerTools(
      [askUserTool],
      webSearchTools,
      // ownerId is captured from the claimed durable session. It is deliberately
      // absent from the model-visible parameters, so the model cannot forge a
      // target owner.
      [buildCreateSkillTool(meta.ownerId)],
      // read_skill / patch_skill close the loop create_skill opens. Registered
      // unconditionally rather than gated on "the user already has Skills": a
      // Skill created earlier IN THIS RUN is not in `installedSkills` (loaded
      // once at start), and a tool that appears only on the next run would be a
      // capability the model cannot discover when it needs it.
      buildSkillEditTools(meta.ownerId),
      // The native `read` tool is restricted to installed skill resources; it is
      // present exactly when skills exist. Discovery and invocation stay pi-native.
      skillReadTool ? [skillReadTool] : [],
      // fetch_url is registered unconditionally (reference semantics: the
      // material tools are always registered alongside the capability-gated
      // web_search). The URL trust gate — not registration — is what keeps a
      // fetch inside the session's observed origins, and it is the tool's core
      // security property.
      [buildFetchUrlTool({ sessionId: id })],
      dslTools,
      curriculumTools,
      scenePreviewTools,
      materialTools,
      rosterTools,
      voiceCloneTools,
    );
    const askUserLatch = createAskUserTerminateLatch();
    let toolCalls = 0;
    const agent = buildAgent({
      streamFn,
      systemPrompt: buildRunnerCoursePrompt({
        availableSkills: availableSkillsPromptBlock(installedSkills),
        curriculum: CURRICULUM_TOOLS_PROMPT,
        ...(search ? { search: searchPromptBlock() } : {}),
        fetch: fetchPromptBlock(),
        untrustedContent: untrustedContentPolicyPromptBlock(),
        ...(materials.length ? { materials: sessionMaterialsPromptBlock(materials) } : {}),
        roster: ROSTER_TOOLS_PROMPT,
        voice: voiceCloneToolsPrompt(voiceRegistrationEnabled),
      }),
      model: driver.piModel,
      tools,
      allowedToolNames: new Set([
        ...MINIMAL_AGENT_TOOL_NAMES,
        ...(search ? ['web_search'] : []),
        'create_skill',
        ...SKILL_EDIT_TOOL_NAMES,
        ...(skillReadTool ? ['read'] : []),
        ...MATERIAL_TOOL_NAMES,
        ...dslTools.map((tool) => tool.name),
        ...scenePreviewTools.map((tool) => tool.name),
        ...CURRICULUM_ALLOWLIST,
        ...ROSTER_TOOL_NAMES,
        // register_voice is registered only when the deployment has a voice
        // registration backend, so the allowlist follows: clip_audio is always
        // available, register_voice only with a backend.
        ...(voiceRegistrationEnabled ? VOICE_CLONE_TOOL_NAMES : ['clip_audio']),
      ]),
      ...(plan.kind === 'start' ? {} : { history: modelMessages }),
      afterToolCall: (toolContext) => {
        toolCalls += 1;
        if (askUserLatch.shouldTerminate(toolContext.toolCall.name, toolContext.isError)) {
          return { terminate: true };
        }
        return undefined;
      },
    });

    // Every finalized pi message is inserted into the only history source on
    // the same ordered chain as its event. The INSERT is a critical write: a
    // failure aborts the loop and prevents a successful settlement.
    const inFlightToolCalls = new Map<string, PendingToolCall>();
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      emit(event.type, event);
      if (event.type === 'message_end') {
        // A tool call becomes pending as soon as its assistant frame is
        // emitted, so an abort can queue its receipt even while that frame is
        // still waiting on the ordered write chain. A result stops being
        // pending only AFTER its fenced append succeeds; clearing it at event
        // time would reopen the orphan race during write-chain drain.
        if (event.message.role === 'assistant') {
          trackToolCallMessage(inFlightToolCalls, event.message);
        }
        enqueue(async () => {
          await entrySession!.appendMessage(event.message);
          if (event.message.role === 'toolResult') {
            trackToolCallMessage(inFlightToolCalls, event.message);
          }
        }, true);
      }
    });
    let interruptedResultsQueued = false;
    const queueInterruptedToolResults = (): void => {
      if (interruptedResultsQueued || inFlightToolCalls.size === 0) return;
      interruptedResultsQueued = true;
      enqueue(async () => {
        // Resolve the set only after all preceding message appends have
        // drained. Successfully persisted results remove themselves above;
        // calls still present here are the genuinely orphaned durable set.
        const calls = [...inFlightToolCalls.values()];
        inFlightToolCalls.clear();
        await appendInterruptedToolCallResults(calls, {
          append: async (message) => {
            await entrySession!.appendMessage(message);
          },
          onFenceLost: markLeaseLost,
        });
      }, true);
    };
    const abortAgent = () => agent.abort();
    abort.signal.addEventListener('abort', abortAgent);

    // Same-run steering needs a guard because steer() accepts a message before
    // its eventual message_end has reached the durable tree.
    let steeredThisAttempt = 0;
    const deliveredFollowUps = (): number => {
      const users = agent.state.messages.filter((message) => message.role === 'user').length;
      return cursor.idle ? users : Math.max(0, users - 1);
    };
    const drainMessages = async (): Promise<number> => {
      // These reads deliberately avoid a shared transaction: a message added
      // between them is left for the next serialized drain, while the lease
      // snapshot prevents steering after ownership has already changed.
      const all = await store.listUserMessages(id);
      const current = await store.getSession(id);
      if (!leaseMatches(current, WORKER_ID, attempt)) {
        markLeaseLost();
        return 0;
      }
      const handled = Math.max(deliveredFollowUps(), steeredThisAttempt);
      let delivered = 0;
      for (const [index, message] of all.entries()) {
        if (index < handled) continue;
        agent.steer({
          role: 'user',
          content: composeFollowUpText(toFollowUp(message)),
        } as unknown as AgentMessage);
        delivered += 1;
      }
      if (delivered > 0) {
        steeredThisAttempt = handled + delivered;
        log.info(`session ${id}: steered ${delivered} follow-up message(s)`);
      }
      return delivered;
    };

    // Serialize drains so a timer firing during the settle drain cannot steer
    // the same message twice. A queued request is absorbed into the same cycle.
    let drainInFlight: Promise<number> | null = null;
    let drainQueued = false;
    const requestDrain = (): Promise<number> => {
      if (drainInFlight) {
        drainQueued = true;
        return drainInFlight;
      }
      drainInFlight = (async () => {
        let delivered = 0;
        do {
          drainQueued = false;
          delivered += await drainMessages().catch(() => 0);
        } while (drainQueued && !abort.signal.aborted);
        return delivered;
      })().finally(() => {
        drainInFlight = null;
      });
      return drainInFlight;
    };
    drainOnWake = requestDrain;
    const messagePoll = setInterval(() => void requestDrain(), SESSION_WAKEUP_FALLBACK_MS);
    messagePoll.unref?.();

    try {
      if (plannedStart.kind === 'prompt') {
        // A follow-up-driven prompt is already in the event log; here it
        // enters the transcript. The bump keeps the 500ms poll from
        // re-steering that same message before the transcript folds it
        // (only relevant when the prompt came from `pending`).
        if (plan.kind !== 'start' || pending.length > 0) {
          steeredThisAttempt = followUpsDelivered + 1;
        }
        // ── Forced skill loading ─────────────────────────────────────────────
        //
        // A skill the user chose must be LOADED, not merely hinted at, and ONE
        // path does it for every turn: the skill arrives as a `read` that
        // already happened (see skill-preload.ts for the message shape, the
        // caps, and why nothing here is a `user` message).
        //
        // `forced` is the session's own frozen `skillId`, on the FIRST run
        // only. It is not redundant with the text: a `?skill=` launch link sets
        // `skillId` from the URL, and its prompt text contains no handle at
        // all. On later runs the skill is already in the transcript, so the
        // transcript dedupe (not a special case) keeps it to one load.
        const preload = await buildSkillPreload({
          text: plannedStart.text,
          skills: installedSkills,
          transcript: modelMessages,
          ...(plan.kind === 'start' && requestedSkill ? { forced: [requestedSkill] } : {}),
          model: {
            api: driver.piModel.api,
            provider: driver.piModel.provider,
            id: driver.piModel.id,
          },
          onSkipped: (skill, reason) =>
            emit(LIFECYCLE.trace, {
              message: `skill "${skill.id}" not preloaded (${reason}); its location is named in the prompt instead`,
            }),
        });
        if (preload.messages.length === 0) {
          await agent.prompt(preload.text);
        } else {
          await agent.prompt([preloadUserMessage(preload.text), ...preload.messages]);
        }
      } else {
        // ── Resume repair ─────────────────────────────────────────────────────
        //
        // Reaching here means `plan.kind === 'continue'`: a previous run was
        // cut off mid-turn. The synthesized load is THREE separately fenced
        // appends on one ordered chain, so a failure truncates it at some
        // prefix — and every prefix short of the tool result leaves a turn
        // whose skill body never arrived. Worse than absent: an unanswered
        // read is materialized as "This tool call was interrupted", which
        // tells the model the read FAILED, so it has a reason not to retry.
        //
        // So the resume asks the turn's own question again and answers it with
        // the SAME builder. That is what makes this one mechanism rather than
        // a patch per prefix: the transcript dedupe is the idempotence judge,
        // so a load that did land makes this a no-op, and a load that did not
        // is delivered exactly as it would have been.
        //
        // The intent comes from the DURABLE record — the `user_message` row
        // this turn was delivered from, or the session's own prompt for a
        // first run — never from the compaction view: native compaction may
        // summarize the user frame away while keeping the assistant/tool
        // suffix. The compaction view answers the other question ("is the
        // body in the model's context now"), which is what the dedupe reads.
        //
        // Delivery carries NO user message — the follow-up cursor is the count
        // of `user` messages in the transcript, and moving it would mark a
        // real user message delivered and drop it.
        const resumedTurnText =
          followUpsDelivered > 0
            ? (loggedMessages[followUpsDelivered - 1]?.text ?? meta.prompt)
            : meta.prompt;
        const repair = await buildSkillPreload({
          text: resumedTurnText,
          skills: installedSkills,
          transcript: modelMessages,
          model: {
            api: driver.piModel.api,
            provider: driver.piModel.provider,
            id: driver.piModel.id,
          },
          onSkipped: (skill, reason) =>
            emit(LIFECYCLE.trace, {
              message: `skill "${skill.id}" not reloaded on resume (${reason}); its location is named in the transcript instead`,
            }),
        });
        if (repair.messages.length > 0) {
          await agent.prompt(repair.messages);
        } else {
          await agent.continue();
        }
      }

      // Capture messages that arrive while the loop winds down. Pi is already
      // idle here, so an accepted steer is durably detected and requeued by
      // the settle check for the next claim rather than extending this run.
      for (;;) {
        await agent.waitForIdle();
        if (abort.signal.aborted) break;
        const before = steeredThisAttempt;
        const delivered = await requestDrain();
        if (abort.signal.aborted) break;
        if (delivered === 0 || steeredThisAttempt === before) break;
      }

      // A tool call that was still in flight when the loop wound down has no
      // durable receipt yet. Append its interrupted result before the terminal
      // flush so the tree is provider-safe for the next claim, and so a
      // shutdown/lease-loss park leaves no orphaned call behind.
      queueInterruptedToolResults();
      await flushAll();

      const loopError = terminalLoopError(agent.state.messages, agent.state.errorMessage);
      const shutdown = ctx.shuttingDown && abort.signal.aborted && !cancelled;
      if (shutdown || tripwireViolated || (leaseLost && abort.signal.aborted)) {
        emit(LIFECYCLE.sessionInterrupted, {
          reason: shutdown
            ? 'runner shutdown'
            : tripwireViolated
              ? 'runner event-order tripwire'
              : 'lease lost',
          attempt,
        });
        await flushAll();
        if (!leaseLost) await store.releaseLease(id, WORKER_ID);
        log.info(`session ${id} parked at attempt ${attempt}`);
        return;
      }

      const settledCancelled = cancelled || (await store.isCancelRequested(id));
      if (settledCancelled) abort.abort();
      const error = !settledCancelled && loopError ? loopError : undefined;
      const status = settledCancelled ? 'cancelled' : error ? 'failed' : 'succeeded';
      emit(LIFECYCLE.sessionEnd, { status, toolCalls, ...(error ? { error } : {}) });
      await flushAll();
      await store.finishSession(id, WORKER_ID, {
        status,
        ...(error ? { error } : {}),
        resetAttempt: status !== 'failed',
      });
      // Clear only the cancel request included in the terminal verdict. A poll
      // that observes a later request must not erase it with a stale verdict.
      if (settledCancelled) {
        await store.clearCancel(id);
      } else {
        await requeueIfUndelivered('settle');
      }
      log.info(`session ${id} -> ${status} (attempt ${attempt}, ${toolCalls} tool calls)`);
    } catch (error) {
      queueInterruptedToolResults();
      if (isLeaseLostError(error)) markLeaseLost();
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.shuttingDown || leaseLost || tripwireViolated) {
        emit(LIFECYCLE.sessionInterrupted, {
          reason: tripwireViolated
            ? 'runner event-order tripwire'
            : leaseLost
              ? 'lease lost'
              : 'runner shutdown',
          attempt,
        });
        await flushAll(false);
        if (!leaseLost) await store.releaseLease(id, WORKER_ID);
      } else {
        if (!terminalFrameEmitted) {
          emit(LIFECYCLE.sessionEnd, { status: 'failed', error: message });
        }
        await flushAll(false);
        await store.finishSession(id, WORKER_ID, { status: 'failed', error: message });
        await requeueIfUndelivered('run failure');
        log.error(`session ${id} failed`, error);
      }
    } finally {
      abort.signal.removeEventListener('abort', abortAgent);
      unsubscribe();
      clearInterval(messagePoll);
    }
  } catch (error) {
    if (isLeaseLostError(error)) markLeaseLost();
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.shuttingDown || leaseLost || tripwireViolated) {
      if (tripwireViolated) {
        emit(LIFECYCLE.sessionInterrupted, {
          reason: 'runner event-order tripwire',
          attempt,
        });
        await flushAll(false).catch(() => {});
      }
      if (!leaseLost) await store.releaseLease(id, WORKER_ID).catch(() => {});
    } else {
      if (!terminalFrameEmitted) {
        emit(LIFECYCLE.sessionEnd, { status: 'failed', error: message });
      }
      await flushAll(false).catch(() => {});
      await store
        .finishSession(id, WORKER_ID, { status: 'failed', error: message })
        .catch(() => {});
      await requeueIfUndelivered('setup failure');
    }
    log.error(`session ${id} failed during setup`, error);
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(cancelPoll);
    unsubscribeWakeup();
    drainOnWake = null;
    await flushAll(false);
    ctx.running.delete(id);
  }
}

/** Start scanning. Store/schema construction remains lazy behind each scan. */
export function startAgentRunner(): AgentRunnerHandle {
  const ctx: RunContext = { running: new Map(), shuttingDown: false };
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;

  const scan = async (): Promise<void> => {
    if (scanning || ctx.shuttingDown) return;
    scanning = true;
    try {
      const store = await getAgentSessionStore();
      while (ctx.running.size < config.maxConcurrent && !ctx.shuttingDown) {
        const meta = await store.claimNextSession(WORKER_ID, process.pid, {
          leaseTtlMs: config.leaseTtlMs,
          maxAttempts: config.maxAttempts,
        });
        if (!meta) break;
        // Process-local fence in addition to the store's lease exclusion.
        if (ctx.running.has(meta.id)) continue;
        log.info(`claiming ${meta.id} (attempt ${meta.attempt})`);
        void runSession(ctx, meta).catch((error) => {
          log.error(`runSession ${meta.id} crashed`, error);
          ctx.running.delete(meta.id);
        });
      }
    } catch (error) {
      log.error('claim scan failed', error);
    } finally {
      scanning = false;
    }
  };

  scanTimer = setInterval(() => void scan(), config.scanIntervalMs);
  scanTimer.unref?.();
  void scan();
  log.info(
    `runner ${WORKER_ID} started (scan=${config.scanIntervalMs}ms, ` +
      `heartbeat=${config.heartbeatIntervalMs}ms, leaseTtl=${config.leaseTtlMs}ms, ` +
      `maxConcurrent=${config.maxConcurrent}, maxAttempts=${config.maxAttempts})`,
  );
  log.info(
    'agent runner toolset: ask_user always; web_search when a web-search backend is configured; ' +
      'create_skill/read_skill/patch_skill and the skill-scoped read when skills are installed; ' +
      'fetch_url always (URL trust gate enforced per call); ' +
      'read_stage/patch_stage/grep_stage and create_stage/read_stage_outline always (owner-scoped store)',
  );

  return {
    workerId: WORKER_ID,
    async stop(options?: { timeoutMs?: number }): Promise<void> {
      ctx.shuttingDown = true;
      if (scanTimer) clearInterval(scanTimer);
      const deadlineAt = Date.now() + (options?.timeoutMs ?? 15_000);
      for (const session of ctx.running.values()) session.abort.abort();
      while (ctx.running.size > 0 && Date.now() < deadlineAt) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (ctx.running.size > 0) {
        log.warn(`stop() timed out with ${ctx.running.size} session(s) still settling`);
      }
      log.info(`runner ${WORKER_ID} stopped`);
    },
  };
}
