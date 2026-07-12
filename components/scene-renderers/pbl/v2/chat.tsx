'use client';

/**
 * PBL v2 — Workspace chat panel.
 *
 * Renders the Instructor's thread, the live streaming draft, the
 * input box, and the error banner. Multi-line input by default
 * (Enter sends, Shift+Enter inserts newline) so learners can paste
 * code snippets.
 *
 * The Instructor is the only agent wired today. The component accepts
 * an optional `agentName` so AgentTabs can label agents distinctly if
 * additional roles are introduced later.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Drama,
  Lightbulb,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { SpeechButton } from '@/components/audio/speech-button';

import type {
  PBLChatMessage,
  PBLEvaluation,
  PBLProjectV2,
  PBLScenarioCharacter,
} from '@/lib/pbl/v2/types';
import { normalizeProjectRuntime, PBL_SIMULATOR_AGENT_ID } from '@/lib/pbl/v2/operations/progress';
import {
  appendRuntimeEvent,
  milestoneIdForMicrotask,
  mintRuntimeEventId,
  transitionProjectUiPhase,
} from '@/lib/pbl/v2/operations/runtime-events';
import { stripEvaluationTail } from '@/lib/pbl/v2/operations/eval-tail-parser';
import { isTaskCompletionReadyMessageContent } from '@/lib/pbl/v2/operations/task-completion';
import { cn } from '@/lib/utils/cn';
import { useInstructorStream, type StreamDisplayState } from './use-instructor-stream';
import { instructorIntroText } from './instructor-intro';
import { useI18n } from '@/lib/hooks/use-i18n';
import { MarkdownText } from './markdown-text';
import { TaskEvaluationCard } from './eval-cards/task-evaluation-card';
import { MilestoneCard } from './eval-cards/milestone-card';
import { CompletionCtaCard } from './eval-cards/completion-cta-card';
import type { SubmissionEvaluationStatus } from './submission';
import {
  MILESTONE_DIVIDER_PREFIX,
  TASK_DIVIDER_PREFIX,
  stripEmbeddedDividerMarkers,
} from './protocol-markers';

interface Props {
  readonly project: PBLProjectV2;
  readonly onProjectChange: (next: PBLProjectV2) => void;
  readonly agentName?: string;
  readonly submissionEvaluationStatus?: SubmissionEvaluationStatus | null;
  /** True when an Instructor / evaluator stream is in flight — including one
   *  started before this chat instance mounted (the learner left to the Hero
   *  and came back mid-stream). Lets the remounted chat show the "thinking…"
   *  indicator even though its own `streaming` state starts fresh. */
  readonly instructorStreaming: boolean;
  /** Reports stream start/end up to a parent that outlives this chat, so the
   *  flag above survives a Hero ↔ workspace remount. */
  readonly onInstructorStreamingChange: (active: boolean) => void;
  /** Live tokens from a stream owned by the workspace shell, such as the
   *  sidebar "Complete" flow that chains milestone evaluation and next-task
   *  opener outside this chat hook. */
  readonly externalStream?: StreamDisplayState | null;
}

function newClientMessageId(): string {
  return 'msg_local_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
}

/** Append a user message to the Instructor thread in a fresh clone. */
function appendUserMessage(
  project: PBLProjectV2,
  instructorAgentId: string | undefined,
  text: string,
  microtaskId: string | undefined,
): PBLProjectV2 {
  const next = structuredClone(project);
  normalizeProjectRuntime(next);
  const thread = next.threads.find((t) => t.agentId === instructorAgentId);
  if (!thread) return next;
  const message: PBLChatMessage = {
    id: newClientMessageId(),
    roleType: 'user',
    content: text,
    ts: new Date().toISOString(),
    microtaskId,
  };
  thread.messages.push(message);
  appendRuntimeEvent(next, {
    id: mintRuntimeEventId(),
    kind: 'message_created',
    actorType: 'user',
    messageId: message.id,
    threadId: thread.agentId,
    ts: message.ts,
    microtaskId: message.microtaskId,
    milestoneId: milestoneIdForMicrotask(next, message.microtaskId),
  });
  next.updatedAt = new Date().toISOString();
  return next;
}

function currentMicrotaskId(project: PBLProjectV2): string | undefined {
  const ms = project.milestones.find((m) => m.status === 'active');
  return ms?.microtasks.find((t) => t.status === 'todo' || t.status === 'in_progress')?.id;
}

const MIN_ROWS = 1;
const MAX_INPUT_HEIGHT_PX = 200;
const TASK_READY_TYPEWRITER_DONE_DELAY_MS = 700;

export function PBLV2Chat({
  project,
  onProjectChange,
  agentName,
  submissionEvaluationStatus,
  instructorStreaming,
  onInstructorStreamingChange,
  externalStream,
}: Props) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const autoGreetingRef = useRef<string | null>(null);
  const scenarioStageOpenerRef = useRef<string | null>(null);
  const seenMessageAgentIdRef = useRef<string | undefined>(undefined);
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  const animatingTaskReadyMessageIdsRef = useRef<Set<string>>(new Set());
  const [taskReadyTypewriterIds, setTaskReadyTypewriterIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Cursor position for the handover hint tooltip (only tracked while a
  // stage handover is pending; null when not hovering / not pending).
  const [handoverHintPos, setHandoverHintPos] = useState<{ x: number; y: number } | null>(null);
  const {
    streaming,
    status,
    draftAssistant,
    streamCommittedOutput,
    error,
    simPhase,
    run,
    clearError,
  } = useInstructorStream(project, onProjectChange, onInstructorStreamingChange);
  const { t } = useI18n();
  // `streaming` is this instance's own run; `instructorStreaming` also covers a
  // run that started before this chat (re)mounted (learner went to the Hero and
  // came back mid-stream). Treat either as "busy" so the indicator shows and the
  // learner can't fire a second, overlapping turn.
  const streamActive = streaming || instructorStreaming;
  const visibleExternalStream =
    !streaming && externalStream && externalStream.status !== 'idle' ? externalStream : null;
  const visibleDraftAssistant = streaming
    ? draftAssistant
    : (visibleExternalStream?.draftAssistant ?? '');
  const visibleStreamStatus = streaming ? status : (visibleExternalStream?.status ?? 'instructor');
  const visibleStreamCommittedOutput = streaming
    ? streamCommittedOutput
    : (visibleExternalStream?.streamCommittedOutput ?? streamCommittedOutput);
  const showStreamingDraft = shouldShowStreamingDraft({
    streaming,
    instructorStreaming,
    draftAssistant: visibleDraftAssistant,
    streamCommittedOutput: visibleStreamCommittedOutput,
    hasExternalDraft: !!visibleExternalStream,
    submissionEvaluationActive: !!submissionEvaluationStatus,
  });
  const chatBusy = streamActive || !!submissionEvaluationStatus;
  const projectCompleted = project.status === 'completed';
  // A milestone finished and the learner must click "Continue to Next
  // Stage" before the next milestone's first microtask activates. While
  // this is pending there is NO active microtask, so the instructor
  // endpoint would return NO_ACTIVE_MICROTASK — gate the input here and
  // point the learner at the Continue button instead.
  const handoverPending = !!project.pendingHandover && !project.pendingHandover.consumed;

  /**
   * Handler for the MilestoneCard's "继续到下一阶段" button.
   *
   * 1. Server-side: POST /api/pbl/v2/task/update with action
   *    continue_handover. The server calls continueAfterHandover()
   *    which flips the next milestone from LOCKED → ACTIVE, marks
   *    the first microtask in_progress, and stamps the handover as
   *    `consumed`.
   * 2. Client-side: take the returned project and immediately fire
   *    a SETUP-phase opener via /api/pbl/v2/open-task — that's the
   *    "Instructor speaks first when a new task activates" UX, same
   *    as the GREETING path in the Hero.
   *
   * The two requests are sequential, not parallel: we MUST persist
   * the continue_handover mutation before SETUP-opening, otherwise
   * the SETUP turn would still see the old `pendingHandover` and
   * the next microtask wouldn't be in_progress yet.
   *
   * Disabled while `streaming` so the learner can't double-click
   * across an in-flight Instructor turn.
   */
  const handleContinueHandover = async () => {
    if (chatBusy) return;
    try {
      const res = await fetch('/api/pbl/v2/task/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, action: 'continue_handover' }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        ok?: boolean;
        data?: { project: PBLProjectV2 };
        project?: PBLProjectV2;
      };
      // apiSuccess wraps payload under .data; tolerate both shapes
      // so a future server refactor doesn't break the client.
      const nextProject: PBLProjectV2 | undefined = data.data?.project ?? data.project;
      if (!nextProject) {
        throw new Error('continue_handover response missing project');
      }
      onProjectChange(nextProject);
      // Open the freshly-activated milestone.
      //  - SCENARIO projects: the stage opener (Simulator scene / Instructor
      //    wrapup) is fired path-independently by the scenario stage-opener
      //    effect above — NOT here — so that the sidebar "continue" control
      //    (which is the actual control for scenario stage transitions, since
      //    roleplay stages produce no milestone card) opens the next stage too.
      //  - Ordinary projects: open the next milestone with an Instructor SETUP
      //    turn exactly as before.
      if (!nextProject.scenario) {
        void run({
          endpoint: '/api/pbl/v2/open-task',
          body: { phase: 'setup' },
          initialProject: nextProject,
        });
      }
    } catch (e) {
      // The MilestoneCard doesn't render errors itself — surface
      // through the chat's existing error banner so the learner
      // has one consistent place to look.
      const msg = e instanceof Error ? e.message : String(e);
      // Surface via the existing setError flow inside the hook —
      // but the hook's setError is private. Cheapest path: log +
      // visible alert. Alert is jarring but rare (network error
      // mid-Continue); better than a silent failure.
      console.error('[PBL v2] continue_handover failed:', msg);
      window.alert(t('pbl.v2.chat.continueError', { error: msg }));
    }
  };

  const instructorRole = useMemo(
    () => project.roles.find((r) => r.type === 'instructor'),
    [project.roles],
  );

  // SCENARIO ONLY. During a roleplay stage the chat is driven by the
  // Simulator (the in-character cast), not the Instructor: it reads the
  // Simulator thread and posts to /simulator. prep / wrapup / every
  // ordinary project keep the Instructor thread + /instructor exactly as
  // before (the flag below is always false without `project.scenario`).
  const activeMilestone = useMemo(
    () => project.milestones.find((m) => m.status === 'active'),
    [project.milestones],
  );
  // SCENARIO ONLY. During a stage handover the just-completed milestone is no
  // longer `active` and the next one is still `locked`, so there is momentarily
  // NO active milestone. Without anchoring, the view would fall back to the
  // Instructor (prep) thread mid-scene — jarring inside a roleplay run. Anchor
  // the displayed stage to the just-completed milestone during that gap, so a
  // roleplay→roleplay advance stays inside the scene (simulator thread + cast
  // banner). Ordinary projects never have a scenario, so this is a no-op there.
  const completedHandoverMilestone = useMemo(() => {
    const h = project.pendingHandover;
    if (!project.scenario || !h || h.consumed) return undefined;
    return project.milestones.find((m) => m.id === h.completedMilestoneId);
  }, [project.scenario, project.pendingHandover, project.milestones]);
  const stageMilestone = activeMilestone ?? completedHandoverMilestone;
  const isRoleplay = !!project.scenario && stageMilestone?.scenarioStage === 'roleplay';
  const roleplayCharacter: PBLScenarioCharacter | undefined = isRoleplay
    ? project.scenario?.characters?.[0]
    : undefined;
  const scenarioCharacters = project.scenario?.characters;
  const activeAgentId = isRoleplay ? PBL_SIMULATOR_AGENT_ID : instructorRole?.id;

  const messages = useMemo<PBLChatMessage[]>(() => {
    const thread = project.threads.find((t) => t.agentId === activeAgentId);
    return thread?.messages ?? [];
  }, [project.threads, activeAgentId]);

  // SCENARIO ONLY. Once the learner is OUT of the roleplay scene (i.e. the chat
  // is showing the Instructor thread again — wrapup, or back here from the
  // completion page) AND a roleplay act actually happened, fold the whole
  // simulator-thread conversation into ONE collapsible block embedded in the
  // Instructor timeline. This stitches prep ↔ roleplay ↔ wrapup back into one
  // continuous, readable history instead of the scene vanishing on wrapup.
  // Empty (→ no block) for ordinary projects, during prep, and inside roleplay.
  const roleplayHistory = useMemo<PBLChatMessage[]>(() => {
    if (!project.scenario || isRoleplay) return [];
    const playedRoleplay = project.milestones.some(
      (m) => m.scenarioStage === 'roleplay' && m.status === 'completed',
    );
    if (!playedRoleplay) return [];
    const sim = project.threads.find((t) => t.agentId === PBL_SIMULATOR_AGENT_ID);
    return (sim?.messages ?? []).filter((m) => m.content?.trim());
  }, [project.scenario, project.milestones, project.threads, isRoleplay]);
  const [roleplayHistoryOpen, setRoleplayHistoryOpen] = useState(false);

  useLayoutEffect(() => {
    const seen = seenMessageIdsRef.current;
    if (!seen || seenMessageAgentIdRef.current !== activeAgentId) {
      seenMessageAgentIdRef.current = activeAgentId;
      seenMessageIdsRef.current = new Set(messages.map((message) => message.id));
      return;
    }
    const newlyAnimatedIds: string[] = [];
    for (const message of messages) {
      if (!message.id || seen.has(message.id)) continue;
      seen.add(message.id);
      if (
        message.roleType === 'instructor' &&
        isTaskCompletionReadyMessageContent(message.content) &&
        !animatingTaskReadyMessageIdsRef.current.has(message.id)
      ) {
        newlyAnimatedIds.push(message.id);
      }
    }
    if (!newlyAnimatedIds.length) return;
    setTaskReadyTypewriterIds((prev) => {
      const next = new Set(prev);
      for (const id of newlyAnimatedIds) {
        next.add(id);
        animatingTaskReadyMessageIdsRef.current.add(id);
      }
      return next;
    });
  }, [messages, activeAgentId]);

  const handleTaskReadyTypewriterComplete = useCallback((messageId: string) => {
    window.setTimeout(() => {
      setTaskReadyTypewriterIds((prev) => {
        if (!prev.has(messageId)) return prev;
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }, TASK_READY_TYPEWRITER_DONE_DELAY_MS);
  }, []);

  // Agent speaks first when its thread is empty so the learner never
  // lands in a silent chat. For the active agent:
  //   - roleplay stage → the Simulator opens the scene (system narration
  //     + the character's first line) via /simulator greeting;
  //   - everything else → the Instructor greeting via /open-task.
  // Keyed on the active agent so entering a roleplay stage triggers its
  // own scene opener exactly once. Ordinary projects only ever hit the
  // instructor branch (isRoleplay is always false without a scenario).
  useEffect(() => {
    if (project.uiPhase !== 'workspace') return;
    if (!activeAgentId) return;
    // `instructorStreaming` (ref-counted in the renderer) also guards a
    // run in flight from another instance, so we never double-open.
    if (messages.length > 0 || draftAssistant || streaming || instructorStreaming) return;
    const key = `${project.createdAt}:${activeAgentId}`;
    if (autoGreetingRef.current === key) return;
    autoGreetingRef.current = key;

    if (isRoleplay) {
      void run({ endpoint: '/api/pbl/v2/simulator', body: { phase: 'greeting' } });
      return;
    }

    const initialProject = structuredClone(project);
    const priorQuizResults = initialProject.pendingOpenTaskPriorQuizResults;
    if (priorQuizResults) {
      delete initialProject.pendingOpenTaskPriorQuizResults;
      onProjectChange(initialProject);
    }
    void run({
      endpoint: '/api/pbl/v2/open-task',
      body:
        priorQuizResults && priorQuizResults.length > 0
          ? { phase: 'greeting', priorQuizResults }
          : { phase: 'greeting' },
      initialProject,
    });
  }, [
    project.uiPhase,
    project.createdAt,
    project,
    activeAgentId,
    isRoleplay,
    messages.length,
    draftAssistant,
    streaming,
    instructorStreaming,
    run,
    onProjectChange,
  ]);

  // SCENARIO ONLY. Stage opener for roleplay / wrapup stages. The sidebar
  // "continue" / "enter scene" controls (and the enter_scenario route) only
  // MUTATE the project — they fire no opener turn — and roleplay stages produce
  // no milestone-eval card to carry one. The handover also seeds a divider into
  // the target thread, so the empty-thread auto-greeting above can't fire here
  // either. This effect is therefore the single, path-independent source of the
  // in-scene opener: when a roleplay/wrapup stage is active but its opener has
  // not run yet (no character / Instructor message tagged to THIS stage's beats,
  // dividers excluded), fire it exactly once. Strictly gated on `project.scenario`
  // so ordinary projects never reach it.
  useEffect(() => {
    if (!project.scenario || project.uiPhase !== 'workspace') return;
    if (draftAssistant || streaming || instructorStreaming) return;
    const active = project.milestones.find((m) => m.status === 'active');
    const stage = active?.scenarioStage;
    if (!active || (stage !== 'roleplay' && stage !== 'wrapup')) return;
    const beatIds = new Set(active.microtasks.map((task) => task.id));
    const wantRole = stage === 'roleplay' ? 'simulator' : 'instructor';
    const threadAgentId = stage === 'roleplay' ? PBL_SIMULATOR_AGENT_ID : instructorRole?.id;
    const thread = project.threads.find((th) => th.agentId === threadAgentId);
    const opened = (thread?.messages ?? []).some(
      (m) =>
        m.roleType === wantRole &&
        !!m.microtaskId &&
        beatIds.has(m.microtaskId) &&
        !m.content.startsWith(MILESTONE_DIVIDER_PREFIX) &&
        !m.content.startsWith(TASK_DIVIDER_PREFIX),
    );
    if (opened) return;
    if (scenarioStageOpenerRef.current === active.id) return;
    scenarioStageOpenerRef.current = active.id;
    void run(
      stage === 'roleplay'
        ? { endpoint: '/api/pbl/v2/simulator', body: { phase: 'greeting' } }
        : { endpoint: '/api/pbl/v2/open-task', body: { phase: 'setup' } },
    );
  }, [project, draftAssistant, streaming, instructorStreaming, instructorRole?.id, run]);

  // Interleave evaluations into the chat feed by timestamp. Task /
  // milestone evals are part of the conversation flow (each is a
  // reaction to something the learner did) so the visual story
  // requires them to appear in the right order — not in a separate
  // panel. Final evaluations live in chat too, *next to* a CTA card.
  //
  // We merge messages + evaluations into one timeline keyed by
  // `createdAt` / `ts`. Ties resolved by item kind preference:
  //   message < evaluation (eval after message of same instant)
  //
  // Rendered items are typed so the render switch can branch
  // cleanly on `.kind`.
  const timeline = useMemo<TimelineItem[]>(
    () => buildTimeline(messages, project.evaluations, roleplayHistory),
    [messages, project.evaluations, roleplayHistory],
  );

  // Auto-grow textarea as the learner types.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
  }, [input]);

  // Auto-scroll to bottom on new tokens / new messages.
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, draftAssistant, submissionEvaluationStatus]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || chatBusy || projectCompleted || handoverPending) return;
    setInput('');
    // Optimistic local append — show the user's message immediately
    // so they don't feel like the chat froze while the LLM warms up.
    // The server intentionally does NOT echo the user message back as
    // a project_patch (see lib/pbl/v2/agents/instructor.ts), so this
    // optimistic append is the single source of truth for it.
    const microtaskId = currentMicrotaskId(project);
    const withUser = appendUserMessage(project, activeAgentId, text, microtaskId);
    onProjectChange(withUser);
    if (isRoleplay) {
      void run({
        endpoint: '/api/pbl/v2/simulator',
        body: { userMessage: text, phase: 'instructing' },
        initialProject: withUser,
      });
      return;
    }
    void run({
      endpoint: '/api/pbl/v2/instructor',
      body: { userMessage: text, phase: 'instructing' },
      initialProject: withUser,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    handleSend();
  };

  // In a roleplay stage the streaming/label name is the character; the
  // per-message bubble still resolves its own speaker by characterId.
  const displayName = displayAgentName(
    isRoleplay ? (roleplayCharacter?.name ?? agentName) : (agentName ?? instructorRole?.name),
    isRoleplay ? 'Character' : 'Instructor',
  );
  // Learner-facing intro shown on hover of the instructor avatar; falls back to
  // the role name when there's no curated intro.
  const agentIntro = instructorIntroText(instructorRole);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <main className="pbl-v2-scroll-fade flex-1 space-y-3 overflow-y-auto px-6 py-5">
        {messages.length === 0 && !draftAssistant && !streamActive && (
          <EmptyChatPlaceholder agentName={displayName} />
        )}

        {timeline.map((item) => {
          if (item.kind === 'message') {
            return (
              <MessageBubble
                key={item.message.id}
                message={item.message}
                agentName={displayName}
                characters={scenarioCharacters}
                agentIntro={agentIntro}
                typewriter={taskReadyTypewriterIds.has(item.message.id)}
                onTypewriterComplete={handleTaskReadyTypewriterComplete}
              />
            );
          }
          if (item.kind === 'roleplay-history') {
            return (
              <RoleplayHistoryBlock
                key="roleplay-history"
                messages={item.messages}
                characters={scenarioCharacters}
                open={roleplayHistoryOpen}
                onToggle={() => setRoleplayHistoryOpen((v) => !v)}
                title={t('pbl.v2.chat.roleplayHistoryTitle')}
              />
            );
          }
          // item.kind === 'evaluation'
          const ev = item.evaluation;
          if (ev.kind === 'task') {
            // Task eval is a distinct review moment, not a normal
            // chat reply. It stays in the same timeline but uses a
            // subtle accent treatment so learners can scan it apart
            // from instructor guidance.
            const feedback = stripTailForDisplay(ev.feedback).trim();
            return (
              <div key={ev.id} className="flex justify-start">
                <div className="pbl-v2-task-review-shell max-w-[90%] rounded-[22px] px-4 py-3 text-sm text-slate-800">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-violet-700">
                    {displayName} · {t('pbl.v2.taskEvalCard.title')}
                  </div>
                  {feedback && (
                    <MarkdownText
                      content={feedback}
                      className="pbl-v2-light-card-markdown pbl-v2-task-review-markdown text-slate-700 prose-p:text-slate-700 prose-strong:text-slate-900"
                    />
                  )}
                  <TaskEvaluationCard evaluation={ev} className="mt-3" />
                </div>
              </div>
            );
          }
          if (ev.kind === 'milestone') {
            // Milestone card is full-width; pull it out of the
            // narrow chat-bubble cell so the reflection feels like
            // a distinct moment, not another message.
            return (
              <MilestoneCard
                key={ev.id}
                evaluation={ev}
                handover={handoverForMilestoneEvaluation(ev, project.pendingHandover)}
                onContinue={handleContinueHandover}
                className="my-1"
              />
            );
          }
          if (ev.kind === 'final') {
            // Final eval feeds the dedicated completion report. In chat, keep
            // only the entry-point card so the same summary is not repeated
            // once here and again on the report page.
            return (
              <div key={ev.id} className="space-y-3">
                <CompletionCtaCard
                  onView={() => onProjectChange(transitionProjectUiPhase(project, 'completed'))}
                />
              </div>
            );
          }
          return null;
        })}

        {submissionEvaluationStatus && (
          <SubmissionEvaluationBubble
            status={submissionEvaluationStatus}
            agentName={displayName}
            agentIntro={agentIntro}
          />
        )}

        {showStreamingDraft && (
          // When the stream belongs to THIS instance, show its live status +
          // tokens. When it's only a background stream resumed across a remount
          // (own `streaming` false), the live tokens live in the unmounted
          // instance and can't be recovered — fall back to a generic
          // Instructor "thinking…" bubble so the learner still knows to wait;
          // the finished message lands via the store when the stream settles.
          // Suppressed while a submission evaluation is showing its own richer
          // bubble (below) so the two don't stack.
          <StreamingDraft
            status={visibleStreamStatus}
            // Evaluator output is JSON-only and lands as cards/report data.
            // Keep the stream bubble as a neutral waiting state.
            draft={visibleStreamStatus.startsWith('eval-') ? '' : visibleDraftAssistant}
            agentName={displayName}
            agentIntro={agentIntro}
            handover={project.pendingHandover}
            character={isRoleplay ? roleplayCharacter : undefined}
            simPhase={simPhase}
          />
        )}

        {error && (
          <div className="flex items-start justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-red-200">
            <span>{error}</span>
            <button
              onClick={clearError}
              className="shrink-0 underline underline-offset-2 hover:opacity-80"
            >
              {t('pbl.v2.hero.close')}
            </button>
          </div>
        )}

        <div ref={scrollEndRef} />
      </main>

      <footer
        className="border-t border-cyan-100/[0.11] bg-[#101b32]/82 px-4 py-3 backdrop-blur"
        onMouseMove={
          handoverPending ? (e) => setHandoverHintPos({ x: e.clientX, y: e.clientY }) : undefined
        }
        onMouseLeave={handoverPending ? () => setHandoverHintPos(null) : undefined}
      >
        {/* Stage hand-off lives in the LEFT roadmap (sidebar), never here — and
            only once the stage's tasks are all complete. Within a roleplay
            stage the learner cannot click past an interaction; beats advance
            only when the engine detects they actually happened. */}

        {/* Roleplay act: a single light pointer to the right-side panel, which
            already shows this act's full brief + all its (hidden-beat) hints,
            bound to the current act. We intentionally DON'T duplicate per-beat
            hints / suggested-reply buttons inline: in the act model beats don't
            advance, so an inline beat-bound strip would be frozen on the first
            beat. The right panel is the single, act-level source of guidance. */}
        {isRoleplay && !handoverPending && !projectCompleted && (
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] leading-snug text-muted-foreground/80">
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-violet-200/70" />
            <span>{t('pbl.v2.chat.guidancePointer')}</span>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-2xl border border-cyan-100/[0.13] bg-slate-700/[0.26] px-3 py-2 shadow-[0_12px_34px_rgba(6,16,34,0.28)] transition-all focus-within:border-primary/70 focus-within:bg-slate-700/[0.34] focus-within:shadow-[0_0_0_1px_rgba(157,140,255,0.28),0_16px_40px_rgba(6,16,34,0.30)]">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-cyan-100/[0.12] bg-cyan-100/[0.06] text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            rows={MIN_ROWS}
            disabled={projectCompleted || handoverPending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              projectCompleted
                ? t('pbl.v2.chat.placeholderCompleted')
                : handoverPending
                  ? t('pbl.v2.chat.handoverHint')
                  : t('pbl.v2.chat.placeholder', { name: displayName })
            }
            className={cn(
              'flex-1 resize-none bg-transparent text-sm leading-6',
              'text-foreground placeholder:text-muted-foreground focus:outline-none',
              'pbl-v2-scrollbar max-h-[200px] overflow-y-auto whitespace-pre-wrap',
              // While a handover is pending the textarea is disabled; drop
              // pointer events so the footer still receives mousemove and
              // can show the "click Continue" hint over the input area.
              handoverPending && 'pointer-events-none',
            )}
            style={{ fontFamily: 'inherit' }}
          />
          <SpeechButton
            onTranscription={(text) => {
              if (!text.trim()) return;
              setInput((prev) => (prev ? `${prev} ${text}` : text));
            }}
            disabled={chatBusy || projectCompleted || handoverPending}
            continuous
          />
          <button
            onClick={handleSend}
            disabled={chatBusy || !input.trim() || projectCompleted || handoverPending}
            aria-label={t('pbl.v2.chat.send')}
            className={cn(
              'shrink-0 rounded-xl h-9 w-9 flex items-center justify-center',
              'bg-primary text-primary-foreground shadow-[0_0_24px_rgba(155,124,255,0.35)] hover:opacity-90 transition-opacity',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground/80 text-center mt-2">
          {t('pbl.v2.chat.keyboardHint')}
        </p>
      </footer>
      {handoverPending && handoverHintPos && (
        <div
          className="pointer-events-none fixed z-50 max-w-[220px] rounded-md border border-violet-300/40 bg-slate-900/95 px-2.5 py-1.5 text-[11px] font-medium text-violet-100 shadow-[0_8px_24px_rgba(6,16,34,0.45)]"
          style={{ left: handoverHintPos.x + 14, top: Math.max(8, handoverHintPos.y - 34) }}
        >
          {t('pbl.v2.chat.handoverHint')}
        </div>
      )}
    </div>
  );
}

function SubmissionEvaluationBubble({
  status,
  agentName,
  agentIntro,
}: {
  readonly status: SubmissionEvaluationStatus;
  readonly agentName: string;
  readonly agentIntro?: string;
}) {
  const { t } = useI18n();
  const streamStatus = status.streamStatus;
  if (streamStatus && streamStatus !== 'idle') {
    return (
      <StreamingDraft
        status={streamStatus}
        draft={status.draft ?? ''}
        agentName={agentName}
        submissionMicrotaskTitle={status.microtaskTitle}
      />
    );
  }
  const isFollowup = status.phase === 'followup';
  if (isFollowup) {
    return (
      <div className="flex items-start gap-2">
        <InstructorAvatar agentName={agentName} agentIntro={agentIntro} />
        <div className="pbl-v2-instructor-bubble max-w-[90%] rounded-2xl px-4 py-3 text-sm">
          <div className="pbl-v2-instructor-label mb-2 text-[10px] uppercase">
            {t('pbl.v2.chat.thinking', { name: agentName })}
          </div>
          <ThinkingDots />
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-xl border border-primary/30 bg-primary/[0.12] px-4 py-3 text-sm shadow-[0_12px_30px_rgba(6,16,34,0.22)]">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-primary mb-2">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {t('pbl.v2.chat.submitted')}
        </div>
        <div className="flex items-start gap-2 text-foreground">
          <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin text-primary" />
          <div className="leading-relaxed">
            <div className="font-medium">{t('pbl.v2.chat.evaluatingSubmission')}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {t('pbl.v2.chat.evaluatingSubmissionDetail', { title: status.microtaskTitle })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StreamingDraft({
  status,
  draft,
  agentName,
  agentIntro,
  handover,
  submissionMicrotaskTitle,
  character,
  simPhase,
}: {
  readonly status: import('./use-instructor-stream').StreamStatus;
  readonly draft: string;
  readonly agentName: string;
  readonly agentIntro?: string;
  readonly handover?: PBLProjectV2['pendingHandover'];
  readonly submissionMicrotaskTitle?: string;
  // SCENARIO ONLY: when the streaming turn is a roleplay character, show
  // that character's avatar instead of the Instructor's.
  readonly character?: PBLScenarioCharacter;
  // SCENARIO ONLY: which Simulator sub-phase is loading (narration vs
  // character) so the indicator is honest about who is "thinking".
  readonly simPhase?: import('./use-instructor-stream').SimPhase;
}) {
  const { t } = useI18n();
  const displayDraft = usePacedText(draft, { active: status !== 'idle' });
  const hasTokens = displayDraft.trim().length > 0;
  const isCaughtUpToLatestChunk = hasTokens && displayDraft.length >= draft.length;
  const label = streamStatusLabel(status, agentName, t, hasTokens);

  // SCENARIO ONLY: the SYSTEM narrator is composing scene narration —
  // show a neutral, centred "narrating…" indicator (no character avatar),
  // matching the system-narration bubble style, so the learner knows it
  // is the scene being set, not the character speaking. (Placed after the
  // hook calls above so hook order stays unconditional.)
  if (simPhase === 'narration') {
    return (
      <div className="flex justify-center py-1.5">
        <div className="flex items-center gap-2 rounded-xl border border-cyan-100/[0.10] bg-slate-100/[0.05] px-4 py-2 text-[13px] italic text-muted-foreground">
          <span>{t('pbl.v2.chat.narrating')}</span>
          <ThinkingDots />
        </div>
      </div>
    );
  }
  if (status === 'eval-task') {
    return (
      <div className="flex justify-start">
        <div className="pbl-v2-task-review-shell max-w-[90%] animate-in fade-in-0 rounded-[22px] px-4 py-3 text-sm text-slate-800 duration-300">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-violet-700">{label}</div>
          {hasTokens ? (
            <MarkdownText
              content={streamingEvaluationPreview(displayDraft)}
              className="pbl-v2-light-card-markdown pbl-v2-task-review-markdown text-slate-700 prose-p:text-slate-700 prose-strong:text-slate-900"
            />
          ) : (
            <div className="flex items-start gap-2 text-slate-600">
              <ThinkingDots tone="violet" />
              <div className="pt-0.5 text-xs leading-relaxed text-slate-500">
                {submissionMicrotaskTitle
                  ? t('pbl.v2.chat.readingSubmissionWithTitle', { title: submissionMicrotaskTitle })
                  : t('pbl.v2.chat.readingSubmission')}
              </div>
            </div>
          )}
          {isCaughtUpToLatestChunk && <ContinuingDots tone="violet" />}
        </div>
      </div>
    );
  }

  if (status === 'eval-milestone') {
    return (
      <div className="relative animate-in fade-in-0 overflow-hidden rounded-2xl border border-violet-200/85 bg-[linear-gradient(145deg,rgba(252,250,255,0.98)_0%,rgba(238,242,255,0.94)_48%,rgba(232,250,255,0.96)_100%)] p-5 text-slate-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_22px_58px_rgba(8,18,38,0.30),0_0_0_1px_rgba(139,92,246,0.10),0_0_42px_rgba(34,211,238,0.10)] ring-1 ring-violet-300/20 duration-300">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 via-indigo-500 to-cyan-400" />
        <div className="relative mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-violet-700">
          {label}
        </div>
        {hasTokens ? (
          <MarkdownText
            content={streamingEvaluationPreview(displayDraft)}
            className="pbl-v2-light-card-markdown text-slate-700 prose-p:text-slate-700 prose-strong:text-slate-900 prose-li:marker:text-violet-500"
          />
        ) : (
          <ThinkingDots tone="violet" />
        )}
        {handover && (
          <div className="relative mt-3 border-t border-violet-200/80 pt-2 text-xs text-slate-500">
            {t('pbl.v2.chat.milestoneFeedbackPending')}
          </div>
        )}
        {isCaughtUpToLatestChunk && <ContinuingDots tone="violet" />}
      </div>
    );
  }

  if (status === 'eval-final') {
    return (
      <div className="space-y-3">
        <div className="animate-in fade-in-0 rounded-xl border border-cyan-100/[0.12] bg-slate-800/[0.48] px-4 py-3 text-sm shadow-[0_12px_30px_rgba(6,16,34,0.22)] duration-300">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">{label}</div>
          {hasTokens ? (
            <MarkdownText content={streamingEvaluationPreview(displayDraft)} />
          ) : (
            <ThinkingDots />
          )}
          {isCaughtUpToLatestChunk && <ContinuingDots />}
        </div>
      </div>
    );
  }

  const displayContent = streamingMessagePreview(displayDraft);
  return (
    <div className="flex items-start gap-2">
      {character ? (
        <CharacterAvatar character={character} name={agentName} />
      ) : (
        <InstructorAvatar agentName={agentName} agentIntro={agentIntro} />
      )}
      <div className="pbl-v2-instructor-bubble max-w-[90%] rounded-2xl px-4 py-3 text-sm">
        <div className="pbl-v2-instructor-label mb-2 text-[10px] uppercase">{label}</div>
        {displayContent.trim() ? <MarkdownText content={displayContent} /> : <ThinkingDots />}
        {isCaughtUpToLatestChunk && <ContinuingDots />}
      </div>
    </div>
  );
}

/**
 * SCENARIO ONLY. Collapsible block that embeds the whole roleplay-scene
 * conversation inside the Instructor timeline (between prep and wrapup), so the
 * three stages read as one continuous history. Default collapsed; the toggle is
 * prominent and clearly labelled. Reuses MessageBubble so the folded content
 * renders identically to the live scene.
 */
function RoleplayHistoryBlock({
  messages,
  characters,
  open,
  onToggle,
  title,
}: {
  readonly messages: readonly PBLChatMessage[];
  readonly characters?: readonly PBLScenarioCharacter[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly title: string;
}) {
  return (
    <div className="rounded-2xl border border-violet-300/25 bg-violet-500/[0.06]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-violet-500/[0.10]"
      >
        <Drama className="h-4 w-4 shrink-0 text-violet-200/90" />
        <span className="flex-1 text-sm font-semibold text-violet-50">{title}</span>
        <span className="text-[11px] text-violet-200/70">{messages.length}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-violet-200/80" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-violet-200/80" />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-violet-300/15 px-4 py-4">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} agentName="" characters={characters} />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  agentName,
  characters,
  agentIntro,
  typewriter = false,
  onTypewriterComplete,
}: {
  readonly message: PBLChatMessage;
  readonly agentName: string;
  readonly characters?: readonly PBLScenarioCharacter[];
  readonly agentIntro?: string;
  readonly typewriter?: boolean;
  readonly onTypewriterComplete?: (messageId: string) => void;
}) {
  // SCENARIO ONLY — neutral system narration (旁白): centred, italic, no
  // avatar/name, so it reads as the scene speaking, not a person.
  if (message.roleType === 'system') {
    const narration = message.content.trim();
    if (!narration) return null;
    return (
      <div className="flex justify-center py-1.5">
        <div className="max-w-[82%] rounded-xl border border-cyan-100/[0.10] bg-slate-100/[0.05] px-4 py-2 text-center text-[13px] italic leading-relaxed text-muted-foreground">
          {narration}
        </div>
      </div>
    );
  }

  // SCENARIO ONLY — an in-character line from the cast. Distinct avatar +
  // the character's own name so it never reads like the Instructor.
  if (message.roleType === 'simulator') {
    const character = characters?.find((c) => c.id === message.characterId) ?? characters?.[0];
    const name = character?.name ?? agentName;
    const content = message.content.trim();
    if (!content) return null;
    return (
      <div className="flex justify-start">
        <CharacterAvatar character={character} name={name} />
        <div className="ml-2 max-w-[85%] rounded-2xl border border-amber-200/20 bg-amber-100/[0.06] px-4 py-3 text-sm text-card-foreground shadow-[0_12px_30px_rgba(6,16,34,0.22)]">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-amber-200/80">{name}</div>
          <MarkdownText content={content} />
        </div>
      </div>
    );
  }

  if (
    message.roleType === 'instructor' &&
    typeof message.content === 'string' &&
    message.content.startsWith(TASK_DIVIDER_PREFIX)
  ) {
    const label = message.content.slice(TASK_DIVIDER_PREFIX.length).trim();
    return (
      <div className="flex justify-center py-1">
        <div className="rounded-full border border-slate-200/70 bg-slate-100/90 px-3 py-1 text-[11px] font-medium text-slate-600 shadow-[0_10px_24px_rgba(6,16,34,0.18)]">
          {label}
        </div>
      </div>
    );
  }

  if (
    message.roleType === 'instructor' &&
    typeof message.content === 'string' &&
    message.content.startsWith(MILESTONE_DIVIDER_PREFIX)
  ) {
    const label = message.content.slice(MILESTONE_DIVIDER_PREFIX.length).trim();
    return (
      <div className="flex items-center justify-center py-3" aria-label={label}>
        <div className="flex min-w-[52%] max-w-[90%] items-center gap-3">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-violet-200/70 to-cyan-200/70" />
          <div className="relative rounded-full border border-violet-200/70 bg-gradient-to-r from-violet-50/95 via-indigo-50/90 to-cyan-50/95 px-4 py-1.5 text-[11px] font-semibold text-violet-700 shadow-[0_12px_34px_rgba(55,48,163,0.24)]">
            <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,0.48)]" />
            <span className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.45)]" />
            {label}
          </div>
          <div className="h-px flex-1 bg-gradient-to-l from-transparent via-cyan-200/70 to-violet-200/70" />
        </div>
      </div>
    );
  }

  const isUser = message.roleType === 'user';
  const displayContent = (
    !isUser && typeof message.content === 'string'
      ? stripEmbeddedDividerMarkers(message.content)
      : message.content
  ).trim();
  if (!displayContent.trim()) return null;

  if (!isUser) {
    return (
      <InstructorMessageBubble
        key={`${message.id}:${typewriter ? 'typewriter' : 'static'}`}
        messageId={message.id}
        content={displayContent}
        agentName={agentName}
        agentIntro={agentIntro}
        typewriter={typewriter}
        onTypewriterComplete={onTypewriterComplete}
      />
    );
  }

  return (
    <div className="flex justify-end">
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-[0_12px_30px_rgba(6,16,34,0.22)]',
          'bg-gradient-to-br from-primary to-violet-400 text-primary-foreground shadow-[0_14px_34px_rgba(124,92,255,0.24)]',
        )}
      >
        <div className="whitespace-pre-wrap break-words">{displayContent}</div>
      </div>
    </div>
  );
}

function InstructorMessageBubble({
  messageId,
  content,
  agentName,
  agentIntro,
  typewriter,
  onTypewriterComplete,
}: {
  readonly messageId: string;
  readonly content: string;
  readonly agentName: string;
  readonly agentIntro?: string;
  readonly typewriter: boolean;
  readonly onTypewriterComplete?: (messageId: string) => void;
}) {
  const displayContent = usePacedText(content, { active: typewriter });
  const typing = typewriter && displayContent.length < content.length;

  useEffect(() => {
    if (!typewriter || typing) return;
    onTypewriterComplete?.(messageId);
  }, [typewriter, typing, messageId, onTypewriterComplete]);

  return (
    <div className="flex justify-start">
      <InstructorAvatar agentName={agentName} agentIntro={agentIntro} />
      <div className="pbl-v2-instructor-bubble ml-2 max-w-[85%] rounded-2xl px-4 py-3 text-sm text-card-foreground shadow-[0_12px_30px_rgba(6,16,34,0.22)]">
        <div className="pbl-v2-instructor-label mb-1 text-[10px] uppercase">{agentName}</div>
        <MarkdownText content={displayContent} />
        {typing && <ContinuingDots />}
      </div>
    </div>
  );
}

/** PBL v2 instructor avatar — a PBL-owned asset, intentionally NOT
 *  roundtable's `DEFAULT_TEACHER_AVATAR`, so the instructor's face is
 *  decoupled from the OpenMAIC classroom teacher avatar; changing one
 *  never affects the other. */
const PBL_INSTRUCTOR_AVATAR = '/avatars/instructor.png';

const INSTRUCTOR_AVATAR_RING =
  'h-8 w-8 overflow-hidden rounded-full border border-primary/35 bg-primary/15 shadow-[0_0_22px_rgba(169,148,255,0.22)]';

function InstructorAvatar({
  agentName,
  agentIntro,
}: {
  readonly agentName: string;
  readonly agentIntro?: string;
}) {
  // No curated intro (un-set role): keep the original lightweight behaviour —
  // a native title with the name. The avatar stays decorative.
  if (!agentIntro) {
    return (
      <div
        className={cn('mt-0.5 shrink-0', INSTRUCTOR_AVATAR_RING)}
        title={agentName}
        aria-hidden="true"
      >
        <AvatarDisplay src={PBL_INSTRUCTOR_AVATAR} alt={agentName} />
      </div>
    );
  }

  // With an intro: a pure-CSS hover tooltip. group-hover is instant (no JS
  // delay, no portal that could fail to render), the cursor is left unchanged,
  // and the frame is a clean dark card (no border) with roomy padding.
  return (
    // `self-start` so the wrapper is exactly the avatar's height (it must NOT
    // stretch to the message-row height — otherwise `top-full` lands far below
    // the bubble). The tooltip then sits right under the avatar, near the
    // pointer; overlapping the bubble is fine.
    <div className="group relative mt-0.5 shrink-0 self-start">
      <div className={INSTRUCTOR_AVATAR_RING} aria-hidden="true">
        <AvatarDisplay src={PBL_INSTRUCTOR_AVATAR} alt={agentName} />
      </div>
      <div
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-50 mt-2 w-max max-w-xs whitespace-normal rounded-lg bg-neutral-900 px-3.5 py-2.5 text-xs leading-relaxed text-neutral-100 opacity-0 shadow-xl transition-opacity duration-100 group-hover:opacity-100"
      >
        {agentIntro}
      </div>
    </div>
  );
}

/** SCENARIO ONLY — avatar for an in-scene character. Uses the authored
 *  `character.avatar` when present; otherwise a warm initial-letter
 *  badge, visually distinct from the Instructor avatar so the learner
 *  always knows who is speaking. */
function CharacterAvatar({
  character,
  name,
}: {
  readonly character?: PBLScenarioCharacter;
  readonly name: string;
}) {
  if (character?.avatar) {
    return (
      <div
        className="mt-0.5 h-8 w-8 shrink-0 overflow-hidden rounded-full border border-amber-200/40 bg-amber-100/15 shadow-[0_0_22px_rgba(251,191,36,0.18)]"
        title={name}
        aria-hidden="true"
      >
        <AvatarDisplay src={character.avatar} alt={name} />
      </div>
    );
  }
  return (
    <div
      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-200/40 bg-gradient-to-br from-amber-300/30 to-rose-300/25 text-xs font-semibold text-amber-100 shadow-[0_0_22px_rgba(251,191,36,0.18)]"
      title={name}
      aria-hidden="true"
    >
      {Array.from(name.trim())[0] ?? '·'}
    </div>
  );
}

function usePacedText(raw: string, opts: { readonly active: boolean }): string {
  const [visible, setVisible] = useState(() => (opts.active ? '' : raw));
  const visibleRef = useRef(visible);
  const rawRef = useRef(raw);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    rawRef.current = raw;
    if (!opts.active) {
      visibleRef.current = raw;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional derived-state sync for paced text streaming
      setVisible(raw);
      return;
    }
    if (!raw) {
      visibleRef.current = '';
      setVisible('');
      return;
    }
    if (visibleRef.current === raw) {
      visibleRef.current = '';
      setVisible('');
      return;
    }
    if (!raw.startsWith(visibleRef.current)) {
      visibleRef.current = raw;
      setVisible(raw);
    }
  }, [raw, opts.active]);

  useEffect(() => {
    if (!opts.active) return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = () => {
      if (cancelled) return;
      const target = rawRef.current;
      const current = visibleRef.current;
      if (current.length >= target.length) {
        timer = window.setTimeout(tick, 24);
        return;
      }
      const remaining = target.length - current.length;
      const step = pacedStep(target.slice(current.length), remaining);
      const next = target.slice(0, current.length + step);
      visibleRef.current = next;
      setVisible(next);
      timer = window.setTimeout(tick, pacedDelay(remaining));
    };

    timer = window.setTimeout(tick, 18);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [opts.active]);

  return visible;
}

function pacedStep(upcoming: string, remaining: number): number {
  if (remaining <= 0) return 0;
  const first = Array.from(upcoming).slice(0, 12);
  if (first.length === 0) return 1;
  // Keep punctuation attached to the preceding phrase so the prose
  // feels typed, not chopped into mechanical single glyphs.
  const punctuationAt = first.findIndex((ch) => /[，。！？；：,.!?;:、\n]/u.test(ch));
  if (punctuationAt >= 0 && punctuationAt <= 5) return punctuationAt + 1;
  if (remaining > 240) return 3;
  if (remaining > 80) return 2;
  return 1;
}

function pacedDelay(remaining: number): number {
  if (remaining > 240) return 14;
  if (remaining > 120) return 18;
  if (remaining > 40) return 24;
  return 32;
}

function EmptyChatPlaceholder({ agentName }: { readonly agentName: string }) {
  const { t } = useI18n();
  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      {t('pbl.v2.chat.emptyChat')}
      <br />
      {t('pbl.v2.chat.emptyChatHint', { name: agentName })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline merge: messages + evaluations → one stream in time order
// ---------------------------------------------------------------------------

export type TimelineItem =
  | { kind: 'message'; ts: string; message: PBLChatMessage }
  | { kind: 'evaluation'; ts: string; evaluation: PBLEvaluation }
  | { kind: 'roleplay-history'; ts: string; messages: PBLChatMessage[] };

/**
 * Merge messages and evaluations into a single ordered feed.
 *
 * Evaluations are sorted alongside chat by their `createdAt`. Ties
 * resolve eval-after-message — if a message and an eval share the
 * exact same timestamp (rare; happens when the SSE patch fires
 * within the same millisecond as a streamed token), the message
 * appears first so the assistant's prose is read before the
 * structured card it produced.
 *
 * SCENARIO ONLY: when `roleplayHistory` is non-empty, the whole
 * roleplay conversation is folded into ONE collapsible item, slotted by
 * the timestamp of its first message — so it lands between the prep
 * messages (earlier) and the wrapup messages (later), reconnecting the
 * three stages into one continuous Instructor-side feed.
 *
 * Pure function — easy to unit-test independently of React.
 */
export function buildTimeline(
  messages: PBLChatMessage[],
  evaluations: PBLEvaluation[],
  roleplayHistory: PBLChatMessage[] = [],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m): TimelineItem => ({ kind: 'message', ts: m.ts, message: m })),
    ...evaluations.map(
      (e): TimelineItem => ({ kind: 'evaluation', ts: e.createdAt, evaluation: e }),
    ),
  ];
  if (roleplayHistory.length > 0) {
    items.push({
      kind: 'roleplay-history',
      ts: roleplayHistory[0].ts,
      messages: roleplayHistory,
    });
  }
  items.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
    // tie-break: message before evaluation
    if (a.kind === b.kind) return 0;
    return a.kind === 'message' ? -1 : 1;
  });
  return items;
}

function stripTailForDisplay(text: string | undefined): string {
  return stripEvaluationTail(text ?? '');
}

export function displayAgentName(name: string | undefined | null, fallback: string): string {
  const trimmed = name?.trim();
  return trimmed || fallback;
}

export function shouldShowStreamingDraft({
  streaming,
  instructorStreaming,
  draftAssistant,
  streamCommittedOutput,
  hasExternalDraft = false,
  submissionEvaluationActive,
}: {
  readonly streaming: boolean;
  readonly instructorStreaming: boolean;
  readonly draftAssistant: string;
  readonly streamCommittedOutput: boolean;
  readonly hasExternalDraft?: boolean;
  readonly submissionEvaluationActive: boolean;
}): boolean {
  if (submissionEvaluationActive) return false;
  if (streaming || hasExternalDraft) {
    return !streamCommittedOutput || draftAssistant.trim().length > 0;
  }
  if (streamCommittedOutput) return false;
  return instructorStreaming;
}

export function handoverForMilestoneEvaluation(
  evaluation: PBLEvaluation,
  handover: PBLProjectV2['pendingHandover'],
): PBLProjectV2['pendingHandover'] | undefined {
  if (evaluation.kind !== 'milestone') return undefined;
  if (!handover) return undefined;
  if (!evaluation.milestoneId) return undefined;
  return handover.completedMilestoneId === evaluation.milestoneId ? handover : undefined;
}

export function streamingEvaluationPreview(text: string): string {
  const withoutFence = text.replace(/```j(?:s(?:o(?:n)?)?)?[\s\S]*$/i, '').trimEnd();
  const withoutBareJson = withoutFence.replace(/\n\s*\{[\s\S]*$/m, '').trimEnd();
  return withoutBareJson;
}

export function streamingMessagePreview(text: string): string {
  return stripLeakedToolJsonPreview(stripEmbeddedDividerMarkers(text)).trimEnd();
}

export function stripLeakedToolJsonPreview(text: string): string {
  const withoutCompleteJson = text.replace(
    /[^\S\r\n]*(?:\{[\s\S]{0,500}?"kind"\s*:\s*"(?:concept_unlocked|error|struggle|question)"[\s\S]{0,500}?\}|\{[\s\S]{0,500}?"signature"\s*:\s*"[^"]+"[\s\S]{0,500}?\})[^\S\r\n]*/g,
    '',
  );
  return withoutCompleteJson
    .replace(
      /[^\S\r\n]*\{(?=[\s\S]{0,500}?"kind"\s*:\s*"(?:concept_unlocked|error|struggle|question)")(?![\s\S]*\})[\s\S]*$/g,
      '',
    )
    .replace(/[^\S\r\n]*\{(?=[\s\S]{0,500}?"signature"\s*:)(?![\s\S]*\})[\s\S]*$/g, '')
    .replace(/[^\S\r\n]*\{[\s\S]{0,500}?"(?:kind|signature)"\s*:\s*"[^"]*$/g, '')
    .trim();
}

/**
 * Map the stream's coarse-grained phase to the small "X · 思考中" /
 * "X · 输入中…" line that floats above the streaming bubble. Per
 * PR 6 D3-B: keep evaluator labels neutral (no "等我整理一下" filler).
 */
function streamStatusLabel(
  status: import('./use-instructor-stream').StreamStatus,
  agentName: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  hasTokens = false,
): string {
  switch (status) {
    case 'eval-task':
      return t('pbl.v2.chat.evaluatingTask', { name: agentName });
    case 'eval-milestone':
      return t('pbl.v2.chat.generatingMilestoneFeedback');
    case 'eval-final':
      return t('pbl.v2.chat.generatingFinalEval');
    case 'instructor':
    case 'idle':
    default:
      return hasTokens
        ? t('pbl.v2.chat.typing', { name: agentName })
        : t('pbl.v2.chat.thinking', { name: agentName });
  }
}

/** Three-dot typing indicator. Used while we know the LLM is
 *  processing but haven't received any tokens yet.
 *
 *  Uses a custom opacity animation (1 → 0.15 → 1) instead of
 *  `animate-bounce` to avoid vertical overlap with the label above.
 *  The swing is intentionally wide so the wave is clearly visible
 *  even on small dots against dark backgrounds. */
function ThinkingDots({ tone = 'muted' }: { readonly tone?: 'muted' | 'violet' } = {}) {
  const dotClass =
    tone === 'violet'
      ? 'bg-violet-500/70 shadow-[0_0_10px_rgba(139,92,246,0.28)]'
      : 'bg-muted-foreground';
  return (
    <div className="flex items-center gap-1 py-1">
      <span
        className={cn('w-1.5 h-1.5 rounded-full', dotClass)}
        style={{
          animationName: 'think-dot-pulse',
          animationDuration: '1.4s',
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationDelay: '-0.3s',
        }}
      />
      <span
        className={cn('w-1.5 h-1.5 rounded-full', dotClass)}
        style={{
          animationName: 'think-dot-pulse',
          animationDuration: '1.4s',
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationDelay: '-0.15s',
        }}
      />
      <span
        className={cn('w-1.5 h-1.5 rounded-full', dotClass)}
        style={{
          animationName: 'think-dot-pulse',
          animationDuration: '1.4s',
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationDelay: '0s',
        }}
      />
    </div>
  );
}

function ContinuingDots({ tone = 'muted' }: { readonly tone?: 'muted' | 'violet' } = {}) {
  const { t } = useI18n();
  const dotClass =
    tone === 'violet'
      ? 'bg-violet-500/65 shadow-[0_0_10px_rgba(139,92,246,0.24)]'
      : 'bg-muted-foreground/55';
  return (
    <div className="mt-1 flex items-center gap-1" aria-label={t('pbl.v2.chat.stillTyping')}>
      <span
        className={cn('h-1 w-1 rounded-full', dotClass)}
        style={{
          animationName: 'think-dot-pulse',
          animationDuration: '1.4s',
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationDelay: '-0.2s',
        }}
      />
      <span
        className={cn('h-1 w-1 rounded-full', dotClass)}
        style={{
          animationName: 'think-dot-pulse',
          animationDuration: '1.4s',
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationDelay: '-0.1s',
        }}
      />
      <span
        className={cn('h-1 w-1 rounded-full', dotClass)}
        style={{
          animationName: 'think-dot-pulse',
          animationDuration: '1.4s',
          animationTimingFunction: 'ease-in-out',
          animationIterationCount: 'infinite',
          animationDelay: '0s',
        }}
      />
    </div>
  );
}
