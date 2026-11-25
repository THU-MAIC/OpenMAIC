'use client';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { DEFAULT_USER_AVATAR } from '@/components/roundtable/constants';
import { SuggestedReplies } from '@/components/roundtable/speech-input';
import { VolumeControl } from '@/components/canvas/volume-control';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ROLE_PERSONAS } from '@/lib/pbl/v3/personas';
import { learningProgress } from '@/lib/pbl/v3/presentation';
import type { LearningView } from '@/lib/pbl/v3/types';
import { PLAYBACK_SPEEDS, useSettingsStore } from '@/lib/store/settings';
import { cn } from '@/lib/utils';
import { COMPANION_RIGHT, COMPANION_SIZE, companionHomeBottom } from './companion-placement';
import { LearnerComposer } from './learner-composer';

/** Stage progress drawn as one arc segment per stage around the avatar. */
function ProgressRing({
  total,
  current,
  color,
  hovered,
  onHover,
  onOpen,
}: {
  total: number;
  current: number;
  color: string;
  /** The segment under the pointer: it lifts off the ring while its stage is named. */
  hovered: number | null;
  onHover: (index: number | null) => void;
  /** The ring is the way into the current task. */
  onOpen: () => void;
}) {
  const r = 34,
    c = 2 * Math.PI * r,
    gap = total > 1 ? 5 : 0,
    seg = c / Math.max(total, 1) - gap;
  return (
    <svg
      viewBox="0 0 76 76"
      className="absolute inset-0 -rotate-90 overflow-visible"
      aria-hidden="true"
    >
      {Array.from({ length: total }, (_, index) => {
        const lifted = hovered === index;
        const done = index < current;
        const arc = {
          cx: 38,
          cy: 38,
          r,
          fill: 'none',
          strokeDasharray: `${seg} ${c - seg}`,
          strokeDashoffset: -(index * (seg + gap)) - gap / 2,
        };
        // A segment lifts along its own radius, like a key rising from a keyboard.
        const angle = ((index + 0.5) / total) * 2 * Math.PI;
        return (
          <g key={index}>
            <motion.circle
              {...arc}
              strokeLinecap="round"
              stroke={done || lifted ? color : 'currentColor'}
              // On a dark workspace the track is a soft light band, not one more dark ring.
              className={done || lifted ? undefined : 'text-border dark:text-white/25'}
              initial={false}
              animate={{
                x: lifted ? Math.cos(angle) * 2.5 : 0,
                y: lifted ? Math.sin(angle) * 2.5 : 0,
                strokeWidth: lifted ? 6 : 4,
                opacity: lifted || index === current - 1 ? 1 : done ? 0.55 : 1,
              }}
              transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
              style={{ filter: lifted ? `drop-shadow(0 1px 3px ${color}66)` : undefined }}
            />
            {/* A wider, unseen band: the drawn arc is too thin to aim at. */}
            <circle
              {...arc}
              strokeWidth="14"
              stroke="transparent"
              pointerEvents="stroke"
              className="cursor-pointer"
              onMouseEnter={() => onHover(index)}
              onMouseLeave={() => onHover(null)}
              onClick={(event) => {
                // The face opens the conversation; the ring opens the task it is tracking.
                event.stopPropagation();
                onOpen();
              }}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** The avatar's outer edge lines up with what it carries: both stand this far in. */
const INSET = 24;
const PLACE_KEY = 'pbl-companion-place';
/** Where the avatar rests: its distance from the right and bottom edges of the workspace. */
type Placement = { right: number; bottom: number };

/**
 * The avatar can be dragged anywhere in the workspace, up to its edges, and stays where it was
 * put. What surrounds it turns to face the room: the controls orbit on the side toward the
 * middle, and the bubble opens above or below and toward the middle. A drag is not a click.
 */
function usePlacement() {
  const [node, setRoot] = useState<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Read once, after hydration.
      if (Number.isFinite(saved?.right) && Number.isFinite(saved?.bottom)) setPlace(saved);
    } catch {
      // A placement that cannot be read is simply the home corner.
    }
  }, []);
  useEffect(() => {
    const parent = node?.offsetParent;
    if (!parent) return;
    const observer = new ResizeObserver(() =>
      setArea({ width: parent.clientWidth, height: parent.clientHeight }),
    );
    observer.observe(parent);
    return () => observer.disconnect();
  }, [node]);
  // Anywhere in the workspace, up to its edges: the controls open toward the middle.
  const fit = (at: Placement) => ({
    right: Math.max(
      COMPANION_RIGHT,
      Math.min(at.right, area.width - COMPANION_SIZE - COMPANION_RIGHT),
    ),
    bottom: Math.max(16, Math.min(at.bottom, area.height - COMPANION_SIZE - 16)),
  });
  const at = fit(place ?? { right: COMPANION_RIGHT, bottom: companionHomeBottom(area.height) });
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY, ...at };
    let moved = false;
    const move = (now: PointerEvent) => {
      const dx = now.clientX - start.x,
        dy = now.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      setDragging(true);
      setPlace(fit({ right: start.right - dx, bottom: start.bottom - dy }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      if (!moved) return;
      // The click that ends a drag is not a click on the avatar.
      const swallow = (click: MouseEvent) => click.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => {
        // A drag released away from the avatar makes no click to swallow.
        window.removeEventListener('click', swallow, { capture: true });
        setPlace((last) => {
          try {
            localStorage.setItem(PLACE_KEY, JSON.stringify(last));
          } catch {
            // Without storage the placement lasts for this visit.
          }
          return last;
        });
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const top = area.height - at.bottom - COMPANION_SIZE;
  // What the avatar carries opens above it, or below when the avatar is high in the workspace.
  const below = area.height > 0 && top < Math.min(360, area.height * 0.45);
  const left = area.width - at.right - COMPANION_SIZE;
  // The avatar is in the left half: the room, and so everything it carries, is to its right.
  const start = area.width > 0 && left + COMPANION_SIZE / 2 < area.width / 2;
  return {
    setRoot,
    dragging,
    below,
    start,
    onPointerDown,
    style: {
      // The avatar and what it carries share an outer edge.
      ...(start ? { left: left - INSET } : { right: at.right - INSET }),
      ...(below ? { top: top - 16 } : { bottom: at.bottom }),
      maxHeight: area.height
        ? (below ? area.height - top : area.height - at.bottom) - 16
        : undefined,
    } as unknown as CSSProperties,
  };
}

/**
 * Which ring segment the pointer has settled on. A pointer only passing over the avatar
 * names nothing, and moving from one segment to the next changes the name without the
 * label leaving in between.
 */
function useSettledHover() {
  const [settled, setSettled] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hover = (index: number | null) => {
    clearTimeout(timer.current);
    if (index !== null && shown.current) return setSettled(index);
    timer.current = setTimeout(
      () => {
        shown.current = index !== null;
        setSettled(index);
      },
      index === null ? 160 : 140,
    );
  };
  return [settled, hover] as const;
}

/**
 * The role as a resident companion at the corner of the workbench: its face, what it is
 * saying, where the learner is in the stage flow, and the controls to answer or move on.
 */
export function Companion({
  view,
  suggestions = [],
  showControls = false,
  task,
  bubbleAway = false,
  onShowBubble,
  speech,
  notice,
  historyOpen,
  onToggleHistory,
  onOpenTask,
  continueLabel,
  onContinue,
  continuing = false,
  disabled = false,
  canChat,
  active = false,
  onStop,
  inputId,
  sending = false,
  text,
  onTextChange,
  speechActive,
  onSpeechActiveChange,
  onSend,
}: {
  view: LearningView;
  /** Replies the role offered with its last question; picking one sends it. */
  suggestions?: readonly string[];
  /** Keep the controls around the avatar out, as while they are being introduced. */
  showControls?: boolean;
  /** The learner put the bubble away; the avatar brings it back before anything else. */
  bubbleAway?: boolean;
  onShowBubble?: () => void;
  /** What the role is saying now, in the classroom's speech bubble. */
  speech?: ReactNode;
  /** A failed or blocked run, shown with its own retry while the conversation is closed. */
  notice?: ReactNode;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onOpenTask: () => void;
  continueLabel?: string;
  onContinue?: () => void;
  continuing?: boolean;
  disabled?: boolean;
  canChat: boolean;
  /** The role is speaking or at work: the learner can stop it to say something. */
  active?: boolean;
  onStop?: () => void;
  inputId: string;
  /** The learner's message is on its way. */
  sending?: boolean;
  text: string;
  onTextChange: (update: React.SetStateAction<string>) => void;
  speechActive: boolean;
  onSpeechActiveChange: (active: boolean) => void;
  onSend: (text: string) => void;
  /** What the stage asks the learner to do here, such as a decision to make. */
  task?: ReactNode;
}) {
  const { t } = useI18n();
  const role = view.role ?? 'mentor';
  const persona = ROLE_PERSONAS[role];
  const progress = learningProgress(view);
  const inputRoot = useRef<HTMLDivElement>(null);
  const muted = useSettingsStore((state) => state.ttsMuted);
  const setMuted = useSettingsStore((state) => state.setTTSMuted);
  const volume = useSettingsStore((state) => state.ttsVolume);
  const setVolume = useSettingsStore((state) => state.setTTSVolume);
  const speed = useSettingsStore((state) => state.playbackSpeed);
  const setSpeed = useSettingsStore((state) => state.setPlaybackSpeed);
  const [hoveredStep, setHoveredStep] = useSettledHover();
  const { setRoot: placeRoot, ...placement } = usePlacement();
  // The input sits under the bubble whenever the learner can speak here. T still puts the
  // cursor in it, never while the learner is typing somewhere else.
  const answering = (canChat || (active && !!onStop)) && !historyOpen && !bubbleAway;
  const shortcuts = answering && canChat;
  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !target ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable
      )
        return;
      if (event.key.toLowerCase() !== 't') return;
      event.preventDefault();
      event.stopPropagation();
      inputRoot.current?.querySelector('textarea')?.focus();
    };
    // Capture: the classroom around this workbench listens for the same keys for its own
    // roundtable, which is not on screen here.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [shortcuts]);
  const controlsOpen = showControls;
  const round =
    'flex size-9 items-center justify-center rounded-full border bg-background shadow-md hover:bg-muted active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-slate-700 dark:hover:bg-slate-600';
  // Controls rest folded into the avatar and swing out to their place on its near side.
  const orbit =
    'pointer-events-auto absolute transition-[opacity,visibility,translate,scale] duration-200 ease-out';
  const orbitOpen = 'visible scale-100 opacity-100';
  const orbitClosed =
    'invisible scale-75 opacity-0 delay-300 group-focus-within/companion:visible group-focus-within/companion:scale-100 group-focus-within/companion:opacity-100 group-focus-within/companion:delay-0 group-hover/companion:visible group-hover/companion:scale-100 group-hover/companion:opacity-100 group-hover/companion:delay-0';
  const satelliteOpen = `${orbitOpen} translate-x-[var(--orbit-x)] translate-y-[var(--orbit-y)]`;
  const satelliteClosed = `${orbitClosed} group-focus-within/companion:translate-x-[var(--orbit-x)] group-focus-within/companion:translate-y-[var(--orbit-y)] group-hover/companion:translate-x-[var(--orbit-x)] group-hover/companion:translate-y-[var(--orbit-y)]`;
  // The controls orbit on the side of the avatar that faces the room.
  const facing = placement.start ? 1 : -1;
  // Beside the avatar on the side that faces the room, level with it so nothing above or
  // below is pushed away:
  // how loud and how fast the role is heard.
  const beside = (side: 'near' | 'far', row: 'upper' | 'lower') =>
    ({
      '--orbit-x': `${(side === 'near' ? facing : -facing) * 64.5}px`,
      '--orbit-y': `${row === 'upper' ? -21.6 : 21.6}px`,
    }) as CSSProperties;
  return (
    <div
      ref={placeRoot}
      data-testid="pbl-companion"
      data-below={placement.below || undefined}
      data-side={placement.start ? 'start' : 'end'}
      style={placement.style}
      className={cn(
        // What the avatar carries hangs from its outer edge and reaches toward the room.
        'pointer-events-none absolute z-[40] flex w-[400px] max-w-[calc(100%-1rem)] gap-2',
        placement.start
          ? 'items-start [&>*:not([data-avatar])]:me-0 [&>*:not([data-avatar])]:ms-6'
          : 'items-end',
        placement.below ? 'flex-col-reverse' : 'flex-col',
      )}
    >
      {notice && !historyOpen && (
        <div
          data-testid="pbl-companion-notice"
          className="pointer-events-auto me-6 w-full shrink-0 overflow-hidden rounded-2xl border bg-background shadow-xl"
        >
          {notice}
        </div>
      )}
      {speech && !historyOpen && !bubbleAway && (
        <div
          data-testid="pbl-companion-speech"
          className="pointer-events-auto me-6 w-full shrink-0"
          // With a card under it the bubble keeps to a few lines, read by scrolling: the two
          // together must leave the avatar where it is.
          style={task ? ({ '--bubble-room': '7.5rem' } as CSSProperties) : undefined}
        >
          {speech}
        </div>
      )}
      {/* Put away with the bubble, like everything else the avatar carries. */}
      {task && !historyOpen && !bubbleAway && (
        <div
          data-testid="pbl-companion-task"
          // The one thing that gives way when room is short: it takes what is left and scrolls
          // within it, so nothing else is squeezed and the avatar is never pushed out.
          className="pointer-events-auto me-6 min-h-24 w-full shrink overflow-y-auto rounded-2xl border bg-background p-4 text-sm shadow-xl"
        >
          {task}
        </div>
      )}
      {canChat &&
        !historyOpen &&
        // Put away with the bubble they answer; they come back with it.
        !bubbleAway &&
        !active &&
        suggestions.length > 1 && (
          <div
            className="pointer-events-auto me-6 w-full shrink-0"
            data-testid="pbl-companion-suggestions"
          >
            <SuggestedReplies
              labels={suggestions}
              disabled={disabled || speechActive}
              onPick={onSend}
              avatar={DEFAULT_USER_AVATAR}
              full
              className="shadow-[0_18px_50px_-24px_rgba(88,28,135,0.45)]"
            />
          </div>
        )}
      {/* The learner's turn: the classroom's input under the bubble, to type or to speak. */}
      {answering && (
        <div
          ref={inputRoot}
          data-testid="pbl-companion-input"
          // Above the bubble's shadow, which would otherwise grey the top of the box.
          className="pointer-events-auto relative z-10 me-6 w-full shrink-0"
        >
          <LearnerComposer
            key={view.id}
            id={inputId}
            text={text}
            onTextChange={onTextChange}
            speechActive={speechActive}
            onSpeechActiveChange={onSpeechActiveChange}
            onSend={() => onSend(text)}
            // While the role has the floor the send button stops it, as in the conversation.
            busy={active}
            onStop={onStop}
            sending={sending}
            disabled={disabled}
            voice
            compact
            // A light lift of its own; the bubble above casts the heavy shadow.
            className="shadow-[0_6px_20px_-12px_rgba(15,23,42,0.35)]"
          />
        </div>
      )}
      {continueLabel && onContinue && !historyOpen && !bubbleAway && (
        <button
          type="button"
          data-testid="pbl-companion-continue"
          className="pbl-stage-action pointer-events-auto me-6 flex h-9 max-w-full shrink-0 items-center gap-2 rounded-full border px-4 text-xs font-semibold shadow-md transition-colors disabled:cursor-not-allowed"
          data-state={disabled ? 'disabled' : 'ready'}
          disabled={disabled}
          aria-busy={continuing}
          onClick={onContinue}
        >
          {continuing && <LoaderCircle size={13} className="shrink-0 animate-spin" />}
          <span className="truncate">{continueLabel}</span>
          <ArrowRight size={15} className="shrink-0 rtl:-scale-x-100" aria-hidden="true" />
        </button>
      )}
      {/* The ring around the avatar already shows progress. Its wording and the two ways to
          answer orbit the avatar, and come out when the learner reaches for it. */}
      <div
        data-avatar
        className={cn(
          // Over the input and the bubble: what opens from the controls is never behind them.
          'group/companion relative z-20 size-[76px] shrink-0',
          placement.below ? 'mb-4 mt-4' : 'mt-4',
          placement.start ? 'ms-6' : 'me-6',
        )}
      >
        {!historyOpen && (
          <div data-testid="pbl-companion-controls" data-open={controlsOpen || undefined}>
            {/* Four of a kind, two on each side of the avatar. */}
            <span
              data-testid="pbl-companion-mute"
              aria-pressed={muted}
              style={beside('near', 'upper')}
              className={cn(
                orbit,
                round,
                'left-1/2 top-1/2 -ml-[18px] -mt-[18px]',
                controlsOpen ? satelliteOpen : satelliteClosed,
              )}
            >
              <VolumeControl
                muted={muted}
                volume={volume}
                onToggleMute={() => setMuted(!muted)}
                onVolumeChange={setVolume}
                buttonClassName="flex size-9 items-center justify-center rounded-full"
                iconClassName="size-4"
                // Out toward the room, level with the button: nothing the avatar carries is there.
                side={placement.start ? 'right' : 'left'}
              />
            </span>
            <button
              type="button"
              data-testid="pbl-companion-speed"
              style={beside('near', 'lower')}
              className={cn(
                orbit,
                round,
                'left-1/2 top-1/2 -ml-[18px] -mt-[18px] text-[11px] font-semibold tabular-nums',
                controlsOpen ? satelliteOpen : satelliteClosed,
              )}
              aria-label={t('pblV3.board.speed', { speed })}
              title={t('pblV3.board.speed', { speed })}
              onClick={() =>
                setSpeed(
                  PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(speed) + 1) % PLAYBACK_SPEEDS.length],
                )
              }
            >
              {speed}x
            </button>
          </div>
        )}
        {/* One label for the whole ring: it names the segment the pointer rests on. */}
        <AnimatePresence>
          {hoveredStep !== null && progress.steps[hoveredStep] && (
            <motion.span
              role="tooltip"
              data-testid="pbl-companion-step"
              initial={{ opacity: 0, y: 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 2, scale: 0.98 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              className={cn(
                'pointer-events-none absolute z-20 flex items-center gap-1.5 whitespace-nowrap rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-[0_8px_24px_-10px_rgba(15,23,42,0.35)]',
                // Above the avatar; with the avatar high in the workspace, beyond its controls.
                placement.below
                  ? cn(
                      'top-1/2 -translate-y-1/2',
                      placement.start ? 'start-full ms-[60px]' : 'end-full me-[60px]',
                    )
                  : cn('bottom-full mb-3', placement.start ? 'start-0' : 'end-0'),
              )}
            >
              <span className="font-semibold tabular-nums" style={{ color: persona.color }}>
                {hoveredStep + 1}/{progress.total}
              </span>
              <span className="font-medium">
                {t(`pblV3.journey.steps.${progress.steps[hoveredStep].label}`)}
              </span>
              {hoveredStep === progress.current - 1 && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t('pblV3.journey.taskTitle')}
                </span>
              )}
              <span
                className={cn(
                  'absolute -bottom-[5px] size-2 rotate-45 border-b border-r bg-background',
                  placement.below && 'hidden',
                  placement.start ? 'start-8' : 'end-8',
                )}
              />
            </motion.span>
          )}
        </AnimatePresence>
        <button
          type="button"
          data-testid="pbl-companion-avatar"
          data-busy={view.busy || undefined}
          data-dragging={placement.dragging || undefined}
          onPointerDown={placement.onPointerDown}
          // The picture inside is not something to drag out of the page.
          onDragStart={(event) => event.preventDefault()}
          className="pointer-events-auto relative size-[76px] cursor-grab touch-none select-none rounded-full bg-background shadow-lg transition-transform dark:bg-slate-700 dark:ring-1 dark:ring-white/15 hover:scale-105 data-[dragging]:scale-110 data-[dragging]:cursor-grabbing data-[dragging]:shadow-2xl"
          aria-label={t(historyOpen ? 'pblV3.board.collapse' : 'pblV3.board.dock')}
          aria-pressed={historyOpen}
          title={`${t(`pblV3.personas.${role}`)} · ${t(`pblV3.roles.${role}`)}`}
          onClick={() => {
            if (bubbleAway && !historyOpen && onShowBubble) onShowBubble();
            else onToggleHistory();
          }}
        >
          <ProgressRing
            total={progress.total}
            current={progress.current}
            color={persona.color}
            hovered={hoveredStep}
            onHover={setHoveredStep}
            onOpen={onOpenTask}
          />
          <span
            className="absolute inset-[9px] overflow-hidden rounded-full bg-muted"
            style={{ '--tw-ring-color': persona.color } as CSSProperties}
          >
            <AvatarDisplay src={persona.avatar} alt="" />
          </span>
        </button>
      </div>
    </div>
  );
}
