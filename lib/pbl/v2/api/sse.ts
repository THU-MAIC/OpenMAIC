/**
 * PBL v2 — Server-Sent Events (SSE) utilities for streaming chat.
 *
 * Three concerns are unified here:
 *   1. The wire-format envelope (`event: <type>\ndata: <json>\n\n`)
 *   2. The discriminated event union so the client side has matching
 *      types for parsing (`PBLSSEEvent`)
 *   3. A small `createSSEResponse` helper that wraps any async event
 *      generator into a Next.js `Response` with the right headers
 *      and a keepalive heartbeat so intermediaries (Vercel, Cloudflare,
 *      nginx) don't kill the connection during long LLM calls.
 */

import type {
  PBLProjectV2,
  PBLChatMessage,
  PBLEvaluation,
  PBLProficiencyAssessment,
  PBLMicrotask,
  PBLMilestone,
  PBLEngagementEvent,
  PBLRuntimeEvent,
} from '../types';

// ---------------------------------------------------------------------------
// Event types — discriminated union, shared between client and server
// ---------------------------------------------------------------------------

/** Streaming text delta from the LLM. */
export interface SSETokenEvent {
  type: 'token';
  /** The text chunk to append to the current assistant message. */
  delta: string;
}

/** The LLM called a tool. Surfaced so the client can record / display. */
export interface SSEToolCallEvent {
  type: 'tool_call';
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
}

/** Result of a server-side tool execution. Carries the patch the
 *  client should apply to `scene.content.projectV2` (no full project
 *  re-sync — clients keep their own copy in IndexedDB / PG). */
export interface SSEProjectPatchEvent {
  type: 'project_patch';
  /** The shape mirrors the tool effect:
   *   - 'advance' → microtask id + flags
   *   - 'closing_check' / 'observation' → engagement event added
   *   - 'evaluation' → new PBLEvaluation appended (for milestone/final later)
   *   - 'message' → assistant message that should be appended verbatim
   */
  patch:
    | {
        kind: 'message';
        message: PBLChatMessage;
      }
    | {
        kind: 'advance';
        microtaskId: string;
        milestoneCompleted: boolean;
        projectCompleted: boolean;
        nextMicrotaskId?: string;
        /** Authoritative server snapshots after advanceMicrotask()
         *  mutates process data. The client project is the source sent
         *  to /evaluate, so these fields must cross the SSE boundary
         *  or milestone/final evaluators lose completion evidence. */
        completedMicrotask?: PBLMicrotask;
        nextMicrotask?: PBLMicrotask;
        milestone?: PBLMilestone;
        engagementEvents?: PBLEngagementEvent[];
        runtimeEvents?: PBLRuntimeEvent[];
        /**
         * Should the client follow up with /api/pbl/v2/evaluate after
         * the Instructor stream closes? Three orthogonal flags so the
         * client can chain them deterministically:
         *
         *  - shouldEvaluateTask:      run task eval (only when the
         *                             microtask has at least one
         *                             submission — PR 6 D1-B)
         *  - shouldEvaluateMilestone: run milestone eval (when this
         *                             advance completed the milestone)
         *  - shouldEvaluateFinal:     run final eval (when this advance
         *                             completed the whole project)
         *
         * Chaining order is task → milestone → final; each eval's
         * `done` triggers the next one. The server doesn't know the
         * client's stream state, so we communicate "what to do next"
         * declaratively here, not by running the evaluator inline
         * with the Instructor (that would interleave two LLM streams,
         * see the design notes in agents/evaluator.ts).
         */
        shouldEvaluateTask?: boolean;
        shouldEvaluateMilestone?: boolean;
        shouldEvaluateFinal?: boolean;
      }
    | {
        kind: 'engagement_event';
        /** Authoritative server event. Older patches may only carry
         *  eventKind/payload; clients keep backward compatibility. */
        event?: PBLEngagementEvent;
        eventKind: string;
        microtaskId?: string;
        milestoneId?: string;
        ts?: string;
        payload?: Record<string, unknown>;
      }
    | {
        kind: 'evaluation';
        evaluation: PBLEvaluation;
      }
    | {
        kind: 'handover';
        handover: NonNullable<PBLProjectV2['pendingHandover']>;
      }
    /**
     * Adaptive proficiency engine state update. Replaces the project's
     * `proficiencyAssessment` wholesale on the client. By product
     * decision the chat does NOT show this — the patch is only
     * consumed by the dev badge (`PBL_V2_DEV_PROFICIENCY_BADGE=true`)
     * and the engagement-event ledger. `tierChanged` is included so
     * the dev tooling can highlight transitions without diffing the
     * full assessment.
     */
    | {
        kind: 'proficiency';
        assessment: PBLProficiencyAssessment;
        tierChanged: boolean;
      };
}

/** SCENARIO ONLY. Marks which sub-phase of a Simulator turn is currently
 *  generating, so the client shows the right loading indicator:
 *    - 'narration' → the SYSTEM narrator is composing scene narration
 *                    (neutral "旁白生成中" indicator, no character avatar);
 *    - 'character' → the in-scene character is about to speak / streaming
 *                    (character avatar + thinking).
 *  Ordinary (non-scenario) streams never emit this. */
export interface SSESimPhaseEvent {
  type: 'sim_phase';
  phase: 'narration' | 'character';
}

/** Tell the client to discard the in-progress assistant draft (live tokens).
 *  Emitted on an advancing turn the moment `advance_micro_task` succeeds: the
 *  streamed free prose is being discarded in favour of the separately-generated
 *  isolated wrap-up, so any premature next-task mention that leaked into the
 *  live draft must be dropped immediately rather than lingering until the
 *  wrap-up message patch arrives. Does not touch committed messages. */
export interface SSEResetDraftEvent {
  type: 'reset_draft';
}

/** Structured error. */
export interface SSEErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/** Terminal — always exactly one per stream. */
export interface SSEDoneEvent {
  type: 'done';
}

export type PBLSSEEvent =
  | SSETokenEvent
  | SSEToolCallEvent
  | SSEProjectPatchEvent
  | SSESimPhaseEvent
  | SSEResetDraftEvent
  | SSEErrorEvent
  | SSEDoneEvent;

export type PBLProjectPatch = SSEProjectPatchEvent['patch'];
export type PBLAdvanceProjectPatch = Extract<PBLProjectPatch, { kind: 'advance' }>;

// ---------------------------------------------------------------------------
// Wire-format encoding
// ---------------------------------------------------------------------------

/** Encode one event as an SSE wire frame. */
function encodeEvent(event: PBLSSEEvent): string {
  const { type, ...payload } = event;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** SSE keepalive comment line; Vercel / nginx drop idle connections
 *  around 30-60s otherwise. Emitted on a timer. */
const HEARTBEAT = `: keepalive\n\n`;

// ---------------------------------------------------------------------------
// Response wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an async generator of `PBLSSEEvent` into a Response with the
 * correct SSE headers and an interval heartbeat.
 *
 * Generator semantics:
 *   - Each yielded event is encoded and pushed to the stream.
 *   - Yielding an `error` event does NOT stop the generator; it's the
 *     caller's responsibility to `return` after an error.
 *   - The generator MUST yield a final `done` event so the client
 *     knows the stream finished cleanly.
 *   - If the generator throws, an `error` + `done` event are emitted
 *     before the stream closes.
 */
export function createSSEResponse(
  generator: AsyncGenerator<PBLSSEEvent, void, void>,
  options: { heartbeatMs?: number; signal?: AbortSignal } = {},
): Response {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const signal = options.signal;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // eslint-disable-next-line prefer-const -- declared early for safeClose closure; single deferred assignment
      let heartbeatHandle: ReturnType<typeof setInterval> | undefined;

      const safeClose = () => {
        if (closed) return;
        closed = true;
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const onAbort = () => {
        safeClose();
      };
      if (signal) {
        if (signal.aborted) {
          safeClose();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* downstream closed */
          safeClose();
        }
      };

      heartbeatHandle = setInterval(() => enqueueText(HEARTBEAT), heartbeatMs);

      try {
        for await (const event of generator) {
          if (closed) break;
          enqueueText(encodeEvent(event));
        }
      } catch (err) {
        enqueueText(
          encodeEvent({
            type: 'error',
            code: 'STREAM_ERROR',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        enqueueText(encodeEvent({ type: 'done' }));
      } finally {
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Nginx response buffering for SSE through proxies.
      'X-Accel-Buffering': 'no',
    },
  });
}
