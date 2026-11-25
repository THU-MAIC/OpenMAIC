'use client';

import { useRef, useState } from 'react';
import { VolumeControl, VolumeIcon } from './volume-control';
import {
  CircleStop,
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  PencilLine,
  Presentation,
  LayoutList,
  PanelRightClose,
  PanelRightOpen,
  Repeat,
  Maximize2,
  Minimize2,
  Quote,
  FoldVertical,
  UnfoldVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useSoftCloseCountdown } from '@/components/chat/use-soft-close-countdown';

export interface CanvasToolbarProps {
  readonly sessionType?: 'qa' | 'discussion';
  readonly onMobileBack?: () => void;
  readonly mobile?: boolean;
  readonly currentSceneIndex: number;
  readonly scenesCount: number;
  readonly engineState: 'idle' | 'playing' | 'paused';
  readonly isLiveSession?: boolean;
  readonly isSoftClosing?: boolean;
  readonly softCloseDeadline?: number;
  readonly whiteboardOpen: boolean;
  readonly sidebarCollapsed?: boolean;
  readonly chatCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
  readonly onToggleChat?: () => void;
  readonly onPrevSlide: () => void;
  readonly onNextSlide: () => void;
  readonly onPlayPause: () => void;
  readonly onWhiteboardClose: () => void;
  readonly showStopDiscussion?: boolean;
  readonly onStopDiscussion?: () => void;
  readonly onContinueDiscussion?: () => void;
  readonly isPresenting?: boolean;
  readonly onTogglePresentation?: () => void;
  readonly className?: string;
  // Audio/playback controls
  readonly ttsEnabled?: boolean;
  readonly ttsMuted?: boolean;
  readonly ttsVolume?: number;
  readonly onToggleMute?: () => void;
  readonly onVolumeChange?: (volume: number) => void;
  readonly autoPlayLecture?: boolean;
  readonly onToggleAutoPlay?: () => void;
  readonly playbackSpeed?: number;
  readonly onCycleSpeed?: () => void;
  readonly showElementReference?: boolean;
  readonly canPickSlideElement?: boolean;
  readonly elementPickActive?: boolean;
  readonly onToggleElementPick?: () => void;
  /** Next on the last page opens the course's end state, so it is not a dead end. */
  readonly nextOpensEnd?: boolean;
  /** The dock's fold, where the toolbar sits in a dock. */
  readonly dockCollapsed?: boolean;
  readonly onToggleDock?: () => void;
}

/* Compact control button */
export const ctrlBtn = cn(
  'relative w-7 h-7 rounded-md flex items-center justify-center',
  'transition-all duration-150 outline-none cursor-pointer',
  'hover:bg-gray-500/[0.08] dark:hover:bg-gray-400/[0.08] active:scale-90',
);

/* Subtle separator */
export function CtrlDivider() {
  return <div className="w-px h-3 bg-gray-200/80 dark:bg-gray-700/60 mx-0.5 shrink-0" />;
}

export function CanvasToolbar({
  mobile = false,
  currentSceneIndex,
  scenesCount,
  engineState,
  isLiveSession,
  isSoftClosing,
  softCloseDeadline,
  whiteboardOpen,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onPlayPause,
  onWhiteboardClose,
  showStopDiscussion,
  sessionType,
  onStopDiscussion,
  onContinueDiscussion,
  isPresenting,
  onTogglePresentation,
  className,
  ttsEnabled,
  ttsMuted,
  ttsVolume = 1,
  onToggleMute,
  onVolumeChange,
  autoPlayLecture,
  onToggleAutoPlay,
  playbackSpeed = 1,
  onCycleSpeed,
  showElementReference,
  canPickSlideElement,
  elementPickActive,
  onToggleElementPick,
  nextOpensEnd,
  dockCollapsed,
  onToggleDock,
}: CanvasToolbarProps) {
  const { t } = useI18n();
  const remainingSoftCloseSeconds = useSoftCloseCountdown(softCloseDeadline);
  const canGoPrev = currentSceneIndex > 0;
  const canGoNext = currentSceneIndex < scenesCount - 1 || !!nextOpensEnd;
  const showPlayPause = !isLiveSession;
  const showSceneNavigation =
    (scenesCount > 1 || !!nextOpensEnd) && !(mobile && showStopDiscussion && onStopDiscussion);

  const whiteboardElementCount = useStageStore(
    (s) => s.stage?.whiteboard?.[0]?.elements?.length || 0,
  );

  // The mobile toolbar opens a touch-friendly settings dialog.
  const mobileVolumeTrigger = useRef<HTMLButtonElement>(null);
  const [volumeHover, setVolumeHover] = useState(false);
  const [volumeDialogContainer, setVolumeDialogContainer] = useState<HTMLElement | null>(null);
  const endLabel = t(mobile && sessionType === 'qa' ? 'chat.endQA' : 'roundtable.stopDiscussion');
  const presentationLabel = isPresenting ? t('stage.exitFullscreen') : t('stage.fullscreen');

  return (
    <div
      data-mobile-toolbar={mobile || undefined}
      className={cn('flex items-center gap-2', className)}
    >
      {/* ── Left: sidebar toggle + page indicator ── */}
      <div className="flex items-center gap-1 shrink-0 pl-1">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              sidebarCollapsed
                ? 'text-gray-400 dark:text-gray-500'
                : 'text-gray-600 dark:text-gray-300',
            )}
            aria-expanded={!sidebarCollapsed}
            title={t(sidebarCollapsed ? 'edit.nav.expand' : 'edit.nav.collapse')}
            aria-label={t(sidebarCollapsed ? 'edit.nav.expand' : 'edit.nav.collapse')}
          >
            <LayoutList className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums select-none font-medium">
          {currentSceneIndex + 1}
          <span className="opacity-35 mx-px">/</span>
          {scenesCount}
        </span>
      </div>

      <CtrlDivider />

      {/* ── Center: unified playback controls ── */}
      <div className="flex-1 flex items-center justify-center min-w-0">
        <div
          className={cn(
            'inline-flex items-center gap-0.5 px-1 h-7',
            isPresenting
              ? '' /* Single visual layer in fullscreen — buttons sit inside outer pill directly */
              : 'bg-gray-100/60 dark:bg-gray-800/60 rounded-lg',
          )}
        >
          {/* Volume with vertical popover slider */}
          {onToggleMute && !mobile && (
            <VolumeControl
              muted={!!ttsMuted}
              volume={ttsVolume}
              enabled={!!ttsEnabled}
              onToggleMute={onToggleMute}
              onVolumeChange={onVolumeChange}
              buttonClassName={cn(ctrlBtn, 'w-6 h-6')}
            />
          )}
          {onToggleMute && mobile && (
            <div data-toolbar-control="volume" className="relative flex items-center">
              <button
                ref={mobileVolumeTrigger}
                onClick={(event) => {
                  setVolumeDialogContainer(
                    event.currentTarget.closest<HTMLElement>('[data-classroom-stage]'),
                  );
                  setVolumeHover((open) => !open);
                }}
                className={cn(
                  ctrlBtn,
                  'w-6 h-6',
                  !ttsEnabled
                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                    : ttsMuted
                      ? 'text-red-500 dark:text-red-400'
                      : 'text-gray-500 dark:text-gray-400',
                )}
                aria-label={t('mobileClassroom.volume')}
                aria-expanded={volumeHover}
                aria-haspopup={'dialog'}
              >
                <VolumeIcon muted={!!ttsMuted} volume={ttsVolume} disabled={!ttsEnabled} />
              </button>

              <Dialog open={volumeHover} onOpenChange={setVolumeHover}>
                <DialogContent
                  container={volumeDialogContainer}
                  className="mobile-sound-settings z-[400] w-[calc(100vw-32px)] max-w-[340px] max-h-[calc(100dvh-32px)] overflow-y-auto rounded-2xl p-5 gap-5"
                  overlayClassName="z-[399] bg-black/30 backdrop-blur-sm"
                  aria-describedby={undefined}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    mobileVolumeTrigger.current?.focus();
                  }}
                >
                  <DialogTitle className="text-lg font-semibold pe-10">
                    {t('mobileClassroom.soundSettings')}
                  </DialogTitle>
                  <label className="flex min-h-11 items-center gap-3">
                    <span>{t('mobileClassroom.volume')}</span>
                    <input
                      type="range"
                      aria-label={t('mobileClassroom.volume')}
                      disabled={!ttsEnabled}
                      min={0}
                      max={1}
                      step={0.05}
                      value={ttsVolume}
                      onChange={(event) => onVolumeChange?.(parseFloat(event.target.value))}
                      className="min-w-0 flex-1 accent-violet-600"
                    />
                    <span className="w-10 text-end tabular-nums">
                      {Math.round(ttsVolume * 100)}%
                    </span>
                  </label>
                  <label className="flex min-h-11 items-center justify-between gap-4">
                    <span>{t('mobileClassroom.playSound')}</span>
                    <input
                      type="checkbox"
                      className="size-5 accent-violet-600"
                      disabled={!ttsEnabled}
                      checked={!!ttsEnabled && !ttsMuted}
                      onChange={onToggleMute}
                    />
                  </label>
                  {onToggleAutoPlay && (
                    <label className="flex min-h-11 items-center justify-between gap-4">
                      <span>{t('roundtable.autoPlay')}</span>
                      <input
                        type="checkbox"
                        className="size-5 accent-violet-600"
                        checked={!!autoPlayLecture}
                        onChange={onToggleAutoPlay}
                      />
                    </label>
                  )}
                </DialogContent>
              </Dialog>
            </div>
          )}

          {/* Speed */}
          {onCycleSpeed && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    data-toolbar-control="speed"
                    onClick={onCycleSpeed}
                    className={cn(
                      'w-8 h-5 rounded flex items-center justify-center',
                      'transition-all duration-150 outline-none cursor-pointer',
                      'text-[11px] font-semibold tabular-nums leading-none',
                      'active:scale-90',
                      playbackSpeed !== 1
                        ? 'text-violet-600 dark:text-violet-400 bg-violet-500/10 dark:bg-violet-400/10'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
                    )}
                    aria-label="Playback speed"
                  >
                    {playbackSpeed === 1.5 ? '1.5x' : `${playbackSpeed}x`}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('roundtable.speed')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <CtrlDivider />

          {/* Prev scene */}
          {showSceneNavigation && (
            <button
              data-toolbar-control="previous"
              onClick={onPrevSlide}
              disabled={!canGoPrev}
              className={cn(
                ctrlBtn,
                'w-6 h-6 text-gray-500 dark:text-gray-400 disabled:opacity-20 disabled:pointer-events-none',
              )}
              aria-label="Previous scene"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Play / Pause / Stop Discussion */}
          {showStopDiscussion && onStopDiscussion ? (
            <div data-toolbar-control="discussion" className="flex items-center gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStopDiscussion();
                }}
                className={cn(
                  'flex items-center gap-1.5 h-6 px-2.5 rounded-md',
                  'bg-red-500/10 dark:bg-red-400/10 text-red-600 dark:text-red-400',
                  'text-[11px] font-semibold whitespace-nowrap',
                  'hover:bg-red-500/20 dark:hover:bg-red-400/20 active:scale-95 transition-all cursor-pointer',
                )}
                title={endLabel}
                data-discussion-action="end"
              >
                {mobile ? (
                  <CircleStop aria-hidden />
                ) : (
                  <span className="inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
                )}
                <span data-discussion-label>{endLabel}</span>
              </button>
              {isSoftClosing && onContinueDiscussion && (
                <button
                  data-discussion-action="continue"
                  onClick={(e) => {
                    e.stopPropagation();
                    onContinueDiscussion();
                  }}
                  className="flex items-center gap-1.5 h-6 px-2.5 rounded-md border border-purple-200 dark:border-purple-700 bg-white/70 dark:bg-gray-800/70 text-purple-600 dark:text-purple-300 text-[11px] font-semibold whitespace-nowrap hover:bg-purple-50 dark:hover:bg-purple-900/20 active:scale-95 transition-all cursor-pointer"
                  title={t('roundtable.softClosing')}
                >
                  <span data-discussion-label>{t('roundtable.softClosing')}</span>
                  {remainingSoftCloseSeconds !== undefined && (
                    <span className="text-[9px] font-medium tabular-nums text-gray-400 dark:text-gray-500">
                      {remainingSoftCloseSeconds}s
                    </span>
                  )}
                </button>
              )}
            </div>
          ) : showPlayPause ? (
            <button
              data-toolbar-control="play"
              onClick={onPlayPause}
              className={cn(
                ctrlBtn,
                'w-7 h-6',
                engineState === 'playing'
                  ? 'text-violet-600 dark:text-violet-400'
                  : 'text-gray-500 dark:text-gray-400',
              )}
              aria-label={engineState === 'playing' ? 'Pause' : 'Play'}
            >
              {engineState === 'playing' ? (
                <Pause className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5 ml-px" />
              )}
            </button>
          ) : null}

          {/* Next scene */}
          {showSceneNavigation && (
            <button
              data-toolbar-control="next"
              onClick={onNextSlide}
              disabled={!canGoNext}
              className={cn(
                ctrlBtn,
                'w-6 h-6 text-gray-500 dark:text-gray-400 disabled:opacity-20 disabled:pointer-events-none',
              )}
              aria-label="Next scene"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}

          <CtrlDivider />

          {/* Auto-play */}
          {!mobile && onToggleAutoPlay && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onToggleAutoPlay}
                    className={cn(
                      ctrlBtn,
                      'w-8 h-6',
                      autoPlayLecture
                        ? 'text-violet-600 dark:text-violet-400'
                        : 'text-gray-500 dark:text-gray-400',
                    )}
                    aria-label="Auto-play"
                  >
                    <Repeat className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {autoPlayLecture ? t('roundtable.autoPlayOff') : t('roundtable.autoPlay')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Whiteboard */}
          <button
            data-toolbar-control="whiteboard"
            onClick={(e) => {
              e.stopPropagation();
              onWhiteboardClose();
            }}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              whiteboardOpen
                ? 'text-violet-600 dark:text-violet-400'
                : 'text-gray-500 dark:text-gray-400',
            )}
            title={whiteboardOpen ? t('whiteboard.minimize') : t('whiteboard.open')}
            aria-label={whiteboardOpen ? t('whiteboard.minimize') : t('whiteboard.open')}
          >
            {mobile ? (
              <Presentation className="w-3.5 h-3.5" />
            ) : (
              <PencilLine className="w-3.5 h-3.5" />
            )}
            {!whiteboardOpen && whiteboardElementCount > 0 && (
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-violet-500 dark:bg-violet-400 rounded-full" />
            )}
          </button>

          {!mobile && showElementReference && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleElementPick?.();
              }}
              disabled={!canPickSlideElement}
              className={cn(
                'relative flex h-6 w-6 items-center justify-center rounded-md transition-all',
                elementPickActive
                  ? 'bg-violet-500/15 text-violet-700 ring-1 ring-violet-400/40 dark:text-violet-300'
                  : 'text-gray-500 hover:bg-gray-500/[0.08] dark:text-gray-400',
                !canPickSlideElement && 'cursor-not-allowed opacity-35',
              )}
              aria-label={t('chat.elementReference.button')}
              aria-pressed={elementPickActive}
              title={
                canPickSlideElement
                  ? t('chat.elementReference.button')
                  : t('chat.elementReference.unavailable')
              }
            >
              <Quote className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Right: dock fold, fullscreen, then the chat toggle at the edge ── */}
      <div className="flex items-center justify-end gap-px shrink-0 pr-1">
        <CtrlDivider />
        {onToggleDock && (
          <button
            type="button"
            data-testid="dock-fold"
            aria-expanded={!dockCollapsed}
            onClick={onToggleDock}
            className={cn(ctrlBtn, 'w-6 h-6 text-gray-500 dark:text-gray-400')}
            aria-label={t(dockCollapsed ? 'stage.dock.expand' : 'stage.dock.collapse')}
            title={t(dockCollapsed ? 'stage.dock.expand' : 'stage.dock.collapse')}
          >
            {dockCollapsed ? (
              <UnfoldVertical className="w-3.5 h-3.5" />
            ) : (
              <FoldVertical className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {!mobile && onTogglePresentation && (
          <button
            onClick={onTogglePresentation}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              isPresenting
                ? 'text-violet-600 dark:text-violet-400'
                : 'text-gray-500 dark:text-gray-400',
            )}
            aria-label={presentationLabel}
            title={presentationLabel}
          >
            {isPresenting ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {onToggleChat && (
          <button
            onClick={onToggleChat}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              chatCollapsed
                ? 'text-gray-400 dark:text-gray-500'
                : 'text-gray-600 dark:text-gray-300',
            )}
            aria-label={t(chatCollapsed ? 'stage.chatPanel.expand' : 'stage.chatPanel.collapse')}
            title={t(chatCollapsed ? 'stage.chatPanel.expand' : 'stage.chatPanel.collapse')}
          >
            {/* A panel, not a speech bubble: the bubble is the classroom's own
                type-to-speak control, and the two must not read as one. */}
            {chatCollapsed ? (
              <PanelRightOpen className="w-3.5 h-3.5" />
            ) : (
              <PanelRightClose className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
