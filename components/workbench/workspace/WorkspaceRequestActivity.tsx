'use client';

/**
 * The request preview — the visual center of the workspace while a request has
 * no classroom yet.
 *
 * It is the classic generation preview, placed in the workspace: one quiet
 * card with a visualizer, a title and one line of description, from a small
 * palette of scenes (`request-schedule.ts`) that the stream's actions map onto.
 * No reasoning text, no tool lists: what the agent says stays in the
 * conversation.
 *
 * An open question is answered HERE, on one card of its own: what the agent
 * wrote, then the question with the conversation's own form and send path
 * (`lib/workbench/question-host.ts`), while the transcript points across.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { MessageCircleQuestion, Sparkles } from 'lucide-react';
import { useWorkbenchStore, type ChatNode } from '@/lib/workbench/session-store';
import { workbenchSessionTitle } from '@/lib/workbench/session-title';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { WorkbenchTranslator } from '@/lib/i18n/workbench';

/** The app translator: the classic generation copy and the workbench copy both. */
type Translate = (key: string, options?: Record<string, unknown>) => string;
import { requestTrack, type RequestTrack } from '@/lib/workbench/request-activity';
import {
  DEFAULT_REQUEST_SCHEDULE,
  scheduleRequestPreview,
  type RequestPreviewView,
} from '@/lib/workbench/request-schedule';
import { skillTitle, useAgentSkills } from '@/lib/workbench/agent-skills';
import { useQuestionHost } from '@/lib/workbench/question-host';
import {
  ActionsVisualizer,
  AgentGenerationVisualizer,
  ContentVisualizer,
  WebSearchVisualizer,
} from '@/components/generation/step-visualizers';
import { RosterRevealVisualizer } from '@/components/generation/roster-reveal';
import { presentTool } from '../chat/tool-presentation';
import { TextBlock } from '../chat/text-block';
import { QuestionForm } from '../chat/question-form';
import { cn } from '@/lib/utils/cn';
import { closedPreviewRequest } from '@/lib/workbench/preview-tab';
import { sessionScopedKey } from '@/lib/workbench/request-scope';
import { WorkspaceCourseTabs } from './WorkspaceCourseTabs';
import { PaneFoldButton } from './PaneFoldButton';

const TICK_MS = 250;

/** Wall clock for the scheduler, never behind the newest event it has seen. */
function useRequestClock(track: RequestTrack | null): number {
  const [now, setNow] = useState(() => Date.now());
  const active = track !== null;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return Math.max(now, track?.lastTs ?? 0);
}

/** The preview tab's id in the right pane's tab strip. */
export const PREVIEW_TAB_ID = 'request-preview';

/** What the workspace needs to know about the preview tab. */
export interface PreviewTabState {
  /** The conversation this state belongs to; request keys are per conversation. */
  readonly sessionId: string | null;
  /** The tab is open: in the strip, and on screen when it is the active tab. */
  readonly shown: boolean;
  /** The request it is showing. */
  readonly requestKey: string | null;
  /** The request is animating now (not resting): the moment the tab takes focus. */
  readonly live: boolean;
  /** The tab's name in the strip. */
  readonly label: string;
}

export const NO_PREVIEW_TAB: PreviewTabState = {
  sessionId: null,
  shown: false,
  requestKey: null,
  live: false,
  label: '',
};

/** The right pane's tab strip, as the workspace hands it to the preview tab. */
export interface PreviewTabStrip {
  readonly tabs: readonly { readonly id: string; readonly name: string }[];
  readonly onActivate: (id: string) => void;
  /** Close a course tab (the preview's own close is `onClose`). */
  readonly onCloseCourse: (id: string) => void;
}

/**
 * The placeholder for the course this conversation may produce — the role the
 * classic generation preview plays — as a regular tab in the right pane's tab
 * strip, beside any course tabs. The first tool call or question of a request
 * opens it; it never folds on its own: between requests it rests, and the next
 * request animates in the same tab. It goes when the conversation's first scene
 * hands off to its course tab (which takes its place), or when the user closes
 * it — remembered for that request (`lib/workbench/preview-tab.ts`).
 */
export function WorkspaceRequestActivity({
  onStateChange,
  hidden = false,
  onCollapse,
  closedKey,
  onClose,
  strip,
}: {
  readonly onStateChange?: (state: PreviewTabState) => void;
  /** Not the active tab, or the pane is folded: hidden, not unmounted, so its clock keeps going. */
  readonly hidden?: boolean;
  readonly onCollapse?: () => void;
  /** The request the user closed the tab for in this visit (the workspace owns it). */
  readonly closedKey: string | null;
  readonly onClose: (requestKey: string) => void;
  /** The other tabs in the strip (course tabs), so the strip is one strip. */
  readonly strip?: PreviewTabStrip;
}) {
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const chat = useWorkbenchStore((s) => s.chat);
  const status = useWorkbenchStore((s) => s.status);
  const replaying = useWorkbenchStore((s) => s.replaying);
  const sessionPrompt = useWorkbenchStore((s) => s.sessionPrompt);
  const { t: i18nT } = useI18n();
  const t = i18nT as Translate;
  const track = useMemo(
    () => requestTrack(chat, status, replaying, sessionPrompt),
    [chat, status, replaying, sessionPrompt],
  );
  const now = useRequestClock(track);
  // When this viewer first had the cast in hand: a page opened or reloaded
  // after set_roster still gets the reveal (see `RequestViewerMemory`).
  // Keyed with the conversation: request keys repeat across conversations.
  const rosterKey = track ? sessionScopedKey(sessionId, track.key) : null;
  const [rosterSeen, setRosterSeen] = useState<{ key: string; at: number } | null>(null);
  const rosterSeenAt = rosterKey !== null && rosterSeen?.key === rosterKey ? rosterSeen.at : null;
  const view = track
    ? scheduleRequestPreview(track, now, DEFAULT_REQUEST_SCHEDULE, { rosterSeenAt })
    : null;
  // Only a viewer looking at the preview has seen the cast: one on a course
  // tab, or with the pane folded, gets the reveal when the preview comes back.
  if (rosterKey !== null && view?.roster && rosterSeenAt === null && !hidden) {
    setRosterSeen({ key: rosterKey, at: now });
  }
  // Has any request of this conversation done something (a tool call, a
  // question)? Then the conversation has a placeholder to keep.
  const conversationActive = chat.some(
    (node) => (node.kind === 'tool' && !!node.toolName) || node.kind === 'question',
  );
  // `quiet` is a request with no tool call or question yet; `collapsed` one that did and ended.
  const requestActive = view !== null && view.mode !== 'quiet';
  const closedFor = closedKey ?? closedPreviewRequest(sessionId);
  const shown =
    track !== null &&
    view !== null &&
    closedFor !== track.key &&
    // Closed for an earlier request: only this request's own activity reopens it.
    (closedFor !== null ? requestActive : conversationActive || requestActive);
  const live = shown && view?.mode === 'scene';
  // The conversation's name, as the rail and the chat header show it: its
  // generated title, else its first request — never a later follow-up.
  const sessionTitle = useWorkbenchStore((s) => s.sessionTitle);
  const firstRequest = chat.find((node) => node.kind === 'user')?.text ?? null;
  const label =
    workbenchSessionTitle({ title: sessionTitle, prompt: sessionPrompt ?? firstRequest }) ??
    t('workbench.preview.eyebrow');
  const requestKey = track?.key ?? null;

  useEffect(() => {
    onStateChange?.({ sessionId, shown, requestKey, live, label });
  }, [onStateChange, sessionId, shown, requestKey, live, label]);
  useEffect(() => () => onStateChange?.(NO_PREVIEW_TAB), [onStateChange]);

  if (!track || !view || !shown) return null;
  return (
    // The classic visualizers loop with motion; this honours reduced motion for all of them.
    <MotionConfig reducedMotion="user">
      <RequestPreview
        view={view}
        prompt={track.prompt}
        hidden={hidden}
        revealKey={rosterSeenAt ?? 'unseen'}
        onClose={() => onClose(track.key)}
        onCollapse={onCollapse}
        strip={strip}
        label={label}
        t={t}
      />
    </MotionConfig>
  );
}

/**
 * Which open question the preview hosts as its form. Decided here rather than
 * inside an animated child, so the conversation hands its form over the moment
 * the question is on screen.
 */
function useHostedQuestion(
  view: RequestPreviewView,
  /** The preview is not on screen (another tab, folded): the chat keeps the question. */
  hidden: boolean,
): {
  readonly node: ChatNode | null;
  readonly handBack: () => void;
} {
  const answer = useQuestionHost((s) => s.answer);
  const setPreviewKey = useQuestionHost((s) => s.setPreviewKey);
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const [handedBack, setHandedBack] = useState<string | null>(null);
  const node = view.question?.node ?? null;
  // Question keys repeat across conversations: both memories carry the conversation.
  const nodeKey = node ? sessionScopedKey(sessionId, node.key) : null;
  const hosted = node && !hidden && answer !== null && handedBack !== nodeKey ? node : null;
  const hostedKey = hosted ? nodeKey : null;
  useEffect(() => {
    if (!hostedKey) return;
    setPreviewKey(hostedKey);
    return () => {
      if (useQuestionHost.getState().previewKey === hostedKey) setPreviewKey(null);
    };
  }, [hostedKey, setPreviewKey]);
  return { node: hosted, handBack: () => nodeKey && setHandedBack(nodeKey) };
}

/** The scene's visual key, title and description. */
function sceneCopy(
  view: RequestPreviewView,
  t: Translate,
): { readonly key: string; readonly title: string; readonly description: string } {
  if (view.mode === 'classroom') {
    return { key: 'opening', title: t('workbench.preview.opening'), description: '' };
  }
  if (view.mode === 'quiet' || view.mode === 'collapsed') {
    // Between requests: the placeholder at rest.
    return {
      key: 'resting',
      title: t('workbench.preview.resting'),
      description: t('workbench.preview.restingDesc'),
    };
  }
  switch (view.scene) {
    case 'researching':
      return {
        key: 'researching',
        title: t('generation.webSearching'),
        description: t('generation.webSearchingDesc'),
      };
    case 'asking':
      return {
        key: 'asking',
        title: t('workbench.preview.asking'),
        description: t('workbench.preview.askingDesc'),
      };
    case 'assembling':
      return {
        key: 'assembling',
        title: t('workbench.preview.assembling'),
        description: t('workbench.preview.assemblingDesc'),
      };
    case 'generating':
      return view.speaking
        ? {
            key: 'speaking',
            title: t('generation.generatingActions'),
            description: t('generation.generatingActionsDesc'),
          }
        : {
            key: 'generating',
            title: t('generation.generatingSlideContent'),
            description: t('generation.generatingSlideContentDesc'),
          };
    default:
      return {
        key: 'understanding',
        title: t('workbench.preview.understanding'),
        description: t('workbench.preview.understandingDesc'),
      };
  }
}

const EASE: [number, number, number, number] = [0.22, 0.61, 0.36, 1];

function RequestPreview({
  view,
  prompt,
  hidden,
  revealKey,
  onClose,
  onCollapse,
  strip,
  label,
  t,
}: {
  readonly view: RequestPreviewView;
  readonly prompt: string;
  readonly hidden: boolean;
  /**
   * When this viewer first saw the cast. A reveal that played while the
   * preview was hidden restarts from face down once it is seen.
   */
  readonly revealKey: number | 'unseen';
  readonly onClose: () => void;
  readonly onCollapse?: () => void;
  readonly strip?: PreviewTabStrip;
  readonly label: string;
  readonly t: Translate;
}) {
  const reduced = useReducedMotion();
  const hosted = useHostedQuestion(view, hidden);
  const copy = sceneCopy(view, t);
  const asking = view.scene === 'asking' && view.question !== null && view.mode === 'scene';
  // The cast's reveal owns the scene area while it plays, like the classic modal.
  const revealing = view.scene === 'assembling' && view.roster !== null && view.mode === 'scene';

  return (
    <section
      data-testid="workspace-request-activity"
      data-scene={copy.key}
      data-preview-mode={view.mode}
      data-preview-awaiting={asking ? 'true' : undefined}
      aria-hidden={hidden || undefined}
      className={cn(
        'ws-pane ws-pane-last h-full min-w-0 flex-1 flex-col',
        hidden ? 'hidden' : 'flex',
      )}
    >
      {/* The course pane's header, with the one preview tab in its strip. */}
      <header className="ws-pane-head ws-classroom-head flex shrink-0 items-center px-2">
        {onCollapse ? (
          <span className="mr-1 flex shrink-0 items-center">
            <PaneFoldButton
              testId="workspace-preview-fold"
              label={t('workspace.collapseClassroom')}
              direction="right"
              onClick={onCollapse}
            />
          </span>
        ) : null}
        <WorkspaceCourseTabs
          tabs={[...(strip?.tabs ?? []), { id: PREVIEW_TAB_ID, name: label }]}
          activeCourseId={PREVIEW_TAB_ID}
          onActivate={(id) => (id === PREVIEW_TAB_ID ? undefined : strip?.onActivate(id))}
          onClose={(id) => (id === PREVIEW_TAB_ID ? onClose() : strip?.onCloseCourse(id))}
        />
        <span className="ws-ctabs-rule" aria-hidden="true" />
        {/* "In progress" only while something is: at rest the tab says nothing. */}
        {copy.key === 'resting' ? null : (
          <span className="ws-pane-eyebrow shrink-0 pr-1">{t('workbench.preview.eyebrow')}</span>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-8 text-center">
        {/* The classic page's background: two slow, blurred washes. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div
            className="absolute left-1/4 top-0 size-96 animate-pulse rounded-full bg-blue-500/10 blur-3xl motion-reduce:animate-none"
            style={{ animationDuration: '4s' }}
          />
          <div
            className="absolute bottom-0 right-1/4 size-96 animate-pulse rounded-full bg-purple-500/10 blur-3xl motion-reduce:animate-none"
            style={{ animationDuration: '6s' }}
          />
        </div>

        <div
          className={cn(
            'z-10 my-auto flex w-full flex-col items-center gap-6 transition-[max-width] duration-500',
            asking ? 'max-w-2xl' : revealing ? 'max-w-4xl' : 'max-w-lg',
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={
                asking && view.question
                  ? `question-${view.question.node.key}`
                  : revealing
                    ? 'roster'
                    : 'scene'
              }
              className="w-full"
              initial={reduced ? false : { opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: reduced ? 0 : 0.35, ease: EASE }}
            >
              {asking && view.question ? (
                <QuestionCard
                  title={copy.title}
                  description={copy.description}
                  agentText={view.question.planText}
                  question={view.question.node}
                  hosted={hosted.node}
                  onHandBack={hosted.handBack}
                  skills={view.skills}
                  t={t}
                />
              ) : revealing && view.roster ? (
                <div
                  data-testid="request-preview-card"
                  className={cn(CARD, 'items-center px-6 pb-7 pt-5 text-center md:px-8')}
                >
                  <EquippedSkills skills={view.skills} t={t} className="mb-4" />
                  <RosterRevealVisualizer key={revealKey} agents={view.roster} />
                </div>
              ) : (
                <SceneCard view={view} copy={copy} prompt={prompt} t={t} />
              )}
            </motion.div>
          </AnimatePresence>

          <div
            className={cn(
              'flex h-10 items-center justify-center gap-3 text-sm font-medium uppercase tracking-widest text-[var(--ws-ink-faint)] transition-opacity duration-300',
              asking || copy.key === 'resting' ? 'opacity-0' : 'opacity-100',
            )}
            aria-hidden={asking || copy.key === 'resting' || undefined}
          >
            <Sparkles
              className="size-3 animate-pulse motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t('generation.aiWorking')}
          </div>
        </div>
      </div>
    </section>
  );
}

const CARD =
  'relative flex w-full flex-col overflow-hidden rounded-xl border border-[var(--ws-line-soft)] bg-white/80 shadow-2xl backdrop-blur-xl dark:bg-slate-900/80';

/** The classic preview's card: a visualizer, a title, one line. */
function SceneCard({
  view,
  copy,
  prompt,
  t,
}: {
  readonly view: RequestPreviewView;
  readonly copy: ReturnType<typeof sceneCopy>;
  readonly prompt: string;
  readonly t: Translate;
}) {
  const reduced = useReducedMotion();
  const caption =
    view.scene === 'generating' && view.page && view.mode === 'scene'
      ? pageCaption(view.page.order, view.page.step.node, t)
      : null;
  return (
    <div
      data-testid="request-preview-card"
      className={cn(
        CARD,
        'min-h-[452px] items-center justify-center px-8 pb-8 pt-5 text-center md:px-10',
      )}
    >
      {/* The skills row has its own reserved line at the top of the card, in the
          flow: no visual can be drawn over it, and a skill arriving never moves
          the scene. */}
      <div className="flex min-h-7 w-full items-start justify-center">
        <EquippedSkills skills={view.skills} t={t} />
      </div>
      <div className="flex w-full flex-1 flex-col items-center justify-center space-y-6">
        <div className="relative mt-4 flex h-64 w-full items-center justify-center">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={copy.key}
              initial={reduced ? false : { scale: 0.8, opacity: 0, filter: 'blur(10px)' }}
              animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
              exit={reduced ? { opacity: 0 } : { scale: 1.2, opacity: 0, filter: 'blur(10px)' }}
              transition={{ duration: reduced ? 0 : 0.5 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <SceneVisual sceneKey={copy.key} view={view} prompt={prompt} t={t} />
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mx-auto w-full max-w-sm space-y-3">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={copy.key}
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
              transition={{ duration: reduced ? 0 : 0.3 }}
              className="space-y-2"
            >
              <h2
                data-testid="request-preview-title"
                className="text-2xl font-bold tracking-tight text-[var(--ws-ink)]"
              >
                {copy.title}
              </h2>
              {copy.description ? (
                <p className="text-base text-[var(--ws-ink-mute)]">{copy.description}</p>
              ) : null}
            </motion.div>
          </AnimatePresence>
          {/* Reserved, so a caption arriving never moves the card. */}
          <p
            data-testid="request-preview-caption"
            className="h-4 truncate text-xs text-[var(--ws-ink-faint)]"
            title={caption ?? undefined}
          >
            <AnimatePresence mode="wait" initial={false}>
              {caption ? (
                <motion.span
                  key={caption}
                  className="inline-block max-w-full truncate"
                  initial={reduced ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduced ? 0 : 0.3 }}
                >
                  {caption}
                </motion.span>
              ) : null}
            </AnimatePresence>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The agent waits on the user: one card. What the agent wrote, as a document
 * with its own scroll; then the question, its options and its actions, in the
 * conversation's own form.
 */
function QuestionCard({
  title,
  description,
  agentText,
  question,
  hosted,
  onHandBack,
  skills,
  t,
}: {
  readonly skills: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly agentText: string | null;
  readonly question: ChatNode;
  readonly hosted: ChatNode | null;
  readonly onHandBack: () => void;
  readonly t: Translate;
}) {
  const answer = useQuestionHost((s) => s.answer);
  return (
    <div data-testid="request-preview-question" className={cn(CARD, 'text-left')}>
      {/* The same centered composition as the scene card: skills, mark, title, line. */}
      <div className="flex flex-col items-center px-8 pb-5 pt-5 text-center">
        <EquippedSkills skills={skills} t={t} className="mb-4" />
        <span className="flex size-12 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-500 ring-1 ring-violet-400/20">
          <MessageCircleQuestion className="size-6" aria-hidden="true" />
        </span>
        <h2
          data-testid="request-preview-title"
          className="mt-3 text-xl font-bold tracking-tight text-[var(--ws-ink)]"
        >
          {title}
        </h2>
        <p className="mt-1 text-sm text-[var(--ws-ink-mute)]">{description}</p>
      </div>
      {agentText ? <AgentDocument text={agentText} /> : null}
      <div className="wbchat border-t border-[var(--ws-line-soft)] px-8 pb-6 pt-5">
        {hosted && answer ? (
          <QuestionForm
            key={hosted.key}
            node={hosted}
            onAnswer={answer}
            onDismiss={onHandBack}
            embedded
            t={t as WorkbenchTranslator}
          />
        ) : (
          <TextBlock text={question.text} />
        )}
      </div>
    </div>
  );
}

/** What the agent wrote before asking, as a readable document with its own scroll. */
function AgentDocument({ text }: { readonly text: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
  }, []);
  useEffect(() => {
    measure();
  }, [measure, text]);
  return (
    <div className="border-t border-[var(--ws-line-soft)]">
      <div
        ref={scrollRef}
        data-testid="request-preview-plan"
        onScroll={measure}
        className="wbchat max-h-[min(30vh,320px)] overflow-y-auto px-8 py-5 text-[13px]"
        // A soft fade says there is more below; it lifts at the end.
        style={
          atEnd
            ? undefined
            : {
                maskImage: 'linear-gradient(to bottom, #000 calc(100% - 48px), transparent)',
                WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 48px), transparent)',
              }
        }
      >
        <TextBlock text={text} />
      </div>
    </div>
  );
}

/**
 * The skills the agent equipped for this request, as a quiet row of badges
 * that stays for the rest of the request. Each badge settles in with one soft
 * shine; a skill load is never a scene of its own.
 */
function EquippedSkills({
  skills,
  t,
  className,
}: {
  readonly skills: readonly string[];
  readonly t: Translate;
  readonly className?: string;
}) {
  const { skills: registry } = useAgentSkills();
  const reduced = useReducedMotion();
  if (skills.length === 0) return null;
  const visible = skills.slice(-4);
  const more = skills.length - visible.length;
  return (
    <ul
      data-testid="request-preview-skills"
      aria-label={t('workbench.preview.skills')}
      className={cn('flex flex-wrap items-center justify-center gap-1.5', className)}
    >
      {visible.map((id) => {
        // The registry is a network read; anything but a list reads as empty.
        const known = (Array.isArray(registry) ? registry : []).find(
          (skill) => skill.id === id || skill.name === id,
        );
        const title = skillTitle(known ?? { name: id }, t as WorkbenchTranslator) ?? id;
        return (
          <motion.li
            key={id}
            layout={!reduced}
            data-skill={id}
            title={`/${id}`}
            initial={reduced ? false : { opacity: 0, y: -4, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: reduced ? 0 : 0.45, ease: EASE }}
            className="relative inline-flex max-w-[12rem] items-center gap-1 overflow-hidden rounded-full border border-violet-200/70 bg-white/70 px-2.5 py-0.5 text-[11px] font-medium text-violet-700 shadow-sm dark:border-violet-400/25 dark:bg-violet-500/10 dark:text-violet-200"
          >
            <Sparkles className="size-3 shrink-0 text-violet-500" aria-hidden="true" />
            <span className="truncate">{title}</span>
            {reduced ? null : (
              <motion.span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/80 to-transparent dark:via-white/20"
                initial={{ x: '-120%' }}
                animate={{ x: '320%' }}
                transition={{ duration: 1.1, delay: 0.3, ease: 'easeOut' }}
              />
            )}
          </motion.li>
        );
      })}
      {more > 0 ? (
        <li className="text-[11px] font-medium text-[var(--ws-ink-faint)]">+{more}</li>
      ) : null}
    </ul>
  );
}

function pageCaption(order: number, node: ChatNode, t: Translate): string {
  const title = presentTool(node, [], t as WorkbenchTranslator).subject;
  return title
    ? t('workbench.preview.pageCaption', { order, title })
    : t('workbench.preview.page', { order });
}

function SceneVisual({
  sceneKey,
  view,
  prompt,
  t,
}: {
  readonly sceneKey: string;
  readonly view: RequestPreviewView;
  readonly prompt: string;
  readonly t: Translate;
}) {
  switch (sceneKey) {
    case 'researching':
      return (
        <WebSearchVisualizer
          scrollable
          sources={view.searches.map((step) => {
            const presentation = presentTool(step.node, [], t as WorkbenchTranslator);
            return { title: presentation.subject ?? presentation.label, url: presentation.label };
          })}
        />
      );
    case 'assembling':
      // The classic "?" cards until the roster exists; the reveal then owns the card.
      return <AgentGenerationVisualizer />;
    case 'speaking':
      return <ActionsVisualizer />;
    case 'resting':
      return <RestingVisual />;
    case 'generating':
    case 'opening':
      return <ContentVisualizer />;
    default:
      return <UnderstandingVisual prompt={prompt} />;
  }
}

/**
 * Understanding the request, in the classic visualizers' vocabulary: the
 * request itself on a small card, read by a soft passing beam.
 */
function UnderstandingVisual({ prompt }: { readonly prompt: string }) {
  const text = prompt.replace(/\s+/g, ' ').trim();
  return (
    <div className="relative flex size-48 items-center justify-center">
      <motion.div
        className="absolute inset-4 rounded-full bg-violet-500/10 blur-2xl"
        animate={{ scale: [1, 1.1, 1], opacity: [0.35, 0.6, 0.35] }}
        transition={{ duration: 3.2, repeat: Infinity }}
      />
      <div className="relative w-44 overflow-hidden rounded-xl border border-slate-200 bg-white p-3 text-left shadow-xl dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-2 flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-violet-500" />
          <span className="h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700" />
        </div>
        <p className="line-clamp-4 text-[11px] leading-relaxed text-slate-700 dark:text-slate-200">
          {text}
        </p>
        <div className="mt-2 space-y-1.5">
          {[85, 65].map((width) => (
            <div
              key={width}
              className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-700"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
        <motion.div
          className="pointer-events-none absolute inset-y-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-violet-400/15 to-transparent"
          initial={{ left: '-60%' }}
          animate={{ left: '130%' }}
          transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 1, ease: 'linear' }}
        />
      </div>
    </div>
  );
}

/**
 * The placeholder at rest, between requests: an empty slide, still. Nothing
 * moves and nothing claims work is under way.
 */
function RestingVisual() {
  return (
    <div
      data-testid="request-preview-resting"
      className="flex h-28 w-44 flex-col gap-2 rounded-xl border border-dashed border-slate-300 bg-white/60 p-4 dark:border-slate-600 dark:bg-slate-800/40"
      aria-hidden="true"
    >
      <span className="h-2 w-16 rounded-full bg-slate-200 dark:bg-slate-700" />
      <span className="mt-2 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-700/70" />
      <span className="h-1.5 w-4/5 rounded-full bg-slate-100 dark:bg-slate-700/70" />
      <span className="h-1.5 w-3/5 rounded-full bg-slate-100 dark:bg-slate-700/70" />
    </div>
  );
}
