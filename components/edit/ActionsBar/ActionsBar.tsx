'use client';

/**
 * ActionsBar — Pro-mode "讲解脚本" bottom bar, a horizontal film-editing timeline
 * that is also a light editor for the scene's playback `actions`.
 *
 * The scene's `actions` ARE the timeline: walked left→right, each `speech`
 * becomes an editable clip block (one spoken line, numbered) and every non-speech
 * cue (spotlight / laser / board) becomes a compact card pinned at its place in
 * the flow. Hovering a cue replays the REAL playback effect on its bound element
 * (setLaser → LaserPointerOverlay, setSpotlight → SpotlightOverlay).
 *
 * Editing (persisted via useStageStore.updateScene → actions-edit ops):
 * - speech clip text is editable inline (commit on blur);
 * - palette chips drag into the track to add an action at a drop slot;
 * - existing items drag to reorder; each card carries a delete button;
 * - clicking an element-bound cue arms canvas pick mode (useCanvasStore.pickTarget),
 *   so the target is chosen by clicking the element directly on the slide.
 *
 * Collapsible; height-resizable from the top edge; reactive to the stage store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Flag,
  FoldVertical,
  GripVertical,
  Play,
  RefreshCw,
  Trash2,
  UnfoldVertical,
  Volume2,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Action, DiscussionAction } from '@/lib/types/action';
import { ELEMENT_BOUND, cueLabel, cueMeta } from './cue-meta';
import { applyCuePreview, clearCuePreview, cuePreviewFor } from './cue-preview';
import {
  appendDiscussion,
  clampInsertSlot,
  hasDiscussion,
  insertAt,
  makeAction,
  moveById,
  moveByIdDir,
  removeById,
  setAudioIdById,
  setDiscussionAgentById,
  setDiscussionPromptById,
  setDiscussionTopicById,
  setSpeechTextClearAudioById,
  type AddableType,
} from './actions-edit';
import {
  audioExists,
  audioObjectUrl,
  discardSpeechAudio,
  regenerateSpeechAudio,
  resolveSpeechAudioId,
  speechAudioId,
} from '@/lib/audio/regenerate-speech-tts';

const EMPTY: Action[] = [];
const MIN_H = 168;
const MAX_H = 520;
const DEFAULT_H = 224;
const LINE_H = 86; // height when collapsed to just the axis line of node icons (fits the chips)
const AXIS_FROM_TOP = 20; // px from track top to the axis center (nodes hang below it)

/**
 * Add-palette types — only the ones that stand alone. Whiteboard cues need an
 * open→draw→close workflow, so they aren't bare-addable (the agent still emits
 * them and they render in the timeline). Cue icon/label/tint live in cue-meta.
 */
const PALETTE: AddableType[] = ['speech', 'spotlight', 'laser'];

// Radix Select forbids an empty-string item value, so the discussion's
// "unspecified agent" choice rides a sentinel that maps back to '' on change.
const DISCUSSION_AGENT_NONE = '__none__';

type DragPayload = { kind: 'new'; type: AddableType } | { kind: 'move'; id: string };

interface TooltipState {
  action: Action;
  anchor: DOMRect;
}

type TFn = (key: string, options?: Record<string, unknown>) => string;

function propsOf(a: Action, t: TFn): Array<[string, string]> {
  const rows: Array<[string, string]> = [[t('edit.timeline.fieldAction'), cueLabel(a.type, t)]];
  const el = (a as { elementId?: string }).elementId;
  if (el) rows.push([t('edit.timeline.fieldElement'), el]);
  const content = (a as { content?: string }).content;
  if (content)
    rows.push([
      t('edit.timeline.fieldContent'),
      content.length > 48 ? `${content.slice(0, 48)}…` : content,
    ]);
  return rows;
}

function CueTooltip({ tip }: { tip: TooltipState }) {
  const { t } = useI18n();
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: Math.max(8, tip.anchor.left + tip.anchor.width / 2),
        top: tip.anchor.top - 8,
        transform: 'translate(-50%, -100%)',
        maxWidth: 280,
        zIndex: 60,
      }}
      className="pointer-events-none rounded-lg border border-border/80 bg-popover px-2.5 py-1.5 text-popover-foreground shadow-lg shadow-black/5"
    >
      {propsOf(tip.action, t).map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[11px] leading-relaxed">
          <span className="shrink-0 text-muted-foreground">{k}</span>
          <span className="font-mono [overflow-wrap:anywhere]">{v}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// Native HTML5 drag snapshots the element's square bounding box, so a round
// icon chip drags with white corners ("白边"). Suppress the ghost with a 1×1
// transparent image — the violet drop indicator carries the feedback instead.
let blankDragImg: HTMLImageElement | null = null;
function setBlankDragImage(e: React.DragEvent) {
  if (typeof document === 'undefined') return;
  if (!blankDragImg) {
    blankDragImg = new Image();
    blankDragImg.src =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  }
  try {
    e.dataTransfer.setDragImage(blankDragImg, 0, 0);
  } catch {
    /* not supported — fall back to the default ghost */
  }
}

/** Shared delete button — prominent, top-right of a card. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      className="grid size-5 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/15"
      aria-label={t('edit.delete')}
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}

/** ‹ › buttons to nudge a node left/right along the timeline. */
function MoveButtons({
  onLeft,
  onRight,
  canLeft,
  canRight,
}: {
  onLeft: () => void;
  onRight: () => void;
  canLeft: boolean;
  canRight: boolean;
}) {
  const { t } = useI18n();
  const cls =
    'grid size-5 place-items-center rounded text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-25 disabled:hover:bg-transparent';
  return (
    <>
      <button
        type="button"
        disabled={!canLeft}
        onClick={(e) => {
          e.stopPropagation();
          onLeft();
        }}
        className={cls}
        aria-label={t('edit.timeline.moveLeft')}
        title={t('edit.timeline.moveLeft')}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <button
        type="button"
        disabled={!canRight}
        onClick={(e) => {
          e.stopPropagation();
          onRight();
        }}
        className={cls}
        aria-label={t('edit.timeline.moveRight')}
        title={t('edit.timeline.moveRight')}
      >
        <ChevronRight className="size-3.5" />
      </button>
    </>
  );
}

type TtsStatus = 'none' | 'ready' | 'generating' | 'error';

/** Audio status + 试听 / 重新生成 row, shown when managed TTS is on. */
function SpeechTtsBar({
  actionId,
  audioId,
  sceneOrder,
  language,
  text,
  audioUrl,
  refreshKey,
  onGenerated,
}: {
  actionId: string;
  audioId?: string;
  sceneOrder: number;
  language?: string;
  text: string;
  audioUrl?: string;
  refreshKey?: number;
  onGenerated: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TtsStatus>('none');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objUrlRef = useRef<string | null>(null);

  // The audio's real key: the action's stamped audioId, else the canonical
  // derived key (resolveSpeechAudioId is the single source of truth).
  const lookupId = resolveSpeechAudioId(sceneOrder, { id: actionId, audioId });

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (audioUrl) {
        if (alive) setStatus('ready');
        return;
      }
      const has = await audioExists(lookupId);
      if (alive) setStatus((s) => (s === 'generating' ? s : has ? 'ready' : 'none'));
    })();
    return () => {
      alive = false;
    };
  }, [lookupId, audioUrl, refreshKey]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const preview = async () => {
    stopPreview();
    let src = audioUrl ?? null;
    if (!src) {
      src = await audioObjectUrl(lookupId);
      objUrlRef.current = src;
    }
    if (!src) return;
    const a = new Audio(src);
    audioRef.current = a;
    a.addEventListener('ended', stopPreview);
    void a.play().catch(() => stopPreview());
  };

  const regenerate = async () => {
    setStatus('generating');
    try {
      const id = await regenerateSpeechAudio(sceneOrder, { id: actionId, text }, language);
      if (id) {
        onGenerated();
        setStatus('ready');
      } else {
        setStatus('none');
      }
    } catch {
      setStatus('error');
    }
  };

  const STATUS: Record<TtsStatus, { label: string; cls: string }> = {
    ready: { label: t('edit.tts.statusReady'), cls: 'text-emerald-600 dark:text-emerald-400' },
    none: { label: t('edit.tts.statusNone'), cls: 'text-muted-foreground/55' },
    generating: {
      label: t('edit.tts.statusGenerating'),
      cls: 'text-violet-600 dark:text-violet-400',
    },
    error: { label: t('edit.tts.statusError'), cls: 'text-rose-500' },
  };
  const s = STATUS[status];

  return (
    <div className="flex items-center gap-1 border-t border-gray-100 px-2 py-1 dark:border-gray-700/50">
      <Volume2 className="size-3 shrink-0 text-muted-foreground/40" />
      <span className={cn('text-[10px] font-medium', s.cls)}>{s.label}</span>
      <span className="ml-auto" />
      <button
        type="button"
        onClick={preview}
        disabled={status !== 'ready'}
        className="grid size-5 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label={t('edit.tts.preview')}
        title={t('edit.tts.preview')}
      >
        <Play className="size-3" />
      </button>
      <button
        type="button"
        onClick={regenerate}
        disabled={status === 'generating' || !text.trim()}
        className="grid size-5 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label={t('edit.tts.regenerate')}
        title={t('edit.tts.regenerate')}
      >
        <RefreshCw className={cn('size-3', status === 'generating' && 'animate-spin')} />
      </button>
    </div>
  );
}

/** One spoken line — a numbered, editable clip block. */
function SpeechClip({
  text,
  index,
  actionId,
  audioId,
  sceneOrder,
  language,
  autoFocus,
  ttsActive,
  audioUrl,
  ttsRefresh,
  onCommit,
  onGenerated,
  onDelete,
  onMoveLeft,
  onMoveRight,
  canMoveLeft,
  canMoveRight,
  onDragStart,
  onDragEnd,
  onFocused,
}: {
  text: string;
  index: number;
  actionId: string;
  audioId?: string;
  sceneOrder: number;
  language?: string;
  autoFocus: boolean;
  ttsActive: boolean;
  audioUrl?: string;
  ttsRefresh?: number;
  onCommit: (text: string) => void;
  onGenerated: () => void;
  onDelete: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onFocused: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState(text);
  // Has the user typed since the last external sync? If not, external text
  // changes (e.g. an agent regeneration mid-edit) are adopted even while
  // focused — so a stale draft can't clobber regenerated narration on blur.
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (document.activeElement !== ref.current || !dirtyRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync external text in only when not mid-edit
      setVal(text);
      dirtyRef.current = false;
    }
  }, [text]);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      onFocused();
    }
  }, [autoFocus, onFocused]);

  const commit = () => {
    if (dirtyRef.current && val !== text) onCommit(val);
    dirtyRef.current = false;
  };

  const SpeechIcon = cueMeta('speech').icon;

  return (
    <div className="group/clip relative flex h-full w-[228px] shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-white/70 shadow-sm transition-colors focus-within:border-violet-400 hover:border-violet-300/70 dark:border-gray-700/60 dark:bg-slate-800/50 dark:hover:border-violet-500/40">
      <span className="absolute inset-x-0 top-0 h-[3px] bg-primary/30 transition-colors group-hover/clip:bg-primary/60" />
      <div className="flex items-center gap-1.5 border-b border-gray-100 bg-gray-50/70 px-2 py-1 dark:border-gray-700/50 dark:bg-slate-900/40">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="cursor-grab text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          aria-label={t('edit.timeline.reorder')}
        >
          <GripVertical className="size-3.5" />
        </span>
        <span className="font-mono text-[10px] font-semibold tabular-nums text-muted-foreground/55">
          {String(index).padStart(2, '0')}
        </span>
        <SpeechIcon className="size-3 text-primary/45" />
        <span className="ml-auto mr-0.5 text-[8.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/40">
          {t('edit.cue.speech')}
        </span>
        <MoveButtons
          onLeft={onMoveLeft}
          onRight={onMoveRight}
          canLeft={canMoveLeft}
          canRight={canMoveRight}
        />
        <DeleteButton onDelete={onDelete} />
      </div>
      <textarea
        ref={ref}
        value={val}
        onChange={(e) => {
          dirtyRef.current = true;
          setVal(e.target.value);
        }}
        onBlur={commit}
        placeholder={t('edit.timeline.speechPlaceholder')}
        className="flex-1 resize-none bg-transparent px-3 py-2 text-[12.5px] leading-[1.7] text-foreground/85 outline-none placeholder:text-muted-foreground/40 [scrollbar-width:thin]"
      />
      {ttsActive && (
        <SpeechTtsBar
          actionId={actionId}
          audioId={audioId}
          sceneOrder={sceneOrder}
          language={language}
          text={val}
          audioUrl={audioUrl}
          refreshKey={ttsRefresh}
          onGenerated={onGenerated}
        />
      )}
    </div>
  );
}

/**
 * A discussion node — the scene's terminal roundtable trigger. Unlike the other
 * cues it isn't drag-addable or movable: a discussion must be the LAST action and
 * there is at most one per scene (mirrors the action-parser invariant), so it's
 * appended via the toolbar and pinned at the end. Inline-edits topic (required),
 * prompt (optional) and the initiating agent. Topic/prompt commit on blur.
 */
function DiscussionClip({
  topic,
  prompt,
  agentId,
  agents,
  onTopicChange,
  onPromptChange,
  onAgentChange,
  onDelete,
}: {
  topic: string;
  prompt: string;
  agentId: string;
  agents: Array<{ id: string; name: string; avatar?: string }>;
  onTopicChange: (v: string) => void;
  onPromptChange: (v: string) => void;
  onAgentChange: (v: string) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const m = cueMeta('discussion');
  const needsTopic = !topic.trim();

  // Local drafts committed on blur; synced from props when not mid-edit so a
  // concurrent store update can't clobber an in-flight edit (mirrors SpeechClip).
  const [topicVal, setTopicVal] = useState(topic);
  const [promptVal, setPromptVal] = useState(prompt);
  const topicDirty = useRef(false);
  const promptDirty = useRef(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt external topic only when not mid-edit
    if (!topicDirty.current) setTopicVal(topic);
  }, [topic]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt external prompt only when not mid-edit
    if (!promptDirty.current) setPromptVal(prompt);
  }, [prompt]);

  return (
    <div
      className={cn(
        'group/disc relative flex h-full w-[228px] shrink-0 flex-col overflow-hidden rounded-xl border bg-white/70 shadow-sm transition-colors dark:bg-slate-800/50',
        needsTopic
          ? 'border-dashed border-amber-400/70'
          : 'border-gray-200/80 focus-within:border-yellow-400 hover:border-yellow-300/70 dark:border-gray-700/60 dark:hover:border-yellow-500/40',
      )}
    >
      <span className={cn('absolute inset-x-0 top-0 h-[3px]', m.accent)} />
      <div className="flex items-center gap-1.5 border-b border-yellow-300/50 bg-yellow-400/15 px-2 py-1 dark:border-yellow-500/25 dark:bg-yellow-500/10">
        <span className="flex size-4 items-center justify-center rounded-md bg-yellow-400 text-yellow-950 dark:bg-yellow-500 dark:text-slate-900">
          <Flag className="size-2.5" />
        </span>
        <span className="text-[8.5px] font-semibold uppercase tracking-[0.12em] text-yellow-700 dark:text-yellow-400">
          {t('edit.cue.discussion')}
        </span>
        <span
          className="ml-auto text-[8.5px] font-medium uppercase tracking-[0.1em] text-yellow-600/70 dark:text-yellow-500/60"
          title={t('edit.timeline.discussionTerminalHint')}
        >
          {t('edit.timeline.discussionTerminal')}
        </span>
        <DeleteButton onDelete={onDelete} />
      </div>
      <textarea
        value={topicVal}
        onChange={(e) => {
          topicDirty.current = true;
          setTopicVal(e.target.value);
        }}
        onBlur={() => {
          if (topicDirty.current) onTopicChange(topicVal);
          topicDirty.current = false;
        }}
        placeholder={t('edit.timeline.discussionTopicPlaceholder')}
        className="h-[46px] shrink-0 resize-none bg-transparent px-3 pt-2 text-[12.5px] font-medium leading-[1.55] text-foreground/85 outline-none placeholder:font-normal placeholder:text-amber-500/60 [scrollbar-width:thin]"
      />
      <textarea
        value={promptVal}
        onChange={(e) => {
          promptDirty.current = true;
          setPromptVal(e.target.value);
        }}
        onBlur={() => {
          if (promptDirty.current) onPromptChange(promptVal);
          promptDirty.current = false;
        }}
        placeholder={t('edit.timeline.discussionPromptPlaceholder')}
        className="min-h-0 flex-1 resize-none bg-transparent px-3 text-[11px] leading-[1.6] text-muted-foreground outline-none placeholder:text-muted-foreground/35 [scrollbar-width:thin]"
      />
      <div className="flex items-center gap-1 border-t border-gray-100 px-2 py-1 dark:border-gray-700/50">
        <span className="shrink-0 text-[9px] text-muted-foreground/50">
          {t('edit.timeline.discussionAgent')}
        </span>
        <Select
          value={agentId || DISCUSSION_AGENT_NONE}
          onValueChange={(v) => onAgentChange(v === DISCUSSION_AGENT_NONE ? '' : v)}
        >
          <SelectTrigger
            size="sm"
            className="ml-auto h-6 max-w-[150px] gap-1 rounded border-border px-1.5 py-0 text-[10px] shadow-none focus-visible:ring-yellow-400/40 [&_svg]:size-3"
          >
            <SelectValue placeholder={t('edit.timeline.discussionAgentUnset')} />
          </SelectTrigger>
          <SelectContent className="max-h-56">
            <SelectItem value={DISCUSSION_AGENT_NONE} className="text-[11px]">
              <span className="text-muted-foreground">
                {t('edit.timeline.discussionAgentUnset')}
              </span>
            </SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id} className="text-[11px]">
                <span className="flex items-center gap-1.5">
                  {a.avatar && (
                    <span className="size-4 shrink-0 overflow-hidden rounded-full bg-muted">
                      <AvatarDisplay src={a.avatar} alt={a.name} />
                    </span>
                  )}
                  {a.name}
                </span>
              </SelectItem>
            ))}
            {/* keep a set agent visible even if it's no longer in the scene roster */}
            {agentId && !agents.some((a) => a.id === agentId) && (
              <SelectItem value={agentId} className="text-[11px]">
                {agentId}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * A non-speech cue — its own compact card on the timeline (the action's implicit
 * container, made explicit). Carries a delete button; clicking an element-bound
 * cue arms canvas pick mode so the target is chosen on the slide itself.
 */
function CueMarker({
  action,
  onTip,
  onDelete,
  onPick,
  onMoveLeft,
  onMoveRight,
  canMoveLeft,
  canMoveRight,
  onDragStart,
  onDragEnd,
}: {
  action: Action;
  onTip: (t: TooltipState | null) => void;
  onDelete: () => void;
  onPick: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { t } = useI18n();
  const m = cueMeta(action.type);
  const label = cueLabel(action.type, t);
  const Icon = m.icon;
  const bound = ELEMENT_BOUND.has(action.type);
  const elementId = (action as { elementId?: string }).elementId ?? '';
  const needsTarget = bound && !elementId;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseEnter={(e) => {
        onTip({ action, anchor: e.currentTarget.getBoundingClientRect() });
        applyCuePreview(cuePreviewFor(action));
      }}
      onMouseLeave={() => {
        onTip(null);
        clearCuePreview();
      }}
      onClick={() => {
        if (bound) onPick();
      }}
      className={cn(
        'group/cue relative flex h-full w-[108px] shrink-0 flex-col overflow-hidden rounded-xl border bg-white/65 shadow-sm transition-colors dark:bg-slate-800/40',
        bound
          ? 'cursor-pointer hover:border-violet-300/70 dark:hover:border-violet-500/40'
          : 'cursor-grab active:cursor-grabbing',
        needsTarget
          ? 'border-dashed border-amber-400/70'
          : 'border-gray-200/80 dark:border-gray-700/60',
      )}
      aria-label={label}
    >
      <span className={cn('absolute inset-x-0 top-0 h-[3px]', m.accent)} />
      <div className="flex items-center gap-0.5 px-1 pt-1">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab text-muted-foreground/35 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          aria-label={t('edit.timeline.reorder')}
        >
          <GripVertical className="size-3.5" />
        </span>
        <span className="ml-auto flex items-center">
          <MoveButtons
            onLeft={onMoveLeft}
            onRight={onMoveRight}
            canLeft={canMoveLeft}
            canRight={canMoveRight}
          />
          <DeleteButton onDelete={onDelete} />
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-1 pb-1">
        <span className={cn('flex size-8 items-center justify-center rounded-full', m.glyph)}>
          <Icon className="size-4" />
        </span>
        <span className="text-[10px] font-medium text-foreground/70">{label}</span>
        {bound && (
          <span
            className={cn(
              'text-[9px]',
              needsTarget
                ? 'font-medium text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground/45',
            )}
          >
            {needsTarget ? t('edit.timeline.pickElement') : t('edit.timeline.bound')}
          </span>
        )}
      </div>
    </div>
  );
}

/** A node anchored on the axis — drag handle; for cues, hover preview + click-to-pick. */
function NodeDot({
  action,
  onTip,
  onPick,
  onDragStart,
  onDragEnd,
  canDrag = true,
}: {
  action: Action;
  onTip: (t: TooltipState | null) => void;
  onPick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  canDrag?: boolean;
}) {
  const { t } = useI18n();
  const isSpeech = action.type === 'speech';
  // A discussion is the scene's terminal anchor — give its node a distinct
  // marker (square, filled yellow) so it reads as the end stop, not a regular
  // cue. Its flag glyph comes from cue-meta like every other type's.
  const isDiscussion = action.type === 'discussion';
  const bound = ELEMENT_BOUND.has(action.type);
  const elementId = (action as { elementId?: string }).elementId ?? '';
  const needsTarget = bound && !elementId;
  const m = cueMeta(action.type);
  const label = cueLabel(action.type, t);
  const Icon = m.icon;
  return (
    <span
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={isSpeech ? (action as { text?: string }).text?.slice(0, 60) : label}
      onMouseEnter={(e) => {
        if (isSpeech) return;
        onTip({ action, anchor: e.currentTarget.getBoundingClientRect() });
        applyCuePreview(cuePreviewFor(action));
      }}
      onMouseLeave={() => {
        if (isSpeech) return;
        onTip(null);
        clearCuePreview();
      }}
      onClick={() => {
        if (bound) onPick();
      }}
      className={cn(
        'grid size-6 place-items-center ring-2 ring-white transition-transform hover:scale-110 dark:ring-slate-900',
        isDiscussion ? 'rounded-md' : 'rounded-full',
        needsTarget
          ? 'text-amber-600 bg-amber-100 ring-amber-200 animate-pulse dark:bg-amber-500/20 dark:text-amber-400'
          : isDiscussion
            ? 'bg-yellow-400 text-yellow-950 ring-yellow-200 dark:bg-yellow-500 dark:text-slate-900 dark:ring-yellow-500/30'
            : m.glyph,
        bound
          ? 'cursor-pointer'
          : canDrag
            ? 'cursor-grab active:cursor-grabbing'
            : 'cursor-default',
      )}
      aria-label={label}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/** Slim insertion slot between items; widens + glows while a drag hovers it. */
function DropZone({
  active,
  onEnter,
  onDrop,
  flex,
}: {
  active: boolean;
  onEnter: () => void;
  onDrop: () => void;
  flex?: boolean;
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onEnter();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={cn(
        'relative h-full shrink-0 transition-all',
        flex ? 'flex-1' : active ? 'w-10' : 'w-2.5',
      )}
    >
      <span
        className={cn(
          'absolute inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors',
          active ? 'bg-violet-500' : 'bg-transparent',
        )}
      />
    </div>
  );
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const { t } = useI18n();
  const scene = useStageStore((s) => s.scenes.find((x) => x.id === sceneId));
  const actions = scene?.actions ?? EMPTY;
  const sceneOrder = scene?.order ?? 0;
  // Element-bound cues (spotlight / laser) point at slide elements, so they only
  // make sense on SLIDE scenes. Quiz / interactive / PBL scenes have no canvas to
  // bind to — offer speech only, so the user can't insert unsupported cues.
  const palette =
    scene?.type === 'slide' ? PALETTE : PALETTE.filter((pt) => !ELEMENT_BOUND.has(pt));
  const language = useStageStore((s) => s.stage?.languageDirective);
  // Managed TTS on → speech clips show audio status + 试听 / 重新生成.
  const ttsActive = useSettingsStore(
    (s) => s.ttsEnabled && s.ttsProviderId !== 'browser-native-tts',
  );

  // Agents a discussion can be initiated by — sourced from the user's currently
  // SELECTED agents, the exact set the playback engine gates on: it skips (and
  // consumes) any discussion whose `agentId` isn't selected. Offering the same
  // set here means whatever the author picks will actually fire at playback;
  // anything else (scene/stage roster) could let them save an initiator that the
  // engine silently drops. With nothing selected only "unspecified" remains,
  // which is correct since an unset `agentId` is never skipped.
  const agentsRecord = useAgentRegistry((s) => s.agents);
  const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
  const discussionAgents = useMemo(
    () =>
      selectedAgentIds
        .map((id) => agentsRecord[id])
        .filter(Boolean)
        .map((a) => ({ id: a.id, name: a.name, avatar: a.avatar })),
    [selectedAgentIds, agentsRecord],
  );

  const [lineMode, setLineMode] = useState(false); // collapse to just the axis line of node icons
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [regenAll, setRegenAll] = useState(false);
  const [ttsRefresh, setTtsRefresh] = useState(0); // bump → speech clips re-check audio status
  const reduce = useReducedMotion();
  const dragRef = useRef<DragPayload | null>(null);

  // Apply an edit to the LATEST actions from the store (not the render-time
  // snapshot), so a concurrent agent/TTS update isn't reverted by a later UI
  // commit (drag / reorder / blur / delete).
  const commit = useCallback(
    (updater: (cur: Action[]) => Action[]) => {
      const cur = useStageStore.getState().scenes.find((s) => s.id === sceneId)?.actions ?? [];
      useStageStore.getState().updateScene(sceneId, { actions: updater(cur) });
    },
    [sceneId],
  );

  // Regenerate TTS for every speech line in the scene, then stamp audioIds.
  // Reads the latest actions from the store at each step so a concurrent edit
  // isn't clobbered, and stamps by id (index-stale-safe).
  const regenerateAllAudio = useCallback(async () => {
    if (regenAll) return;
    const latest = () => useStageStore.getState().scenes.find((s) => s.id === sceneId);
    const speeches = (latest()?.actions ?? []).filter(
      (a) => a.type === 'speech' && ((a as { text?: string }).text ?? '').trim(),
    );
    if (!speeches.length) return;
    const order = latest()?.order ?? 0;
    setRegenAll(true);
    // Stamp audioId only for lines that actually synthesized — a skipped/failed
    // line must not get an id pointing at a blob that was never written.
    const okIds = new Set<string>();
    try {
      for (const a of speeches) {
        if (!a.id) continue;
        try {
          const id = await regenerateSpeechAudio(
            order,
            { id: a.id, text: (a as { text?: string }).text ?? '' },
            language,
          );
          if (id) okIds.add(a.id);
        } catch {
          /* skip a failed line, keep going */
        }
      }
      if (okIds.size > 0) {
        commit((cur) => {
          let next = cur;
          for (const a of cur) {
            if (a.type === 'speech' && a.id && okIds.has(a.id))
              next = setAudioIdById(next, a.id, speechAudioId(order, a.id));
          }
          return next;
        });
        setTtsRefresh((n) => n + 1);
      }
    } finally {
      setRegenAll(false);
    }
  }, [regenAll, sceneId, language, commit]);

  // Height drag-resize (top edge).
  const sectionRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panViewport = (dir: -1 | 1) =>
    scrollRef.current?.scrollBy({ left: dir * 280, behavior: 'smooth' });
  const [height, setHeight] = useState(DEFAULT_H);
  const resizeRef = useRef<{
    startY: number;
    startH: number;
    lastH: number;
    pointerId: number;
  } | null>(null);
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startH = sectionRef.current?.getBoundingClientRect().height ?? height;
      resizeRef.current = { startY: e.clientY, startH, lastH: startH, pointerId: e.pointerId };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best effort */
      }
      document.body.style.cursor = 'row-resize';
    },
    [height],
  );
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = resizeRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const next = Math.min(MAX_H, Math.max(MIN_H, d.startH + (d.startY - e.clientY)));
    d.lastH = next;
    if (sectionRef.current) sectionRef.current.style.height = `${next}px`;
  }, []);
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = resizeRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
    setHeight(d.lastH);
    resizeRef.current = null;
    document.body.style.cursor = '';
  }, []);

  const handleDrop = useCallback(
    (slot: number) => {
      const p = dragRef.current;
      dragRef.current = null;
      setDragOver(null);
      if (!p) return;
      if (p.kind === 'new') {
        const id =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `a-${Date.now()}`;
        const action = makeAction(p.type, id);
        // A discussion must stay last, so cap every insert/move before it.
        commit((cur) => insertAt(cur, clampInsertSlot(cur, slot), action));
        if (p.type === 'speech') setFocusId(id);
      } else {
        commit((cur) => moveById(cur, p.id, clampInsertSlot(cur, slot)));
      }
    },
    [commit],
  );

  const speechCount = actions.filter((a) => a.type === 'speech').length;
  const cueCount = actions.length - speechCount;

  // A discussion is pinned at the end (at most one), so ordinary actions can move
  // right only up to the slot before it; the discussion node itself can't move.
  const discussionPresent = hasDiscussion(actions);
  const lastMovableIndex = discussionPresent ? actions.length - 2 : actions.length - 1;

  const addDiscussion = useCallback(() => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}`;
    commit((cur) => appendDiscussion(cur, id));
  }, [commit]);

  let speechIndex = 0;
  const items = actions.map((action, index) => {
    if (action.type === 'speech') speechIndex += 1;
    return { action, index, key: (action.id ?? `a-${index}`) as string, speechIndex };
  });

  return (
    <section
      ref={sectionRef}
      style={{ height: lineMode ? LINE_H : height }}
      className="relative flex flex-col border-t border-gray-100 bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-slate-900/80"
    >
      {!lineMode && (
        <div
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          className="group absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none transition-colors hover:bg-violet-400/30 active:bg-violet-500/50 dark:hover:bg-violet-500/30"
        >
          <div className="absolute left-1/2 top-[3px] h-0.5 w-9 -translate-x-1/2 rounded-full bg-gray-300 transition-colors group-hover:bg-violet-400 dark:bg-gray-600 dark:group-hover:bg-violet-500" />
        </div>
      )}

      <div className="flex h-10 shrink-0 items-center gap-2.5 px-6">
        <button
          type="button"
          onClick={() => setLineMode((v) => !v)}
          className="flex items-center gap-2.5"
        >
          <span className="size-1.5 rounded-full bg-primary" />
          <span className="text-[12px] font-medium tracking-[0.18em] text-foreground/80">
            {t('edit.timeline.title')}
          </span>
        </button>

        {!lineMode && (
          <div className="ml-3 flex items-center gap-1.5 border-l border-gray-200/70 pl-3 dark:border-gray-700/60">
            <span className="text-[10px] text-muted-foreground/45">
              {t('edit.timeline.dragToAdd')}
            </span>
            {palette.map((pt) => {
              const Icon = cueMeta(pt).icon;
              return (
                <span
                  key={pt}
                  draggable
                  onDragStart={(e) => {
                    dragRef.current = { kind: 'new', type: pt };
                    setBlankDragImage(e);
                  }}
                  onDragEnd={() => {
                    dragRef.current = null;
                    setDragOver(null);
                  }}
                  className="inline-flex cursor-grab items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground active:cursor-grabbing"
                >
                  <Icon className="size-3" />
                  {cueLabel(pt, t)}
                </span>
              );
            })}
          </div>
        )}

        {!lineMode && ttsActive && (
          <button
            type="button"
            onClick={regenerateAllAudio}
            disabled={regenAll}
            title={t('edit.timeline.regenAllTts')}
            aria-label={t('edit.timeline.regenAllTts')}
            className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3', regenAll && 'animate-spin')} />
            {t('edit.timeline.voiceAll')}
          </button>
        )}

        {/* A discussion is terminal + at-most-one, so it's appended here rather
            than dragged in. Disabled once the scene already has one. The flag
            icon matches the discussion's terminal-anchor node on the track. */}
        {!lineMode && (
          <button
            type="button"
            onClick={addDiscussion}
            disabled={discussionPresent}
            title={
              discussionPresent
                ? t('edit.timeline.addDiscussionExists')
                : t('edit.timeline.addDiscussion')
            }
            aria-label={t('edit.timeline.addDiscussion')}
            className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-yellow-400/50 hover:text-foreground disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            <Flag className="size-3" />
            {t('edit.timeline.addDiscussion')}
          </button>
        )}

        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground/60">
          {t('edit.timeline.counts', { speech: speechCount, cue: cueCount })}
        </span>
        {/* pan the timeline viewport left/right */}
        {!lineMode && (
          <div className="ml-1 flex items-center border-l border-gray-200/70 pl-1 dark:border-gray-700/60">
            <button
              type="button"
              onClick={() => panViewport(-1)}
              title={t('edit.timeline.panLeft')}
              aria-label={t('edit.timeline.panLeft')}
              className="grid size-7 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronsLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => panViewport(1)}
              title={t('edit.timeline.panRight')}
              aria-label={t('edit.timeline.panRight')}
              className="grid size-7 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronsRight className="size-4" />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setLineMode((v) => !v)}
          title={lineMode ? t('edit.timeline.expandTrack') : t('edit.timeline.collapseAxis')}
          aria-label={lineMode ? t('edit.timeline.expandTrack') : t('edit.timeline.collapseAxis')}
          className="ml-1 grid size-7 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          {lineMode ? <UnfoldVertical className="size-4" /> : <FoldVertical className="size-4" />}
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="relative h-full min-w-max">
          {/* the timeline axis (top) — nodes hang below it; hidden when empty
                so the placeholder hint doesn't collide with the line */}
          {actions.length > 0 && (
            <div
              className="pointer-events-none absolute inset-x-3 bg-gradient-to-r from-border/30 via-border to-border/30"
              style={{ top: AXIS_FROM_TOP - 1, height: 2 }}
            />
          )}
          <div className="relative flex h-full items-stretch px-3.5">
            {actions.length === 0 && (
              <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[12px] text-muted-foreground/60">
                {t('edit.timeline.emptyHint')}
              </span>
            )}
            <DropZone
              active={dragOver === 0}
              flex={actions.length === 0}
              onEnter={() => setDragOver(0)}
              onDrop={() => handleDrop(0)}
            />
            {items.map(({ action, index, key, speechIndex: si }) => {
              // A discussion is pinned terminal, so it can't be drag-reordered.
              const isDiscussion = action.type === 'discussion';
              const onDragStart = isDiscussion
                ? () => {}
                : (e: React.DragEvent) => {
                    dragRef.current = { kind: 'move', id: key };
                    setBlankDragImage(e);
                  };
              const onDragEnd = () => {
                dragRef.current = null;
                setDragOver(null);
              };
              const onPick = () =>
                useCanvasStore
                  .getState()
                  .setPickTarget({ sceneId, actionId: key, cueType: action.type });
              const dot = (
                <NodeDot
                  action={action}
                  onTip={setTip}
                  onPick={onPick}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  canDrag={!isDiscussion}
                />
              );
              return (
                <div key={key} className="relative flex h-full items-stretch">
                  <motion.div
                    initial={reduce ? false : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.22,
                      delay: reduce ? 0 : Math.min(index * 0.02, 0.24),
                      ease: 'easeOut',
                    }}
                    className="flex h-full flex-col items-center"
                    style={{ paddingTop: AXIS_FROM_TOP - 12 }}
                  >
                    {lineMode ? (
                      <div className="w-9">{dot}</div>
                    ) : (
                      <>
                        {dot}
                        <div className="my-1 h-2.5 w-px bg-border" />
                        <div className="min-h-0 w-full flex-1">
                          {action.type === 'speech' ? (
                            <SpeechClip
                              text={(action as { text?: string }).text ?? ''}
                              index={si}
                              actionId={key}
                              audioId={(action as { audioId?: string }).audioId}
                              sceneOrder={sceneOrder}
                              language={language}
                              ttsActive={ttsActive}
                              audioUrl={(action as { audioUrl?: string }).audioUrl}
                              ttsRefresh={ttsRefresh}
                              autoFocus={key === focusId}
                              onFocused={() => setFocusId(null)}
                              onCommit={(text) => {
                                // Editing the text invalidates any cached audio
                                // (the blob is keyed by order+id, not text), so
                                // drop the stamped fields and delete the blob —
                                // the line then reads as un-voiced until regen.
                                const prevAudioId = (action as { audioId?: string }).audioId;
                                commit((cur) => setSpeechTextClearAudioById(cur, key, text));
                                // Re-check status only AFTER the blob is gone, so
                                // the status row can't race the async delete and
                                // briefly still read "voiced".
                                void discardSpeechAudio(sceneOrder, {
                                  id: key,
                                  audioId: prevAudioId,
                                }).finally(() => setTtsRefresh((n) => n + 1));
                              }}
                              onGenerated={() =>
                                commit((cur) =>
                                  setAudioIdById(cur, key, speechAudioId(sceneOrder, key)),
                                )
                              }
                              onDelete={() => commit((cur) => removeById(cur, key))}
                              onMoveLeft={() => commit((cur) => moveByIdDir(cur, key, -1))}
                              onMoveRight={() => commit((cur) => moveByIdDir(cur, key, 1))}
                              canMoveLeft={index > 0}
                              canMoveRight={index < lastMovableIndex}
                              onDragStart={onDragStart}
                              onDragEnd={onDragEnd}
                            />
                          ) : isDiscussion ? (
                            <DiscussionClip
                              topic={(action as DiscussionAction).topic ?? ''}
                              prompt={(action as DiscussionAction).prompt ?? ''}
                              agentId={(action as DiscussionAction).agentId ?? ''}
                              agents={discussionAgents}
                              onTopicChange={(v) =>
                                commit((cur) => setDiscussionTopicById(cur, key, v))
                              }
                              onPromptChange={(v) =>
                                commit((cur) => setDiscussionPromptById(cur, key, v))
                              }
                              onAgentChange={(v) =>
                                commit((cur) => setDiscussionAgentById(cur, key, v))
                              }
                              onDelete={() => commit((cur) => removeById(cur, key))}
                            />
                          ) : (
                            <CueMarker
                              action={action}
                              onTip={setTip}
                              onDelete={() => commit((cur) => removeById(cur, key))}
                              onPick={onPick}
                              onMoveLeft={() => commit((cur) => moveByIdDir(cur, key, -1))}
                              onMoveRight={() => commit((cur) => moveByIdDir(cur, key, 1))}
                              canMoveLeft={index > 0}
                              canMoveRight={index < lastMovableIndex}
                              onDragStart={onDragStart}
                              onDragEnd={onDragEnd}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </motion.div>
                  <DropZone
                    active={dragOver === index + 1}
                    onEnter={() => setDragOver(index + 1)}
                    onDrop={() => handleDrop(index + 1)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {tip && <CueTooltip tip={tip} />}
    </section>
  );
}
