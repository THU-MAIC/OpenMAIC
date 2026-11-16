'use client';

/**
 * ActionsBar — the "narration script" timeline: a horizontal film-editing strip
 * that is also a light editor for the scene's playback `actions`.
 *
 * This WAS the whole bottom bar. It is now the body of `EditDock`, which owns
 * the surface (border, blur, height, fold) and the global edit bar above it, where
 * the timeline shows its own controls through `useEditDock`, since they and the body
 * share one piece of state.
 *
 * The scene's `actions` ARE the timeline: walked left→right, each `speech`
 * becomes an editable clip block (one spoken line, numbered) and every non-speech
 * cue (spotlight / laser / board) becomes a compact card pinned at its place in
 * the flow. Hovering a cue replays the REAL playback effect on its bound element
 * (setLaser → LaserPointerOverlay, setSpotlight → SpotlightOverlay).
 *
 * Editing (persisted via useStageStore.updateScene → actions-edit ops):
 * - speech clip text is editable inline (commit on blur);
 * - the header "Add action" pill opens ActionPicker to insert a new action;
 * - existing items drag to reorder; each card carries a delete button;
 * - clicking an element-bound cue arms canvas pick mode (useCanvasStore.pickTarget
 *   with purpose 'cue'), so the target is chosen by clicking the element directly
 *   on the slide.
 *
 * Reactive to the stage store; collapse and height belong to the dock.
 */
import { commitCourseEdit, stampGeneratedAudio } from '@/lib/edit/course-edit';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AudioLines,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  GripVertical,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { agentsToParticipants, useAgentRegistry } from '@/lib/orchestration/registry/store';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Action, DiscussionAction } from '@/lib/types/action';
import type { SceneType } from '@/lib/types/stage';
import { ELEMENT_BOUND, cueLabel, cueMeta, cueSummary, elementLabel } from './cue-meta';
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
  setDiscussionAgentById,
  setDiscussionPromptById,
  setDiscussionTopicById,
  setSpeechTextClearAudioById,
} from './actions-edit';
import { DOCK_BAR_ACTION, DockBarTip, useEditDock } from '@/components/edit/EditDock/dock-context';
import { ActionPicker } from './ActionPicker';
import { QuietTextarea } from './QuietTextarea';
import { revealScrollLeft } from './reveal-card';
import type { PickerType } from './picker-options';
import {
  audioExists,
  audioObjectUrl,
  regenerateSpeechAudio,
  resolveLegacySpeechAudioId,
  resolveSpeechAudioId,
} from '@/lib/audio/regenerate-speech-tts';
import { useMayGenerateForStage } from '@/lib/classroom/generation-permission';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';

const EMPTY: Action[] = [];
const EMPTY_ELEMENTS: { id?: string; type: string; content?: string }[] = [];
// Stable empty set for the "no lines regenerating" state (avoids re-allocating
// on every reset and keeps a constant identity between batch runs).
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Module-level single-flight controller for TTS preview: at most one
 * SpeechTtsBar may be loading or playing at any moment, across every speech
 * clip in the timeline. A bar registers its own `stop` handle when it starts a
 * preview and clears it in `stopPreview` only when it is still the registered
 * owner — so a stale stop (a superseded attempt, or an unmounted non-active
 * bar) never kills the currently active preview.
 */
let activePreview: { stop: () => void } | null = null;

/**
 * Clear the canvas spotlight/laser preview when a cue glyph unmounts while it is
 * being hovered — most importantly when the user deletes the cue. React does not
 * fire `onMouseLeave` on unmount, so without this the previewed effect would stay
 * stuck on the slide after its cue is gone.
 */
function useClearCuePreviewOnUnmount() {
  useEffect(() => () => clearCuePreview(), []);
}

/**
 * Soft amber dashed border marking a still-incomplete clip card — an empty
 * narration line, a cue bound to no element, a discussion with no topic. A clip
 * is a card, so a dashed frame reads as "draft / unfinished" better than a dot;
 * the calmer amber stays clear of the blue interactive controls and is dropped
 * the moment the clip is filled.
 */
const INCOMPLETE_CLIP = 'border-dashed border-amber-400/70';

const AXIS_FROM_TOP = 12; // px from track top to the axis center (nodes hang below it)

// Radix Select forbids an empty-string item value, so the discussion's
// "unspecified agent" choice rides a sentinel that maps back to '' on change.
const DISCUSSION_AGENT_NONE = '__none__';

type DragPayload = { kind: 'move'; id: string };

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
  const target = (a as { target?: string }).target;
  if (target) rows.push([t('edit.timeline.fieldElement'), target]);
  if (a.type === 'widget_setState') rows.push([t('edit.timeline.fieldState'), cueSummary(a)]);
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
// icon chip drags with white corners ("white border"). Suppress the ghost with a 1×1
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
/**
 * A card's secondary controls: out of sight until the card is hovered or holds the
 * focus, so a card at rest is its words. Opacity, not display: they stay in the tab
 * order and in place, and a screen without hover keeps them shown.
 */
const CARD_SECONDARY =
  'flex shrink-0 items-center opacity-0 transition-opacity [[data-cue-card]:hover_&]:opacity-100 [[data-cue-card]:focus-within_&]:opacity-100 [@media(hover:none)]:opacity-100';
/**
 * One line, the same on every card, so their text lines up. 24 inside its divider, an
 * even height, so a 14px icon lands on a whole pixel rather than half a pixel high. The
 * right padding puts the delete icon's ink on the right edge of the text below (12px).
 */
const CARD_HEADER =
  'flex h-[25px] shrink-0 items-center gap-1 border-b border-border/60 bg-muted/40 px-2';
/** Every control in a card's header: one hit area, one icon size. */
const CARD_ICON = 'size-3.5';
/** The narration line's text; its height is whole, so the field can be cut to whole lines. */
const SPEECH_LINE_PX = 19;

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

/** TTS preview lifecycle: idle → loading (awaiting the blob URL) → playing → idle. */
type PreviewPhase = 'idle' | 'loading' | 'playing';

const STATUS_ICON: Record<TtsStatus, LucideIcon> = {
  ready: Volume2,
  none: VolumeX,
  generating: Loader2,
  error: CircleAlert,
};

/** Audio status + preview / regenerate, in the card's header, when managed TTS is on. */
export function SpeechTtsBar({
  actionId,
  audioId,
  audioUrl,
  audioInvalidated,
  sceneOrder,
  language,
  text,
  refreshKey,
  regenerating,
  onGenerated,
}: {
  actionId: string;
  audioId?: string;
  /** The legacy URL of an unconverted pair: narration exists until conversion removes it. */
  audioUrl?: string;
  audioInvalidated?: boolean;
  sceneOrder: number;
  language?: string;
  text: string;
  refreshKey?: number;
  regenerating?: boolean;
  /**
   * Notification that regeneration succeeded. Carries the freshly allocated
   * audioId so the caller can stamp it on the action: this tree allocates pool
   * identities (the blob is stored under the returned id), so the id cannot be
   * re-derived by the caller like the reference's deterministic key.
   */
  onGenerated: (audioId: string, sourceText: string) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TtsStatus>('none');
  // Holds this line in the generating state across a batch ("Voice all") run
  // and — crucially — until its OWN audio re-check resolves, so it can't
  // briefly flash back to not voiced in the window between the batch clearing
  // `regenerating` and the async audioExists effect landing. Latched on the
  // rising edge of `regenerating`, cleared inside that re-check effect (which
  // the batch always re-triggers via `refreshKey`).
  const [batchPending, setBatchPending] = useState(false);
  const [prevRegenerating, setPrevRegenerating] = useState(regenerating);
  if (regenerating !== prevRegenerating) {
    // Adjust state during render (per React's "you might not need an effect"),
    // not in an effect — avoids a cascading render on the batch's hot path.
    setPrevRegenerating(regenerating);
    if (regenerating) setBatchPending(true);
  }
  // TTS preview state machine — local UI state for the preview button, kept
  // apart from `status`/`effStatus` (audio availability + regeneration), which
  // the playback lifecycle must not disturb.
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>('idle');
  // Generation token: every `stopPreview` (and every fresh `preview`) bumps it,
  // so an in-flight `audioObjectUrl` await can tell it was superseded and drop
  // its result — this is what kills the double-click double-Audio race.
  const previewTokenRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objUrlRef = useRef<string | null>(null);

  const [statusRecheck, setStatusRecheck] = useState(0);
  const lookupId = resolveSpeechAudioId(sceneOrder, { id: actionId, audioId });
  const [readAudioId, setReadAudioId] = useState<string | undefined>(lookupId);
  const [seededLookupId, setSeededLookupId] = useState(lookupId);
  if (lookupId !== seededLookupId) {
    setSeededLookupId(lookupId);
    setReadAudioId(lookupId);
  }

  const stopPreview = useCallback(() => {
    // Invalidate every in-flight `preview()` await — a newer click, a takeover
    // by another bar, or an unmount all funnel through here.
    previewTokenRef.current += 1;
    // Only the registered owner clears the module-level handle: a stale stop
    // from a superseded or unmounted bar must not kill the current preview.
    if (activePreview?.stop === stopPreview) activePreview = null;
    audioRef.current?.pause();
    audioRef.current = null;
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
    setPreviewPhase('idle');
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // A missing stamped id means "not generated" for new documents. Probe
        // the deterministic key only to preserve pre-allocation Dexie rows.
        const legacyId = lookupId
          ? undefined
          : await resolveLegacySpeechAudioId(sceneOrder, { id: actionId, audioInvalidated });
        const candidateId = lookupId ?? legacyId;
        // An unconverted pair's legacy URL is narration that exists: the id
        // lookup may find nothing while the URL is still live.
        const has = (candidateId ? await audioExists(candidateId) : false) || !!audioUrl;
        if (alive) {
          setReadAudioId(has ? candidateId : undefined);
          setStatus((s) => (s === 'generating' ? s : has ? 'ready' : 'none'));
        }
      } catch {
        /* IndexedDB read failed — leave status as-is (as before this change) */
      } finally {
        // Clear the batch latch only once the batch itself is over — its
        // end-of-batch re-check runs with regenerating=false. A *stale*
        // pre-batch check that resolves mid-batch must NOT clear it (adding
        // regenerating to the deps also cancels such a check at batch start via
        // the cleanup below). Runs even if the read threw, so the row can never
        // wedge in the generating state.
        if (alive && !regenerating) setBatchPending(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    lookupId,
    actionId,
    sceneOrder,
    audioInvalidated,
    audioUrl,
    refreshKey,
    regenerating,
    statusRecheck,
  ]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const preview = async () => {
    // Global single-flight: stop whatever is loading/playing in ANY bar first.
    // This also bumps the token, so this bar's own previous in-flight attempt
    // is already invalidated by the time we capture the fresh token below.
    activePreview?.stop();
    const token = ++previewTokenRef.current;
    setPreviewPhase('loading');
    activePreview = { stop: stopPreview };
    // The legacy URL of an unconverted pair is the narration when no pool or
    // Dexie id resolved -- or when the resolved id turns out to have no local
    // bytes, which is exactly the dangling-id case the URL survives for.
    const src = (readAudioId ? await audioObjectUrl(readAudioId) : null) ?? audioUrl ?? null;
    if (token !== previewTokenRef.current) {
      // Superseded while loading (a newer click, a takeover, a stop): drop the
      // result and revoke any blob URL we minted — the winner is in charge.
      if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
      return;
    }
    if (!src) {
      stopPreview();
      return;
    }
    objUrlRef.current = src;
    const a = new Audio(src);
    audioRef.current = a;
    a.addEventListener('ended', stopPreview);
    a.addEventListener('error', stopPreview);
    try {
      await a.play();
      // Stopped while play() was settling (e.g. a takeover in the gap): the
      // stop already paused it, nothing more to do.
      if (token !== previewTokenRef.current) return;
      setPreviewPhase('playing');
    } catch {
      // Autoplay rejection etc. — treat like any other stop.
      stopPreview();
    }
  };

  // The control that spends is withheld from a viewer; the ones that only listen
  // and report stay. `regenerateSpeechAudio` refuses in any case.
  const mayRegenerate = useMayGenerateForStage(useStageStore((state) => state.stage?.id));

  const regenerate = async () => {
    setStatus('generating');
    try {
      const previousAudioId = audioId;
      const id = await regenerateSpeechAudio(
        sceneOrder,
        { id: actionId, text, audioId: previousAudioId },
        language,
      );
      if (id) {
        onGenerated(id, text);
        const live = useStageStore
          .getState()
          .scenes.find((scene) => scene.order === sceneOrder)
          ?.actions?.find((action) => action.id === actionId);
        if (live?.type === 'speech' && live.text === text) {
          setReadAudioId(id);
          setStatus('ready');
        } else {
          // The line moved on while this was generating (an edit, an undo): show what
          // it says now, not the clip that just arrived.
          setStatus('none');
          setStatusRecheck((n) => n + 1);
        }
      } else {
        setStatus('none');
      }
    } catch {
      setStatus('error');
    }
  };

  const STATUS: Record<TtsStatus, { label: string; cls: string }> = {
    ready: { label: t('edit.tts.statusReady'), cls: 'text-emerald-600 dark:text-emerald-400' },
    none: { label: t('edit.tts.statusNone'), cls: 'text-muted-foreground' },
    generating: {
      label: t('edit.tts.statusGenerating'),
      cls: 'text-amber-600 dark:text-amber-400',
    },
    error: { label: t('edit.tts.statusError'), cls: 'text-rose-500' },
  };
  // A batch "Voice all" run drives this line's loading state from the parent
  // (regenerating) — independent of the local single-line status. `batchPending`
  // extends the generating state past the prop clearing, until this line's own
  // audio re-check resolves to voiced / not voiced, so the batch end shows a
  // clean generating → voiced transition with no intermediate flash.
  const effStatus: TtsStatus = regenerating || batchPending ? 'generating' : status;
  const s = STATUS[effStatus];
  const previewLabel =
    previewPhase === 'loading'
      ? t('edit.tts.cancelPreview')
      : previewPhase === 'playing'
        ? t('edit.tts.stopPreview')
        : t('edit.tts.preview');
  // idle → Play; loading → spinner (click cancels the load); playing → Stop.
  const PreviewIcon =
    previewPhase === 'loading' ? Loader2 : previewPhase === 'playing' ? Square : Play;

  const StatusIcon = STATUS_ICON[effStatus];
  const playable = effStatus === 'ready';

  return (
    <>
      <span
        data-testid="speech-tts-status"
        data-status={effStatus}
        title={s.label}
        className={cn('flex min-w-0 flex-1 items-center gap-1', s.cls)}
      >
        <StatusIcon
          className={cn(CARD_ICON, 'shrink-0', effStatus === 'generating' && 'animate-spin')}
          aria-hidden="true"
        />
        {/* The label when there is room, not a piece of it: what does not fit on
            the empty first line wraps out of the clipped one. */}
        <span className="flex h-3.5 min-w-0 flex-1 flex-wrap items-center overflow-hidden">
          <span className="h-3.5 w-0" />
          <span className="-translate-y-[0.5px] whitespace-nowrap text-[10px] font-medium leading-[14px]">
            {s.label}
          </span>
        </span>
      </span>
      {/* Play is there at rest once there is something to hear. */}
      <span className={playable ? 'flex shrink-0 items-center' : CARD_SECONDARY}>
        <button
          type="button"
          onClick={previewPhase === 'idle' ? () => void preview() : stopPreview}
          disabled={!playable}
          className={cn(
            'grid size-5 place-items-center rounded-md transition-colors disabled:opacity-30 disabled:hover:bg-transparent',
            previewPhase === 'playing'
              ? 'text-rose-500 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400'
              : 'text-muted-foreground/60 hover:bg-muted hover:text-foreground',
          )}
          aria-label={previewLabel}
          title={previewLabel}
        >
          <PreviewIcon className={cn(CARD_ICON, previewPhase === 'loading' && 'animate-spin')} />
        </button>
      </span>
      {mayRegenerate ? (
        <span className={CARD_SECONDARY}>
          <button
            type="button"
            onClick={regenerate}
            disabled={effStatus === 'generating' || !text.trim()}
            className="grid size-5 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label={t('edit.tts.regenerate')}
            title={t('edit.tts.regenerate')}
          >
            <RefreshCw className={CARD_ICON} />
          </button>
        </span>
      ) : null}
    </>
  );
}

/** One spoken line — a numbered, editable clip block. */
function SpeechClip({
  text,
  actionId,
  audioId,
  audioUrl,
  audioInvalidated,
  sceneOrder,
  language,
  ttsActive,
  ttsRefresh,
  regenerating,
  onCommit,
  onGenerated,
  onDelete,
  onMoveLeft,
  onMoveRight,
  canMoveLeft,
  canMoveRight,
  onDragStart,
  onDragEnd,
}: {
  text: string;
  actionId: string;
  audioId?: string;
  audioUrl?: string;
  audioInvalidated?: boolean;
  sceneOrder: number;
  language?: string;
  ttsActive: boolean;
  ttsRefresh?: number;
  regenerating?: boolean;
  onCommit: (text: string) => void;
  onGenerated: (audioId: string, sourceText: string) => void;
  onDelete: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
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

  const commit = () => {
    if (dirtyRef.current && val !== text) onCommit(val);
    dirtyRef.current = false;
  };

  const needsText = !text.trim();

  return (
    <div
      data-cue-card=""
      className={cn(
        'relative flex h-full w-[340px] shrink-0 flex-col overflow-hidden rounded-xl border border-border/85 bg-white/75 shadow-sm transition-colors focus-within:border-violet-400 hover:border-violet-300/70 dark:bg-slate-800/50 dark:hover:border-violet-500/40',
        needsText && INCOMPLETE_CLIP,
      )}
    >
      <div className={CARD_HEADER}>
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="flex shrink-0 cursor-grab text-muted-foreground/50 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          aria-label={t('edit.timeline.reorder')}
        >
          <GripVertical className={CARD_ICON} />
        </span>
        {ttsActive ? (
          <SpeechTtsBar
            actionId={actionId}
            audioId={audioId}
            audioUrl={audioUrl}
            audioInvalidated={audioInvalidated}
            sceneOrder={sceneOrder}
            language={language}
            text={val}
            refreshKey={ttsRefresh}
            regenerating={regenerating}
            onGenerated={onGenerated}
          />
        ) : (
          <span className="ml-auto" />
        )}
        <span className={CARD_SECONDARY}>
          <MoveButtons
            onLeft={onMoveLeft}
            onRight={onMoveRight}
            canLeft={canMoveLeft}
            canRight={canMoveRight}
          />
          <DeleteButton onDelete={onDelete} />
        </span>
      </div>
      <QuietTextarea
        ref={ref}
        lineHeightPx={SPEECH_LINE_PX}
        wrapperClassName="mt-1"
        value={val}
        onChange={(e) => {
          dirtyRef.current = true;
          setVal(e.target.value);
        }}
        onBlur={commit}
        placeholder={t('edit.timeline.speechPlaceholder')}
        className="px-3 text-[12.5px] leading-[19px] text-foreground/90 placeholder:text-muted-foreground/40"
      />
    </div>
  );
}

/** Who opens the discussion: an avatar and a name, quiet until it is pointed at. */
function DiscussionAgentSelect({
  agentId,
  agents,
  onChange,
}: {
  agentId: string;
  agents: { id: string; name: string; avatar?: string }[];
  onChange: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const avatar = (a: { avatar?: string; name: string }) => (
    <span className="size-5 shrink-0 overflow-hidden rounded-full bg-muted">
      {a.avatar ? <AvatarDisplay src={a.avatar} alt={a.name} /> : null}
    </span>
  );
  return (
    <Select
      value={agentId || DISCUSSION_AGENT_NONE}
      onValueChange={(v) => onChange(v === DISCUSSION_AGENT_NONE ? '' : v)}
    >
      <SelectTrigger
        size="sm"
        data-testid="discussion-agent"
        aria-label={t('edit.timeline.discussionAgent')}
        className="min-w-0 max-w-[112px] data-[size=sm]:h-[22px] gap-0.5 rounded-md border-0 bg-transparent px-1 py-0 text-[11px] text-foreground/80 shadow-none transition-colors hover:bg-gray-500/[0.08] focus-visible:ring-1 focus-visible:ring-primary/50 dark:bg-transparent dark:hover:bg-gray-400/[0.08] [&_svg]:size-3 [&_svg]:opacity-60 [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1"
      >
        <SelectValue placeholder={t('edit.timeline.discussionAgentUnset')} />
      </SelectTrigger>
      <SelectContent className="max-h-56">
        <SelectItem value={DISCUSSION_AGENT_NONE} className="text-[12px]">
          <span className="text-muted-foreground">{t('edit.timeline.discussionAgentUnset')}</span>
        </SelectItem>
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id} className="text-[12px]">
            <span className="flex min-w-0 items-center gap-1.5">
              {avatar(a)}
              <span className="truncate">{a.name}</span>
            </span>
          </SelectItem>
        ))}
        {/* keep a set agent visible even if it's no longer in the scene roster */}
        {agentId && !agents.some((a) => a.id === agentId) && (
          <SelectItem value={agentId} className="text-[12px]">
            <span className="truncate font-mono">{agentId}</span>
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * One row of the discussion card, the same shape as the initiator in its header: a grey
 * name on the left, its value on the right. The rows share the name column, which is as
 * wide as the longest word of either name, so a name only ever breaks between words. On
 * a low dock there is room for two tight lines of name and the row centers on them;
 * otherwise `labelClassName` puts the name's first baseline on the text's.
 */
function DiscussionField({
  label,
  labelClassName,
  rowClassName,
  className,
  ...field
}: ComponentProps<typeof QuietTextarea> & {
  label: string;
  labelClassName: string;
  rowClassName?: string;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        'group/field col-span-2 grid min-h-0 grid-cols-subgrid grid-rows-[minmax(0,1fr)] overflow-hidden pb-1 pl-3 pr-1.5 pt-[5px] transition-colors hover:bg-muted/70 focus-within:bg-primary/[0.05] hover:focus-within:bg-primary/[0.05] dark:focus-within:bg-primary/[0.12] [@container(max-height:90px)]:py-px',
        rowClassName,
      )}
    >
      <label
        htmlFor={id}
        className={cn(
          'text-[10px] font-medium leading-[14px] text-muted-foreground [word-break:keep-all] group-focus-within/field:text-primary supports-[word-break:auto-phrase]:[word-break:auto-phrase] [@container(max-height:90px)]:self-center [@container(max-height:90px)]:pt-0 [@container(max-height:90px)]:leading-3',
          labelClassName,
        )}
      >
        {label}
      </label>
      <QuietTextarea
        {...field}
        id={id}
        wrapperClassName="[@container(max-height:90px)]:flex [@container(max-height:90px)]:items-center"
        className={cn('pr-1.5', className)}
      />
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
      data-cue-card=""
      className={cn(
        'relative flex h-full w-[240px] shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-white/70 shadow-sm transition-colors focus-within:border-violet-400 hover:border-violet-300/70 dark:border-gray-700/60 dark:bg-slate-800/50 dark:hover:border-violet-500/40',
        needsTopic && INCOMPLETE_CLIP,
      )}
    >
      {/* The empty state reads from the amber dashed frame and the topic's "required"
          placeholder; the node above it is the Flag. pl-3 puts the header's name on the
          12px edge of the labels below. */}
      <div className={cn(CARD_HEADER, 'pl-3')}>
        <span
          title={t('edit.timeline.discussionTerminalHint')}
          className="-translate-y-[0.5px] truncate text-[10px] font-medium leading-[14px] text-foreground/70"
        >
          {t('edit.cue.discussion')}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1">
          <span className="-translate-y-[0.5px] shrink-0 text-[10px] leading-[14px] text-muted-foreground/70">
            {t('edit.timeline.discussionAgent')}
          </span>
          <DiscussionAgentSelect agentId={agentId} agents={agents} onChange={onAgentChange} />
        </span>
        <span className={CARD_SECONDARY}>
          <DeleteButton onDelete={onDelete} />
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[fit-content(58px)_minmax(0,1fr)] grid-rows-[minmax(0,55fr)_minmax(29px,45fr)] gap-x-2 [container-type:size]">
        <DiscussionField
          label={t('edit.timeline.discussionTopicLabel')}
          labelClassName="pt-[3px]"
          lineHeightPx={19}
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
          className="text-[12.5px] font-medium leading-[19px] text-foreground/90 placeholder:font-normal placeholder:text-amber-600/70 dark:placeholder:text-amber-400/70"
        />
        <DiscussionField
          label={t('edit.timeline.discussionPromptLabel')}
          labelClassName="pt-[2px]"
          lineHeightPx={17}
          rowClassName="border-t border-border/60"
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
          className="text-[12px] leading-[17px] text-foreground/70 placeholder:text-muted-foreground/50"
        />
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
  elements,
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
  elements: { id?: string; type: string; content?: string }[];
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
  useClearCuePreviewOnUnmount();
  const m = cueMeta(action.type);
  const label = cueLabel(action.type, t);
  const bound = ELEMENT_BOUND.has(action.type);
  const elementId = (action as { elementId?: string }).elementId ?? '';
  const needsTarget = bound && !elementId;
  // Bound cue → show what it's actually pointing at, not a generic "bound";
  // the element may have been deleted since binding, so fall back gracefully.
  const boundEl = elementId ? elements.find((e) => e.id === elementId) : undefined;
  const summary = cueSummary(action);
  const targetLine = needsTarget
    ? t('edit.timeline.pickElement')
    : `→ ${boundEl ? elementLabel(boundEl, t) : t('edit.timeline.bound')}`;

  return (
    <div
      data-cue-card=""
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
        'relative flex h-full w-[104px] shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-white/65 shadow-sm transition-colors dark:border-gray-700/60 dark:bg-slate-800/40',
        bound
          ? 'cursor-pointer hover:border-violet-300/70 dark:hover:border-violet-500/40'
          : 'cursor-grab active:cursor-grabbing',
        needsTarget && cn('border-dashed', m.dash),
      )}
      aria-label={label}
    >
      <div className={CARD_HEADER}>
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={(e) => e.stopPropagation()}
          className="flex shrink-0 cursor-grab text-muted-foreground/50 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          aria-label={t('edit.timeline.reorder')}
        >
          <GripVertical className={CARD_ICON} />
        </span>
        <span className={cn(CARD_SECONDARY, 'ml-auto')}>
          <MoveButtons
            onLeft={onMoveLeft}
            onRight={onMoveRight}
            canLeft={canMoveLeft}
            canRight={canMoveRight}
          />
          <DeleteButton onDelete={onDelete} />
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-0.5 px-2 text-center">
        <span
          title={label}
          className="line-clamp-2 max-w-full text-[12px] font-medium leading-[16px] text-foreground/85 [overflow-wrap:anywhere]"
        >
          {label}
        </span>
        {!bound && summary ? (
          <span
            data-testid="cue-summary"
            title={summary}
            className="max-w-full truncate text-[11px] leading-[16px] text-muted-foreground"
          >
            {summary}
          </span>
        ) : null}
        {bound && (
          <span
            title={targetLine}
            className={cn(
              'max-w-full truncate text-[11px] leading-[16px]',
              needsTarget
                ? 'font-medium text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground',
            )}
          >
            {targetLine}
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
  useClearCuePreviewOnUnmount();
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
        'grid size-5 place-items-center ring-2 ring-white transition-transform hover:scale-110 dark:ring-slate-900',
        isDiscussion ? 'rounded-[7px]' : 'rounded-full',
        needsTarget
          ? 'text-amber-600 bg-amber-100 ring-amber-200 animate-pulse dark:bg-amber-500/20 dark:text-amber-400'
          : isDiscussion
            ? 'bg-yellow-400 text-yellow-900 ring-yellow-200 dark:bg-yellow-500 dark:text-slate-900 dark:ring-yellow-500/30'
            : m.glyph,
        bound
          ? 'cursor-pointer'
          : canDrag
            ? 'cursor-grab active:cursor-grabbing'
            : 'cursor-default',
      )}
      aria-label={label}
    >
      <Icon className="size-3" />
    </span>
  );
}

/** Slim insertion slot between items; widens + glows while a drag hovers it. */
function DropZone({
  active,
  slot,
  onEnter,
  onDrop,
  onInsert,
  insertLabel,
  flex,
}: {
  active: boolean;
  slot: number;
  onEnter: () => void;
  onDrop: () => void;
  onInsert: (slot: number, rect: DOMRect) => void;
  insertLabel: string;
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
        'group/ins relative flex h-full shrink-0 items-start justify-center pt-px transition-all',
        flex ? 'flex-1' : active ? 'w-10' : 'w-4',
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors',
          active ? 'bg-primary' : 'bg-transparent',
        )}
      />
      {!active && (
        <button
          type="button"
          aria-label={insertLabel}
          title={insertLabel}
          onClick={(e) => onInsert(slot, e.currentTarget.getBoundingClientRect())}
          className="relative z-[1] grid size-[22px] scale-90 place-items-center rounded-full border border-dashed border-primary/40 bg-background text-primary/70 opacity-30 transition-all hover:scale-100 hover:border-solid hover:border-primary hover:bg-primary/5 hover:text-primary hover:opacity-100 group-hover/ins:opacity-90"
        >
          <Plus className="size-3" />
        </button>
      )}
    </div>
  );
}

export function ActionsBar({ sceneId }: { sceneId: string }) {
  const { t } = useI18n();
  const scene = useStageStore((s) => s.scenes.find((x) => x.id === sceneId));
  const actions = scene?.actions ?? EMPTY;
  const sceneOrder = scene?.order ?? 0;
  // Element-bound cues (spotlight / laser) point at slide elements, so they only
  // make sense on SLIDE scenes. While the scene hasn't loaded yet, fall back to
  // a non-slide type so the picker doesn't briefly offer unsupported cues.
  const sceneType: SceneType = scene?.type ?? 'quiz';
  // Slide-scene canvas elements — feeds CueMarker's bound-cue label lookup
  // ("→ <element name>" instead of a generic "bound"). Non-slide scenes'
  // `content` has no `canvas`, so this is always [] there.
  const sceneElements =
    (
      scene?.content as
        | { canvas?: { elements?: { id?: string; type: string; content?: string }[] } }
        | undefined
    )?.canvas?.elements ?? EMPTY_ELEMENTS;
  const language = useStageStore((s) => s.stage?.languageDirective);
  // Managed TTS on → speech clips show audio status + preview / regenerate.
  // The ownership gate belongs on regeneration alone: listening back to
  // narration that already exists, and seeing whether a line has any, spend
  // nothing, and a course with no ownership record must not lose its playback
  // controls the way it must lose its ability to bill the operator.
  const ttsTarget = useModelCapabilities().tts;
  const ttsActive = !!ttsTarget && ttsTarget.registryId !== 'browser-native-tts';
  const mayGenerate = useMayGenerateForStage(useStageStore((s) => s.stage?.id));

  // Agents a discussion can be initiated by — sourced from the user's currently
  // SELECTED agents, the exact set the playback engine gates on: it skips (and
  // consumes) any discussion whose `agentId` isn't selected. Offering the same
  // set here means whatever the author picks will actually fire at playback;
  // anything else (scene/stage roster) could let them save an initiator that the
  // engine silently drops. With nothing selected only "unspecified" remains,
  // which is correct since an unset `agentId` is never skipped.
  const agentsRecord = useAgentRegistry((s) => s.agents);
  const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
  // Who the room sees, by the names it sees them by: the course's roster, or the
  // default roster's localized names.
  const discussionAgents = useMemo(
    () =>
      selectedAgentIds.some((id) => agentsRecord[id])
        ? agentsToParticipants(selectedAgentIds, t).filter((p) => p.role !== 'user')
        : [],
    [selectedAgentIds, agentsRecord, t],
  );

  const { expand: expandDock, barActions: dockBarSlot } = useEditDock();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [regenAll, setRegenAll] = useState(false);
  const [pickerAt, setPickerAt] = useState<{ slot: number; rect: DOMRect } | null>(null);
  // Ids of speech lines currently being (re)generated by "Voice all", so each
  // line's status row shows the generating state for the duration of the batch.
  const [regeneratingIds, setRegeneratingIds] = useState<ReadonlySet<string>>(NO_IDS);
  const [ttsRefresh, setTtsRefresh] = useState(0); // bump → speech clips re-check audio status
  const reduce = useReducedMotion();
  const dragRef = useRef<DragPayload | null>(null);

  // Apply an edit to the LATEST actions from the store (not the render-time
  // snapshot), so a concurrent agent/TTS update isn't reverted by a later UI
  // commit (drag / reorder / blur / delete).
  const writeActions = useCallback(
    (updater: (cur: Action[]) => Action[]) => {
      const cur = useStageStore.getState().scenes.find((s) => s.id === sceneId)?.actions ?? [];
      useStageStore.getState().updateScene(sceneId, { actions: updater(cur) });
    },
    [sceneId],
  );
  const commit = useCallback(
    (updater: (cur: Action[]) => Action[]) => {
      commitCourseEdit({}, () => writeActions(updater));
    },
    [writeActions],
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
    // Light up every queued line's status row up front (they're all about to be
    // synthesized), cleared together in the finally once the batch settles.
    setRegeneratingIds(new Set(speeches.map((a) => a.id).filter(Boolean) as string[]));
    try {
      for (const queued of speeches) {
        if (!queued.id) continue;
        try {
          const liveAction = latest()?.actions?.find(
            (action) => action.type === 'speech' && action.id === queued.id,
          );
          if (!liveAction || liveAction.type !== 'speech') continue;
          const previousAudioId = liveAction.audioId;
          const id = await regenerateSpeechAudio(
            latest()?.order ?? order,
            {
              id: liveAction.id,
              text: liveAction.text,
              audioId: previousAudioId,
            },
            language,
          );
          if (id) {
            stampGeneratedAudio(sceneId, liveAction.id!, liveAction.text, id);
            await flushStageSave();
          }
        } catch {
          /* skip a failed line, keep going */
        }
      }
    } finally {
      setRegenAll(false);
      setRegeneratingIds(NO_IDS);
      // Always re-check every line's audio at batch end — even when nothing
      // synthesized — so each SpeechTtsBar resolves its status (and clears its
      // batchPending flag) instead of getting stuck in the generating state.
      setTtsRefresh((n) => n + 1);
    }
  }, [regenAll, sceneId, language]);

  const newId = () =>
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}`;

  // Insert path for the ActionPicker (header pill / inline "+" drop-zone
  // buttons): appends a discussion (terminal, at-most-one) or inserts an
  // ordinary action at a slot, capped before any existing discussion so it
  // always stays last.
  const insertActionAt = useCallback(
    (type: PickerType, slot: number) => {
      const id = newId();
      setRevealId(id);
      // A new card is no use behind a folded dock.
      expandDock();
      if (type === 'discussion') {
        commit((cur) => appendDiscussion(cur, id));
        return;
      }
      const action = makeAction(type, id);
      commit((cur) => insertAt(cur, clampInsertSlot(cur, slot), action));
    },
    [commit, expandDock],
  );

  const handleDrop = useCallback(
    (slot: number) => {
      const p = dragRef.current;
      dragRef.current = null;
      setDragOver(null);
      if (!p) return;
      commit((cur) => moveById(cur, p.id, clampInsertSlot(cur, slot)));
    },
    [commit],
  );

  // A discussion is pinned at the end (at most one), so ordinary actions can move
  // right only up to the slot before it; the discussion node itself can't move.
  const discussionPresent = hasDiscussion(actions);
  const lastMovableIndex = discussionPresent ? actions.length - 2 : actions.length - 1;

  let speechIndex = 0;
  const items = actions.map((action, index) => {
    if (action.type === 'speech') speechIndex += 1;
    return { action, index, key: (action.id ?? `a-${index}`) as string, speechIndex };
  });

  // The timeline's own actions, in the dock's control bar: its left flank, where
  // playback has the volume and the speed.
  const barActions = (
    <>
      <DockBarTip label={t('edit.timeline.addAction')}>
        <button
          type="button"
          data-testid="edit-add-action"
          aria-haspopup="menu"
          onClick={(e) => {
            const slot = discussionPresent ? actions.length - 1 : actions.length;
            setPickerAt({ slot, rect: e.currentTarget.getBoundingClientRect() });
          }}
          aria-label={t('edit.timeline.addAction')}
          className={cn(DOCK_BAR_ACTION, 'w-8 gap-px')}
        >
          <Plus className="size-3.5" />
          <ChevronDown className="size-2.5 opacity-60" />
        </button>
      </DockBarTip>
      {ttsActive && mayGenerate ? (
        <DockBarTip label={t('edit.timeline.regenAllTts')}>
          <button
            type="button"
            data-testid="edit-voice-all"
            onClick={regenerateAllAudio}
            disabled={regenAll}
            aria-label={t('edit.timeline.regenAllTts')}
            className={cn(DOCK_BAR_ACTION, 'w-6')}
          >
            <AudioLines className={cn('size-3.5', regenAll && 'animate-pulse')} />
          </button>
        </DockBarTip>
      ) : null}
    </>
  );

  // What was just added: bring it into view, ready to type in, and say which it is.
  useEffect(() => {
    if (!revealId) return;
    setRevealId(null);
    const track = trackRef.current;
    const card = track?.querySelector<HTMLElement>(
      `[data-action-key="${CSS.escape(revealId)}"] [data-cue-card]`,
    );
    if (!track || !card) return;
    const box = track.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const left = revealScrollLeft({
      scrollLeft: track.scrollLeft,
      trackLeft: box.left,
      trackWidth: box.width,
      cardLeft: rect.left,
      cardWidth: rect.width,
    });
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (left !== track.scrollLeft) {
      track.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    }
    card.querySelector<HTMLElement>('textarea')?.focus({ preventScroll: true });
    card.animate?.(
      [
        { boxShadow: '0 0 0 2px rgb(139 92 246 / 0.6)' },
        { boxShadow: '0 0 0 2px rgb(139 92 246 / 0)' },
      ],
      { duration: 1400, easing: 'ease-out' },
    );
  }, [revealId, actions]);

  /** A mouse wheel has no sideways: over the track it scrolls the track. */
  const onTrackWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const field = event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (field && field.scrollHeight > field.clientHeight) return;
    event.currentTarget.scrollLeft += event.deltaY;
  };

  return (
    <>
      {dockBarSlot ? createPortal(barActions, dockBarSlot) : barActions}
      <div
        ref={trackRef}
        onWheel={onTrackWheel}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
      >
        <div className="relative h-full min-w-max">
          {/* the timeline axis (top) — nodes hang below it; hidden when empty
                so the placeholder hint doesn't collide with the line */}
          {actions.length > 0 && (
            <div
              className="pointer-events-none absolute inset-x-3 bg-gradient-to-r from-border/30 via-border to-border/30"
              style={{ top: AXIS_FROM_TOP - 1, height: 2 }}
            />
          )}
          <div className="relative flex h-full items-stretch px-3.5 pb-1">
            {actions.length === 0 && (
              <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[12px] text-muted-foreground/60">
                {t('edit.timeline.emptyHint')}
              </span>
            )}
            <DropZone
              active={dragOver === 0}
              slot={0}
              flex={actions.length === 0}
              onEnter={() => setDragOver(0)}
              onDrop={() => handleDrop(0)}
              onInsert={(slot, rect) => setPickerAt({ slot, rect })}
              insertLabel={t('edit.timeline.addAction')}
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
                useCanvasStore.getState().setPickTarget(
                  useStageStore.getState().stage?.id
                    ? {
                        purpose: 'cue',
                        stageId: useStageStore.getState().stage!.id,
                        sceneId,
                        actionId: key,
                        cueType: action.type,
                      }
                    : null,
                );
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
                <div key={key} data-action-key={key} className="relative flex h-full items-stretch">
                  <motion.div
                    initial={reduce ? false : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.22,
                      delay: reduce ? 0 : Math.min(index * 0.02, 0.24),
                      ease: 'easeOut',
                    }}
                    className="flex h-full flex-col items-center"
                    style={{ paddingTop: AXIS_FROM_TOP - 10 }}
                  >
                    <div className="relative">
                      {dot}
                      {action.type === 'speech' ? (
                        <span
                          data-testid="speech-number"
                          // The axis runs behind it; the dock's own ground lets the digits read.
                          className="absolute left-full top-1/2 ml-1 -translate-y-1/2 rounded-sm bg-[#fdfdfd] px-0.5 font-mono text-[10px] font-semibold leading-[14px] tabular-nums text-muted-foreground dark:bg-[#182332]"
                        >
                          {String(si).padStart(2, '0')}
                        </span>
                      ) : null}
                    </div>
                    <div className="my-px h-1 w-px bg-border" />
                    <div className="min-h-0 w-full flex-1">
                      {action.type === 'speech' ? (
                        <SpeechClip
                          text={(action as { text?: string }).text ?? ''}
                          actionId={key}
                          audioId={(action as { audioId?: string }).audioId}
                          audioUrl={(action as { audioUrl?: string }).audioUrl}
                          audioInvalidated={
                            (action as { audioInvalidated?: boolean }).audioInvalidated
                          }
                          sceneOrder={sceneOrder}
                          language={language}
                          ttsActive={ttsActive}
                          ttsRefresh={ttsRefresh}
                          regenerating={regeneratingIds.has(key)}
                          onCommit={(text) => {
                            // The new wording has no audio until regenerated. The old
                            // clip's local copy stays: an undo brings its reference
                            // back, and nothing resolves it while the line names no id.
                            commit((cur) => setSpeechTextClearAudioById(cur, key, text));
                            setTtsRefresh((n) => n + 1);
                          }}
                          onGenerated={(assetId, sourceText) => {
                            stampGeneratedAudio(sceneId, key, sourceText, assetId);
                            // Stage persistence is debounced; flush so the
                            // stamped reference is durable once the row
                            // settles (pool bytes persist first, stamp last).
                            void flushStageSave().catch(() => undefined);
                          }}
                          onDelete={() => {
                            commit((cur) => removeById(cur, key));
                          }}
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
                          elements={sceneElements}
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
                  </motion.div>
                  <DropZone
                    active={dragOver === index + 1}
                    slot={index + 1}
                    onEnter={() => setDragOver(index + 1)}
                    onDrop={() => handleDrop(index + 1)}
                    onInsert={(slot, rect) => setPickerAt({ slot, rect })}
                    insertLabel={t('edit.timeline.addAction')}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {tip && <CueTooltip tip={tip} />}
      {pickerAt && (
        <ActionPicker
          anchor={pickerAt.rect}
          sceneType={sceneType}
          actions={actions}
          onSelect={(type) => insertActionAt(type, pickerAt.slot)}
          onClose={() => setPickerAt(null)}
        />
      )}
    </>
  );
}
