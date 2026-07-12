'use client';

/**
 * PBL v2 — Instructor + evaluator stream chaining hook.
 *
 * Encapsulates the fetch + SSE parsing + project_patch application
 * loop AND the PR 6.6 evaluator chain. Lives in one hook because
 * the chain is naturally driven by the Instructor stream's advance
 * patch — splitting them across two hooks would force the chat
 * component to thread state between them.
 *
 * Streaming contract:
 *   - One in-flight stream at a time (further sends are ignored when
 *     `streaming` is true; the UI disables Send while streaming).
 *   - Live tokens accumulate into `draftAssistant` for inline render.
 *   - `project_patch` events are applied to a working clone of the
 *     project; the final clone is published via `onProjectChange`
 *     once the whole chain closes.
 *   - On error the latest project clone is still pushed (any patches
 *     applied before the failure are kept), and `error` is surfaced.
 *
 * Evaluator chain (PR 6.6):
 *   When the Instructor stream yields an `advance` patch with any of
 *   `shouldEvaluateTask` / `shouldEvaluateMilestone` /
 *   `shouldEvaluateFinal` set, we collect those flags but do NOT
 *   open the evaluator stream yet — we let the Instructor finish
 *   first (force-advance may emit more patches). Once the Instructor
 *   stream closes, we open evaluator streams in this order:
 *
 *      task → milestone → final
 *
 *   Each is a fresh SSE round-trip to /api/pbl/v2/evaluate; they
 *   never interleave. Token tail of each stream goes into the same
 *   `draftAssistant` setter so the UI just sees a continuous wait;
 *   the `status` field tells the UI what kind of wait it is so the
 *   label can flip (see chat.tsx).
 *
 *   After a *task* eval finishes, we feed its score into the
 *   adaptive proficiency engine via `trackSubmissionScore`
 *   (PR 6 D4-A). Milestone / final do NOT feed the engine — their
 *   stars are vibes, not measurements.
 */

import { useCallback, useRef, useState } from 'react';

import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';
import { trackSubmissionScore } from '@/lib/pbl/v2/operations/dynamic-signals';
import { normalizeProjectRuntime } from '@/lib/pbl/v2/operations/progress';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { createLogger } from '@/lib/logger';
import { applyInstructorEvent } from './apply-instructor-event';

const log = createLogger('PBL v2 InstructorStream');

interface RunOptions {
  endpoint: '/api/pbl/v2/instructor' | '/api/pbl/v2/open-task' | '/api/pbl/v2/simulator';
  body: Record<string, unknown>;
  /** Override the starting project clone. Use when the caller has
   *  applied an optimistic local mutation (e.g. user message) right
   *  before invoking `run` — passing the already-mutated project here
   *  avoids a stale-ref race between React render and the SSE fetch. */
  initialProject?: PBLProjectV2;
}

export type StreamStatus = 'idle' | 'instructor' | 'eval-task' | 'eval-milestone' | 'eval-final';

export interface StreamDisplayState {
  readonly status: StreamStatus;
  readonly draftAssistant: string;
  readonly streamCommittedOutput: boolean;
}

/** SCENARIO ONLY. Which sub-phase of a Simulator turn is generating, so
 *  the chat shows the right loading indicator. null for ordinary streams. */
export type SimPhase = 'narration' | 'character' | null;

interface UseInstructorStream {
  streaming: boolean;
  status: StreamStatus;
  draftAssistant: string;
  streamCommittedOutput: boolean;
  error: string | null;
  simPhase: SimPhase;
  run: (options: RunOptions) => Promise<{ ok: boolean; project: PBLProjectV2 }>;
  clearError: () => void;
}

interface EvalChainTriggers {
  task: boolean;
  milestone: boolean;
  final: boolean;
  microtaskId?: string;
}

/**
 * @param onStreamingChange Optional reporter for "a stream is in flight",
 *   called with `true` when a run starts and `false` when it settles. Unlike
 *   the local `streaming` state, this fires even after the owning component
 *   unmounts (the in-flight `run` promise keeps executing), so a parent that
 *   outlives the chat (e.g. the Hero ↔ workspace container) can keep showing
 *   the "thinking…" indicator across a remount. The closure target must be a
 *   stable setter owned by a component that does NOT unmount with the chat.
 */
export function useInstructorStream(
  project: PBLProjectV2,
  onProjectChange: (next: PBLProjectV2) => void,
  onStreamingChange?: (active: boolean) => void,
): UseInstructorStream {
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [draftAssistant, setDraftAssistant] = useState('');
  const [streamCommittedOutput, setStreamCommittedOutput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simPhase, setSimPhase] = useState<SimPhase>(null);
  const projectRef = useRef<PBLProjectV2>(project);
  projectRef.current = project;
  // Synchronous re-entrancy lock. `streaming` is React state and only updates
  // on the NEXT render, so two callers in the SAME effect-flush (e.g. the
  // empty-thread auto-greeting and the scenario stage-opener firing together
  // when a fresh roleplay act has an empty Simulator thread) would both pass
  // the `streaming` check and double-fire the opener. A ref flips immediately,
  // so the second synchronous call is rejected.
  const runningRef = useRef(false);

  const run = useCallback(
    async ({ endpoint, body, initialProject }: RunOptions) => {
      if (runningRef.current || streaming) return { ok: false, project: projectRef.current };
      runningRef.current = true;
      setError(null);
      setDraftAssistant('');
      setStreamCommittedOutput(false);
      setStreaming(true);
      setStatus('instructor');
      setSimPhase(null);
      onStreamingChange?.(true);

      let workingProject: PBLProjectV2 = structuredClone(initialProject ?? projectRef.current);
      let ok = true;
      if (normalizeProjectRuntime(workingProject)) {
        onProjectChange(workingProject);
      }
      // Evaluator triggers collected mid-stream, acted on after.
      const chain: EvalChainTriggers = { task: false, milestone: false, final: false };
      let lastPhase: StreamStatus = 'instructor';

      try {
        workingProject = await runOneStream({
          endpoint,
          body: { project: workingProject, ...body },
          startingProject: workingProject,
          setDraftAssistant,
          onProjectUpdated: onProjectChange,
          onSimPhase: setSimPhase,
          onPatch: (patch) => {
            if (patch.kind === 'message' || patch.kind === 'evaluation') {
              setStreamCommittedOutput(true);
            }
            if (patch.kind !== 'advance') return;
            if (patch.shouldEvaluateTask) {
              chain.task = true;
              chain.microtaskId = patch.microtaskId;
            }
            if (patch.shouldEvaluateMilestone) {
              chain.milestone = true;
              if (!chain.microtaskId) chain.microtaskId = patch.microtaskId;
            }
            if (patch.shouldEvaluateFinal) {
              chain.final = true;
              if (!chain.microtaskId) chain.microtaskId = patch.microtaskId;
            }
          },
        });

        // ---- Evaluator chain: task → milestone → final ----
        if (chain.task && chain.microtaskId) {
          const milestoneId = findMilestoneIdForMicrotask(workingProject, chain.microtaskId);
          if (milestoneId) {
            lastPhase = 'eval-task';
            setStatus('eval-task');
            setDraftAssistant('');
            setStreamCommittedOutput(false);
            workingProject = await runOneStream({
              endpoint: '/api/pbl/v2/evaluate',
              body: {
                project: workingProject,
                kind: 'task',
                milestoneId,
                microtaskId: chain.microtaskId,
              },
              startingProject: workingProject,
              setDraftAssistant,
              onProjectUpdated: onProjectChange,
              onPatch: (patch) => {
                if (patch.kind === 'evaluation') setStreamCommittedOutput(true);
              },
            });
            // PR 6 D4-A: fold task score into adaptive engine.
            const newest = workingProject.evaluations[workingProject.evaluations.length - 1];
            if (newest && newest.kind === 'task' && typeof newest.score === 'number') {
              trackSubmissionScore(workingProject, newest.score);
            }
          }
        }

        if (chain.milestone) {
          const milestoneId = chain.microtaskId
            ? findMilestoneIdForMicrotask(workingProject, chain.microtaskId)
            : undefined;
          if (milestoneId) {
            lastPhase = 'eval-milestone';
            setStatus('eval-milestone');
            setDraftAssistant('');
            setStreamCommittedOutput(false);
            workingProject = await runOneStream({
              endpoint: '/api/pbl/v2/evaluate',
              body: { project: workingProject, kind: 'milestone', milestoneId },
              startingProject: workingProject,
              setDraftAssistant,
              onProjectUpdated: onProjectChange,
              onPatch: (patch) => {
                if (patch.kind === 'evaluation') setStreamCommittedOutput(true);
              },
            });
          }
        }

        if (chain.final) {
          lastPhase = 'eval-final';
          setStatus('eval-final');
          setDraftAssistant('');
          setStreamCommittedOutput(false);
          workingProject = await runOneStream({
            endpoint: '/api/pbl/v2/evaluate',
            body: { project: workingProject, kind: 'final' },
            startingProject: workingProject,
            setDraftAssistant,
            onProjectUpdated: onProjectChange,
            onPatch: (patch) => {
              if (patch.kind === 'evaluation') setStreamCommittedOutput(true);
            },
          });
        }
      } catch (e) {
        ok = false;
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`Stream chain failed at phase=${lastPhase}: ${msg}`);
        setError(msg);
      } finally {
        runningRef.current = false;
        setStreaming(false);
        setStatus('idle');
        setDraftAssistant('');
        setSimPhase(null);
        onStreamingChange?.(false);
        onProjectChange(workingProject);
      }

      return { ok, project: workingProject };
    },
    [streaming, onProjectChange, onStreamingChange],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    streaming,
    status,
    draftAssistant,
    streamCommittedOutput,
    error,
    simPhase,
    run,
    clearError,
  };
}

export interface OneStreamArgs {
  endpoint: string;
  body: Record<string, unknown>;
  startingProject: PBLProjectV2;
  setDraftAssistant: (fn: (prev: string) => string) => void;
  onPatch?: (patch: Extract<PBLSSEEvent, { type: 'project_patch' }>['patch']) => void;
  onProjectUpdated?: (next: PBLProjectV2) => void;
  onSimPhase?: (phase: SimPhase) => void;
}

export async function runOneStream(args: OneStreamArgs): Promise<PBLProjectV2> {
  const { endpoint, body, startingProject, setDraftAssistant, onPatch } = args;
  let workingProject = startingProject;

  const modelConfig = getCurrentModelConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-model': modelConfig.modelString,
    'x-api-key': modelConfig.apiKey,
  };
  if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
  if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;
  // PBL Planner already reads `x-user-locale` from this header for
  // generation-time language lock; the evaluator route does NOT
  // need it (the project already carries `language`) but forwarding
  // it unconditionally is cheap and future-proof for routes that
  // may grow to depend on the UI locale.
  try {
    const stored = localStorage.getItem('locale');
    if (stored) headers['x-user-locale'] = stored;
  } catch {
    // localStorage unavailable; skip silently.
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error('Response has no readable body.');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const parsed = parseSSEFrame(frame);
        if (!parsed) continue;
        assertNotStreamError(parsed);
        if (parsed.type === 'sim_phase') {
          args.onSimPhase?.(parsed.phase);
          continue;
        }
        if (parsed.type === 'project_patch' && onPatch) onPatch(parsed.patch);
        workingProject = applyInstructorEvent(parsed, workingProject, setDraftAssistant);
        if (parsed.type === 'project_patch') {
          args.onProjectUpdated?.(workingProject);
        }
      }
    }
    return workingProject;
  } finally {
    reader.cancel().catch(() => {
      // Reader already closed; ignore.
    });
  }
}

export function assertNotStreamError(event: PBLSSEEvent): void {
  if (event.type === 'error') {
    throw new Error(`${event.code}: ${event.message}`);
  }
}

/**
 * Whether a stream `error` frame should be tolerated (degraded) rather than
 * abort the flow.
 *
 * #593: `EMPTY_LLM_OUTPUT` is a soft "the instructor produced no new content
 * this turn — retry" hint, meaningful for a live chat turn. The post-submission
 * flow chains a best-effort instructor REACTION turn (`streamStatus`
 * 'instructor') after a task evaluation that already succeeded and is recorded.
 * If that reaction goes empty, the correct outcome is "no wrap-up bubble", NOT
 * "评测失败" — the evaluation stands. So only that specific soft signal on the
 * reaction stream is tolerated; real failures (LLM_ERROR / STREAM_ERROR) and ANY
 * error on the evaluation streams (eval-task / eval-milestone / eval-final)
 * remain fatal. Pure so it can be unit-tested.
 */
export function isToleratedReactionStreamError(
  streamStatus: StreamStatus,
  event: PBLSSEEvent,
): boolean {
  return (
    event.type === 'error' && streamStatus === 'instructor' && event.code === 'EMPTY_LLM_OUTPUT'
  );
}

export function findMilestoneIdForMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
): string | undefined {
  for (const ms of project.milestones) {
    if (ms.microtasks.some((t) => t.id === microtaskId)) return ms.id;
  }
  return undefined;
}

function parseSSEFrame(frame: string): PBLSSEEvent | null {
  const lines = frame.split('\n');
  let eventName = '';
  let dataLine = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLine = line.slice(6);
  }
  if (!eventName || !dataLine) return null;
  try {
    return { type: eventName, ...JSON.parse(dataLine) } as PBLSSEEvent;
  } catch {
    return null;
  }
}
