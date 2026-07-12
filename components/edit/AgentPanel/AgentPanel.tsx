'use client';

/**
 * MAIC Agent — editor AI sidebar (right rail), "Edit with AI" Cursor-style
 * surface per the OpenMAIC AgentSidebar design board:
 * - user messages are right-aligned solid-violet bubbles (radius 14/14/4/14);
 * - assistant output is full-width markdown with design-language tool cards in
 *   chronological order;
 * - the composer is a bordered shell with a violet focus glow, an @-context
 *   chip for the active scene, horizontally-scrolling quick-prompt chips, and a
 *   square violet send button.
 * Only design aspects with real V0 backing are implemented — the model picker,
 * Agent/Ask mode, checkpoints/Restore, reasoning blocks and per-element @-chips
 * from the board are intentionally omitted (no runtime support yet).
 * Wiring (ExternalStore over the pi AgentEvent SSE stream) lives in
 * use-agent-runtime.
 */
import { useCallback, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useComposerRuntime,
  useMessage,
  type AssistantRuntime,
} from '@assistant-ui/react';
import {
  ArrowUp,
  AtSign,
  ChevronDown,
  History,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AgentEditSessionRecord } from '@/lib/agent/client/agent-edit-session-types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { SpeechButton } from '@/components/audio/speech-button';
import { MarkdownText } from './markdown-text';
import { ReasoningPart } from './reasoning-part';
import { RegenerateSceneActionsUI } from './regenerate-tool-ui';
import { RegenerateSceneUI } from './regenerate-scene-tool-ui';
import { EditInteractiveHtmlUI } from './edit-interactive-html-tool-ui';
import { ReadSceneContentUI } from './read-tool-ui';

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 384;

/** Capability rows shown in the empty state — read-only tips (not clickable),
 *  each a label + example phrasings. One unified list describing what the agent
 *  can do across scenes (slide content + narration + interactive-page fixing),
 *  shown regardless of the active scene type. */
const CAPABILITY_KEYS = [
  { label: 'edit.agent.cap.content.label', examples: 'edit.agent.cap.content.examples' },
  { label: 'edit.agent.cap.narration.label', examples: 'edit.agent.cap.narration.examples' },
  { label: 'edit.agent.cap.fixHtml.label', examples: 'edit.agent.cap.fixHtml.examples' },
];

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      {/* Solid brand-violet bubble, right-aligned, with a tail toward the user
          (radius 14/14/4/14) — per the design board's .ae-user. */}
      <div className="min-w-0 max-w-[88%] rounded-[14px] rounded-br-[4px] bg-primary px-3.5 py-2 text-[13px] leading-relaxed text-white [overflow-wrap:anywhere]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function ThinkingIndicator() {
  const { t } = useI18n();
  // Cursor-style shimmer label — the bright band sweeps across the word while we
  // wait for the next API call's first streamed token. Reasoning tokens are never
  // rendered raw (think-blocks stripped upstream); thinking surfaces only here.
  return (
    <span className="ai-thinking-shimmer text-[13px] font-medium">{t('edit.agent.thinking')}</span>
  );
}

function AssistantMessage() {
  const { t } = useI18n();
  // Separate primitive selectors — useMessage is backed by useSyncExternalStore
  // (Object.is snapshot compare), so returning a fresh object literal would loop.
  const hasContent = useMessage((m) =>
    m.content.some(
      (p) =>
        (p.type === 'text' && p.text.length > 0) ||
        p.type === 'tool-call' ||
        (p.type === 'reasoning' && p.text.length > 0),
    ),
  );
  // Loading shows only while a NEW API call is pending its first token — not while
  // tokens are streaming. Walk to the last meaningful part: live text → streaming
  // (no loading); a finished tool call (result present) → next turn pending
  // (loading); a still-running tool call → its card already spins (no loading);
  // nothing yet → loading.
  const showLoading = useMessage((m) => {
    if (m.status?.type !== 'running') return false;
    const parts = m.content as Array<{ type: string; text?: string; result?: unknown }>;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === 'text' && typeof p.text === 'string' && p.text.length > 0) return false;
      if (p.type === 'tool-call') return p.result !== undefined;
      // A reasoning part shows its own live "thinking…" label (with duration),
      // so the separate shimmer indicator is redundant while reasoning streams.
      if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.length > 0) return false;
    }
    return true;
  });
  const stopped = useMessage((m) => m.status?.type !== 'running');

  return (
    <MessagePrimitive.Root className="min-w-0 space-y-2">
      {hasContent ? (
        <div className="min-w-0 space-y-2 text-[13px] leading-[1.6] text-foreground/90">
          <MessagePrimitive.Parts components={{ Text: MarkdownText, Reasoning: ReasoningPart }} />
        </div>
      ) : null}
      {showLoading ? (
        <ThinkingIndicator />
      ) : stopped && !hasContent ? (
        <span className="text-[12px] text-muted-foreground/60">{t('edit.agent.stopped')}</span>
      ) : null}
    </MessagePrimitive.Root>
  );
}

/** Mic button that dictates into the composer. Lives inside ComposerPrimitive.Root
 *  so it can append the transcription to the composer text via the composer
 *  runtime. SpeechButton self-gates on ASR availability (disabled when off). */
function VoiceInputButton({ disabled }: { readonly disabled?: boolean }) {
  const composer = useComposerRuntime();
  return (
    <SpeechButton
      size="md"
      className="size-[30px]"
      disabled={disabled}
      onTranscription={(text) => {
        if (!text) return;
        const cur = composer.getState().text ?? '';
        const sep = cur && !cur.endsWith(' ') ? ' ' : '';
        composer.setText(cur + sep + text);
      }}
    />
  );
}

interface AgentPanelProps {
  readonly scene?: { id: string; title: string; type?: string };
  readonly runtime: AssistantRuntime;
  readonly clearThread: () => void;
  readonly hasMessages: boolean;
  readonly canSend: boolean;
  readonly sessions: AgentEditSessionRecord[];
  readonly activeSessionId: string | undefined;
  readonly switchSession: (id: string) => Promise<void>;
  readonly deleteSessionAndRefresh: (id: string) => Promise<void>;
  readonly refreshSessions: () => Promise<void>;
  /**
   * When true, renders only the thread body (no aside wrapper, no header, no
   * resize handle, no collapse state). Used when an outer container (e.g.
   * RightRailTabs) owns the rail chrome.
   */
  readonly naked?: boolean;
}

export function AgentPanel({
  scene,
  runtime,
  clearThread,
  hasMessages,
  canSend,
  sessions,
  activeSessionId,
  switchSession,
  deleteSessionAndRefresh,
  refreshSessions,
  naked,
}: AgentPanelProps) {
  const { t } = useI18n();

  // Interactive scenes expose a different agent capability (fix the page's bugs)
  // than slides (regenerate content/narration), so the empty-state copy and the
  // composer placeholder switch by scene type.
  // Empty-state copy is unified (no slide/interactive split) — the capability
  // list above already covers fixing interactive pages. The composer placeholder
  // still adapts to the active scene type.
  const isInteractive = scene?.type === 'interactive';
  const capabilityKeys = CAPABILITY_KEYS;
  const emptyTitleKey = 'edit.agent.emptyTitle';
  const emptyLeadKey = 'edit.agent.empty.lead';
  const emptyBoundaryKey = 'edit.agent.empty.boundary';
  const placeholderKey = isInteractive
    ? 'edit.agent.interactive.placeholder'
    : 'edit.agent.placeholder';
  const sceneTypeLabel =
    scene?.type && ['slide', 'quiz', 'interactive', 'pbl'].includes(scene.type)
      ? t(`edit.sceneType.${scene.type}`)
      : (scene?.type ?? 'Scene');
  const unsupportedMessage = t('edit.unsupportedScene', { type: sceneTypeLabel });

  // Drag-to-resize from the left edge (pointer capture, direct DOM write).
  const railRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragRef = useRef<{
    startX: number;
    startW: number;
    lastW: number;
    pointerId: number;
  } | null>(null);

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startW = railRef.current?.getBoundingClientRect().width ?? width;
      dragRef.current = { startX: e.clientX, startW, lastW: startW, pointerId: e.pointerId };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best effort */
      }
      document.body.style.cursor = 'col-resize';
    },
    [width],
  );
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, d.startW + (d.startX - e.clientX)));
    d.lastW = next;
    if (railRef.current) railRef.current.style.width = `${next}px`;
  }, []);
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
    setWidth(d.lastW);
    dragRef.current = null;
    document.body.style.cursor = '';
  }, []);

  const [collapsed, setCollapsed] = useState(false);

  // Naked mode: outer container (RightRailTabs) owns the aside wrapper and chrome.
  // Render only the thread body, no aside / header / resize / collapse state.
  if (naked) {
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ReadSceneContentUI />
        <RegenerateSceneActionsUI />
        <RegenerateSceneUI />
        <EditInteractiveHtmlUI />

        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 space-y-6 overflow-y-auto px-4 py-5 scroll-smooth">
            <ThreadPrimitive.Empty>
              <div className="mx-auto mt-12 flex max-w-[268px] flex-col">
                <p className="text-center text-sm font-medium text-foreground">
                  {t(emptyTitleKey)}
                </p>
                <p className="mt-1.5 text-center text-[12px] leading-relaxed text-muted-foreground">
                  {t(emptyLeadKey)}
                </p>
                <div className="mt-5 space-y-3">
                  {capabilityKeys.map(({ label, examples }) => (
                    <div key={label} className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-semibold text-foreground">{t(label)}</span>
                      <span className="text-[11.5px] leading-relaxed text-[#5b1fa8]/70 dark:text-violet-300/70">
                        {t(examples)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground/80">
                  {t(emptyBoundaryKey)}
                </p>
                <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                  <Sparkles className="size-3 text-[#5b1fa8]/60 dark:text-violet-300/60" />
                  {t('edit.agent.empty.comingSoon')}
                </p>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>

          <ThreadPrimitive.ScrollToBottom className="absolute bottom-2 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-0">
            <ChevronDown className="size-4" />
          </ThreadPrimitive.ScrollToBottom>

          <div className="px-3 pb-3 pt-1">
            {!canSend ? (
              <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                {unsupportedMessage}
              </p>
            ) : null}
            <ComposerPrimitive.Root className="rounded-[10px] border border-border bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-violet-400 focus-within:ring-[3px] focus-within:ring-violet-500/10 dark:focus-within:ring-violet-500/20">
              {scene?.title ? (
                <div className="px-2 pt-2">
                  <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-[#5b1fa8] dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
                    <AtSign className="size-3 shrink-0 text-violet-500" />
                    <span className="truncate">{scene.title}</span>
                  </span>
                </div>
              ) : null}
              <ComposerPrimitive.Input
                minRows={1}
                maxRows={6}
                autoFocus={canSend}
                disabled={!canSend}
                placeholder={t(placeholderKey)}
                className="block w-full resize-none bg-transparent px-3 pb-1 pt-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex items-center px-2 pb-2 pt-0.5">
                <div className="ml-auto flex items-center gap-1">
                  <VoiceInputButton disabled={!canSend} />
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send
                      disabled={!canSend}
                      className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-primary text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/50"
                    >
                      <ArrowUp className="size-4" />
                    </ComposerPrimitive.Send>
                  </ThreadPrimitive.If>
                  <ThreadPrimitive.If running>
                    <button
                      type="button"
                      aria-label={t('edit.agent.stop')}
                      onClick={() => {
                        try {
                          runtime.thread.cancelRun();
                        } catch {
                          /* no run to cancel */
                        }
                      }}
                      className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-primary text-white transition-colors hover:opacity-90"
                    >
                      <Square className="size-3 fill-current" />
                    </button>
                  </ThreadPrimitive.If>
                </div>
              </div>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    );
  }

  // Collapsed: a slim rail with the brand mark — click anywhere to reopen. The
  // runtime is owned above this panel, so the conversation is preserved.
  if (collapsed) {
    return (
      <aside
        onClick={() => setCollapsed(false)}
        title={t('edit.agent.expand')}
        className="group/rail relative flex h-full w-11 shrink-0 cursor-pointer flex-col items-center gap-3 border-l border-gray-100 bg-white/80 pt-3 backdrop-blur-xl transition-colors hover:bg-violet-50/40 dark:border-gray-800 dark:bg-slate-900/80 dark:hover:bg-violet-500/5 shadow-[-2px_0_24px_rgba(0,0,0,0.02)]"
      >
        <span className="grid size-8 place-items-center rounded-lg text-[#5b1fa8] transition-colors group-hover/rail:bg-violet-100/70 dark:text-violet-300 dark:group-hover/rail:bg-violet-500/15">
          <PanelRightOpen className="size-4" />
        </span>
        <Sparkles className="size-4 text-[#5b1fa8]/80 dark:text-violet-300/80" />
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#5b1fa8]/70 [writing-mode:vertical-rl] dark:text-violet-300/70">
          Edit with AI
        </span>
      </aside>
    );
  }

  return (
    <aside
      ref={railRef}
      style={{ width }}
      // Mirrors SlideNavRail's surface (white/translucent glass, soft hairline,
      // faint side shadow) so the two rails read as one chrome family.
      className="relative flex h-full shrink-0 flex-col border-l border-gray-100 bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-slate-900/80 shadow-[-2px_0_24px_rgba(0,0,0,0.02)]"
    >
      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="group absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-violet-400/30 active:bg-violet-500/50 dark:hover:bg-violet-500/30"
      >
        <div className="absolute left-0.5 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-gray-300 transition-colors group-hover:bg-violet-400 dark:bg-gray-600 dark:group-hover:bg-violet-500" />
      </div>

      {/* Header — "Edit with AI" with a violet sparkles mark (design .ae-head). */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-gray-100 px-4 pl-5 dark:border-gray-800">
        <Sparkles className="size-3.5 text-[#5b1fa8] dark:text-violet-300" />
        <span className="text-[13px] font-semibold text-[#5b1fa8] dark:text-violet-300">
          Edit with AI
        </span>
        <Popover onOpenChange={(open) => open && void refreshSessions()}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={t('edit.agent.sessionHistory')}
              aria-label={t('edit.agent.sessionHistory')}
              className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
            >
              <History className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-1">
            {sessions.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t('edit.agent.sessionEmpty')}
              </p>
            ) : (
              <ul className="max-h-80 overflow-y-auto">
                {sessions.map((s) => (
                  <li key={s.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void switchSession(s.id)}
                      className={cn(
                        'flex-1 truncate rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted',
                        s.id === activeSessionId
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground',
                      )}
                    >
                      {s.title || t('edit.agent.sessionUntitled')}
                    </button>
                    <button
                      type="button"
                      title={t('edit.agent.sessionDelete')}
                      aria-label={t('edit.agent.sessionDelete')}
                      onClick={() => void deleteSessionAndRefresh(s.id)}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
        {hasMessages ? (
          <button
            type="button"
            onClick={clearThread}
            title={t('edit.agent.newConversation')}
            aria-label={t('edit.agent.newConversation')}
            className="grid size-7 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
          >
            <SquarePen className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title={t('edit.agent.collapse')}
          aria-label={t('edit.agent.collapse')}
          className="grid size-7 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose className="size-4" />
        </button>
      </header>

      <AssistantRuntimeProvider runtime={runtime}>
        <ReadSceneContentUI />
        <RegenerateSceneActionsUI />
        <RegenerateSceneUI />
        <EditInteractiveHtmlUI />

        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 space-y-6 overflow-y-auto px-4 py-5 scroll-smooth">
            <ThreadPrimitive.Empty>
              {/* Capability tips — read-only (not clickable). Communicates what
                  the agent can actually do (content + narration + read), with
                  example phrasings, instead of clickable recommendation chips. */}
              <div className="mx-auto mt-12 flex max-w-[268px] flex-col">
                <p className="text-center text-sm font-medium text-foreground">
                  {t(emptyTitleKey)}
                </p>
                <p className="mt-1.5 text-center text-[12px] leading-relaxed text-muted-foreground">
                  {t(emptyLeadKey)}
                </p>

                <div className="mt-5 space-y-3">
                  {capabilityKeys.map(({ label, examples }) => (
                    <div key={label} className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-semibold text-foreground">{t(label)}</span>
                      <span className="text-[11.5px] leading-relaxed text-[#5b1fa8]/70 dark:text-violet-300/70">
                        {t(examples)}
                      </span>
                    </div>
                  ))}
                </div>

                <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground/80">
                  {t(emptyBoundaryKey)}
                </p>
                <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                  <Sparkles className="size-3 text-[#5b1fa8]/60 dark:text-violet-300/60" />
                  {t('edit.agent.empty.comingSoon')}
                </p>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>

          <ThreadPrimitive.ScrollToBottom className="absolute bottom-2 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-0">
            <ChevronDown className="size-4" />
          </ThreadPrimitive.ScrollToBottom>

          {/* Composer (design .ae-composer): a bordered input shell with an
              @-scene context chip, a voice-input mic, and a square violet send. */}
          <div className="px-3 pb-3 pt-1">
            {!canSend ? (
              <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                {unsupportedMessage}
              </p>
            ) : null}
            <ComposerPrimitive.Root className="rounded-[10px] border border-border bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-violet-400 focus-within:ring-[3px] focus-within:ring-violet-500/10 dark:focus-within:ring-violet-500/20">
              {scene?.title ? (
                <div className="px-2 pt-2">
                  <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-[#5b1fa8] dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
                    <AtSign className="size-3 shrink-0 text-violet-500" />
                    <span className="truncate">{scene.title}</span>
                  </span>
                </div>
              ) : null}

              {/* minRows/maxRows are react-textarea-autosize's real knobs (its
                  height measurement breaks when fighting `rows`/max-h classes). */}
              <ComposerPrimitive.Input
                minRows={1}
                maxRows={6}
                autoFocus={canSend}
                disabled={!canSend}
                placeholder={t(placeholderKey)}
                className="block w-full resize-none bg-transparent px-3 pb-1 pt-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-60"
              />

              <div className="flex items-center px-2 pb-2 pt-0.5">
                {/* Voice + send cluster on the right; the mic sits immediately
                    left of the send/stop button. Voice self-gates on ASR. */}
                <div className="ml-auto flex items-center gap-1">
                  <VoiceInputButton disabled={!canSend} />
                  {/* Send while idle; Stop while a response streams. Stop calls the
                      thread runtime's cancelRun → our onCancel aborts the fetch. */}
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send
                      disabled={!canSend}
                      className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-primary text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/50"
                    >
                      <ArrowUp className="size-4" />
                    </ComposerPrimitive.Send>
                  </ThreadPrimitive.If>
                  <ThreadPrimitive.If running>
                    <button
                      type="button"
                      aria-label={t('edit.agent.stop')}
                      onClick={() => {
                        try {
                          runtime.thread.cancelRun();
                        } catch {
                          /* no run to cancel */
                        }
                      }}
                      className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-primary text-white transition-colors hover:opacity-90"
                    >
                      <Square className="size-3 fill-current" />
                    </button>
                  </ThreadPrimitive.If>
                </div>
              </div>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </aside>
  );
}
