'use client';

import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Eye,
  Info,
  Loader2,
  Mic,
  MicOff,
  MonitorUp,
  PencilLine,
  Send,
  SwitchCamera,
  VideoOff,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCanvasStore, useStageStore } from '@/lib/store';
import { useModelSettingsView } from '@/lib/model-settings/use-model-settings';
import { getCameraTutorCapabilities } from '@/lib/live-tutor/model-capabilities';
import { applyWhiteboardOps, buildWhiteboardFromSteps } from '@/lib/live-tutor/whiteboard-elements';
import type { WhiteboardOp, WhiteboardStepItem } from '@/lib/live-tutor/types';
import { useLiveCameraTutor } from './use-live-camera-tutor';
import { cn } from '@/lib/utils';

interface InlineQACameraPreviewProps {
  readonly open: boolean;
  /** Controls visibility without unmounting the active tutor session (defaults to true). */
  readonly visible?: boolean;
  readonly onClose: () => void;
  /** When true, renders embedded inside the right sidebar tab instead of a floating overlay. */
  readonly embedded?: boolean;
  /** Optional portal host element (e.g. desktop sidebar Camera tab slot) so one instance survives layout switches. */
  readonly portalTarget?: HTMLElement | null;
  /** Pauses classroom lecture/discussion audio when Gemini Live starts. */
  readonly onActivateLive?: () => void;
  /** Latest spoken/typed classroom Q&A lines for shared conversational context. */
  readonly recentClassroomSpeech?: string;
}

function collectVisibleChatTranscript(): string {
  if (typeof document === 'undefined') return '';
  try {
    // Capture recent visible Q&A messages from the classroom chat panel if open
    const chatNodes = document.querySelectorAll(
      '[data-chat-message], [data-testid="chat-message"]',
    );
    if (chatNodes.length > 0) {
      return Array.from(chatNodes)
        .slice(-8)
        .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .slice(-1400);
    }
  } catch {
    // ignore DOM read issues
  }
  return '';
}

function InlineQACameraLiveBody({
  visible = true,
  onClose,
  embedded = false,
  portalTarget = null,
  onActivateLive,
  recentClassroomSpeech,
}: Omit<InlineQACameraPreviewProps, 'open'>) {
  const { t, locale } = useI18n();
  const stageId = useStageStore((s) => s.stage?.id);
  const stageName = useStageStore((s) => s.stage?.name);
  const currentScene = useStageStore((s) => s.getCurrentScene());
  const modelView = useModelSettingsView();
  const caps = getCameraTutorCapabilities(modelView);

  const [wbSteps, setWbSteps] = useState<WhiteboardStepItem[]>([]);
  const [textQuestion, setTextQuestion] = useState('');

  const sceneContext = useMemo(() => {
    const parts: string[] = [];
    if (stageName) parts.push(`Course: ${stageName}`);
    if (currentScene?.title) parts.push(`Current slide: ${currentScene.title}`);
    if (currentScene?.type === 'quiz' && 'questions' in currentScene.content) {
      const q = currentScene.content.questions?.[0];
      if (q?.question) parts.push(`Current quiz question: ${q.question}`);
    }
    if (recentClassroomSpeech?.trim()) {
      parts.push(`Recent classroom conversation:\n${recentClassroomSpeech.trim()}`);
    }
    const domTranscript = collectVisibleChatTranscript();
    if (domTranscript) {
      parts.push(`Classroom Q&A transcript:\n${domTranscript}`);
    }
    return parts.join('\n\n');
  }, [currentScene, recentClassroomSpeech, stageName]);

  const syncStepsToClassroomWhiteboard = useCallback(
    (nextSteps: WhiteboardStepItem[], clearedByTutor: boolean) => {
      if (!stageId) return;
      useCanvasStore.setState((prev) => {
        const sameStageProjection =
          prev.runtimeWhiteboardProjection?.stageId === stageId
            ? prev.runtimeWhiteboardProjection
            : null;
        const rawProjected = sameStageProjection
          ? sameStageProjection.whiteboard
          : useStageStore.getState().stage?.whiteboard;
        const currentProjected = Array.isArray(rawProjected) ? rawProjected[0] : rawProjected;
        const preservedElements = clearedByTutor
          ? []
          : (currentProjected?.elements ?? []).filter((el) => !el.id.startsWith('lt-wb-'));

        // Always retain existing classroom elements (unless clear_whiteboard was called)
        // and append tutor steps cleanly below them, expanding the sheet ratio if needed.
        let occupiedBottom = 0;
        for (const el of preservedElements) {
          const elHeight = 'height' in el && typeof el.height === 'number' ? el.height : 40;
          occupiedBottom = Math.max(occupiedBottom, el.top + elHeight);
        }
        const startY = occupiedBottom > 0 ? occupiedBottom + 16 : undefined;
        const tutorWb = buildWhiteboardFromSteps(
          nextSteps,
          `classroom-live-wb-${stageId}`,
          startY,
        );

        return {
          whiteboardOpen: true,
          runtimeWhiteboardProjection: {
            stageId,
            // Use -1 on fresh boards (first durable runtime record is seq 0) so
            // getDisplayedWhiteboard() treats it as authoritative (-1 !== null)
            // without ever claiming Pi's seq 0 or N+1.
            lastSeq: sameStageProjection?.lastSeq ?? -1,
            whiteboard: {
              ...tutorWb,
              elements: [...preservedElements, ...tutorWb.elements],
            },
          },
          runtimeWhiteboardProjectionGeneration: prev.runtimeWhiteboardProjectionGeneration + 1,
        };
      });
    },
    [stageId],
  );

  const handleWhiteboardOps = useCallback(
    (ops: WhiteboardOp[]) => {
      const clearedByTutor = ops.some((o) => o.op === 'clear');
      setWbSteps((prev) => {
        const next = applyWhiteboardOps(prev, ops);
        syncStepsToClassroomWhiteboard(next, clearedByTutor);
        return next;
      });
    },
    [syncStepsToClassroomWhiteboard],
  );

  const {
    videoRef,
    canvasRef,
    status,
    transportMode,
    errorMessage,
    micMuted,
    camPaused,
    videoSource,
    micLevel,
    liveCaption,
    turnBusy,
    canShareScreen,
    startSession,
    stopSession,
    sendStudentTurn,
    toggleMic,
    toggleCam,
    flipCamera,
    toggleScreenShare,
  } = useLiveCameraTutor({
    topic: currentScene?.title || stageName,
    sceneContext,
    whiteboardStepsText: wbSteps.map((s) => s.content),
    language: locale,
    onWhiteboardOps: handleWhiteboardOps,
  });

  const isLive = status === 'live';
  const isConnecting = status === 'connecting';

  const handleStart = (source: 'camera' | 'screen' = 'camera') => {
    onActivateLive?.();
    void startSession({ source });
  };

  const handleClose = () => {
    stopSession();
    onClose();
  };

  const handleSendText = () => {
    if (turnBusy) return;
    const trimmed = textQuestion.trim();
    if (!trimmed) return;
    setTextQuestion('');
    void sendStudentTurn(trimmed);
  };

  const card = (
    <div
      data-testid="inline-qa-camera-preview"
      className={cn(
        'flex flex-col overflow-hidden',
        !visible && 'hidden',
        embedded
          ? 'h-full min-h-0 rounded-2xl border border-violet-200/70 dark:border-violet-800/60 bg-gray-950/95 shadow-sm'
          : 'fixed bottom-24 left-4 z-[60] w-[min(350px,calc(100vw-32px))] rounded-2xl border border-violet-300/70 dark:border-violet-700/70 bg-gray-950/95 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55)] backdrop-blur-xl',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-black/50 border-b border-white/10 shrink-0">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-semibold truncate',
            isLive ? 'text-emerald-300' : 'text-violet-300',
          )}
        >
          <span
            className={cn(
              'size-2 rounded-full shrink-0',
              isLive ? 'bg-emerald-400 animate-pulse' : 'bg-violet-400',
            )}
          />
          {isLive
            ? transportMode === 'gemini-live'
              ? t('liveTutor.settingsBadgeLive')
              : t('liveTutor.settingsBadgeSnapshot')
            : t('liveTutor.classroomTitle')}
        </span>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              const { whiteboardOpen, setWhiteboardOpenManually } = useCanvasStore.getState();
              setWhiteboardOpenManually(!whiteboardOpen);
            }}
            title={t('liveTutor.toggleWhiteboard')}
            className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
          >
            <PencilLine className="size-3.5" />
          </button>
          {!embedded && (
            <button
              type="button"
              onClick={handleClose}
              title={t('common.close')}
              className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Camera Viewport */}
      <div
        className={cn(
          'relative bg-gray-950 flex items-center justify-center overflow-hidden',
          embedded ? 'flex-1 min-h-[220px]' : 'aspect-[4/3]',
        )}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={cn(
            'w-full h-full object-cover',
            !isLive && 'hidden',
            camPaused && 'opacity-30',
          )}
        />
        <canvas ref={canvasRef} className="hidden" />

        {!isLive && (
          <div className="flex flex-col items-center justify-center text-center px-5 py-4">
            <div className="size-10 rounded-2xl bg-violet-500/20 text-violet-300 flex items-center justify-center mb-2">
              <Camera className="size-5" />
            </div>
            <p className="text-xs font-semibold text-white mb-1">
              {t('liveTutor.cameraPlaceholderTitle')}
            </p>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              {t('liveTutor.cameraPlaceholderDesc')}
            </p>
          </div>
        )}

        {/* Mic level meter when Gemini Live is active */}
        {isLive && transportMode === 'gemini-live' && (
          <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 rounded-full bg-black/65 backdrop-blur-md px-2.5 py-1 border border-white/10 pointer-events-none">
            <Mic className="size-3 text-emerald-400" />
            <div className="w-10 h-1.5 rounded-full bg-gray-700 overflow-hidden">
              <div
                className="h-full bg-emerald-400 transition-all duration-75"
                style={{ width: `${micLevel}%` }}
              />
            </div>
          </div>
        )}

        {/* Live caption overlay */}
        {isLive && liveCaption && (
          <div className="absolute bottom-2.5 left-2.5 right-2.5 rounded-xl bg-black/80 backdrop-blur-md border border-white/10 px-3 py-2 text-[11px] text-gray-100 max-h-20 overflow-y-auto leading-snug">
            {liveCaption}
          </div>
        )}
      </div>

      {/* Capability notices & errors */}
      {errorMessage && (
        <p className="px-3 py-1.5 text-[11px] text-red-300 bg-red-950/60 border-t border-red-500/30">
          {errorMessage}
        </p>
      )}
      {!caps.supportsVision && (
        <div className="flex items-start gap-1.5 px-3 py-1.5 bg-amber-950/80 border-t border-amber-500/30 text-[10px] text-amber-200 leading-snug">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-amber-400" />
          <span>{t('liveTutor.visionUnsupportedWarning')}</span>
        </div>
      )}
      {caps.supportsVision &&
        (transportMode === 'turn-based' ||
          (!isLive && caps.providerPreset && !caps.supportsLiveStreaming)) && (
          <div className="flex items-start gap-1.5 px-3 py-1.5 bg-slate-900/90 border-t border-white/10 text-[10px] text-gray-300 leading-snug">
            <Info className="size-3.5 shrink-0 mt-0.5 text-violet-400" />
            <span>{t('liveTutor.snapshotModeNotice')}</span>
          </div>
        )}

      {/* Controls */}
      <div className="p-2.5 bg-black/60 border-t border-white/10 space-y-2">
        {!isLive ? (
          isConnecting ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="inline-qa-start-live-button"
                disabled
                className="flex-1 h-9 rounded-xl bg-violet-600/80 text-white text-xs font-semibold inline-flex items-center justify-center gap-2"
              >
                <Loader2 className="size-4 animate-spin" />
                {t('liveTutor.connecting')}
              </button>
              <button
                type="button"
                onClick={stopSession}
                title={t('liveTutor.stopSession')}
                className="h-9 px-3 rounded-xl bg-red-600/85 hover:bg-red-600 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
              >
                <VideoOff className="size-3.5" />
                {t('liveTutor.stopSession')}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="inline-qa-start-live-button"
                onClick={() => handleStart('camera')}
                className="flex-1 h-9 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
              >
                <Camera className="size-4" />
                {t('liveTutor.startCameraHelp')}
              </button>
              {canShareScreen && (
                <button
                  type="button"
                  onClick={() => handleStart('screen')}
                  title={t('liveTutor.shareSlide')}
                  aria-label={t('liveTutor.shareSlide')}
                  className="h-9 px-2.5 rounded-xl border border-white/15 bg-white/10 text-white hover:bg-white/20 flex items-center justify-center transition-colors shrink-0"
                >
                  <MonitorUp className="size-4" />
                </button>
              )}
            </div>
          )
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="inline-qa-camera-check-button"
                disabled={turnBusy}
                onClick={() => void sendStudentTurn()}
                className="flex-1 h-8 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
              >
                {turnBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Eye className="size-3.5" />
                )}
                {t('liveTutor.checkWork')}
              </button>
              {transportMode === 'gemini-live' && (
                <button
                  type="button"
                  onClick={toggleMic}
                  title={micMuted ? t('liveTutor.unmuteMic') : t('liveTutor.muteMic')}
                  className={cn(
                    'size-8 rounded-xl border flex items-center justify-center transition-colors',
                    micMuted
                      ? 'border-red-400/60 bg-red-500/20 text-red-300'
                      : 'border-white/15 bg-white/10 text-white hover:bg-white/20',
                  )}
                >
                  {micMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                </button>
              )}
              <button
                type="button"
                onClick={toggleCam}
                title={camPaused ? t('liveTutor.resumeCamera') : t('liveTutor.pauseCamera')}
                className={cn(
                  'size-8 rounded-xl border flex items-center justify-center transition-colors',
                  camPaused
                    ? 'border-amber-400/60 bg-amber-500/20 text-amber-300'
                    : 'border-white/15 bg-white/10 text-white hover:bg-white/20',
                )}
              >
                {camPaused ? (
                  <CameraOff className="size-3.5" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void flipCamera()}
                title={t('liveTutor.flipCamera')}
                className="size-8 rounded-xl border border-white/15 bg-white/10 text-white hover:bg-white/20 flex items-center justify-center transition-colors"
              >
                <SwitchCamera className="size-3.5" />
              </button>
              {canShareScreen && (
                <button
                  type="button"
                  onClick={() => void toggleScreenShare()}
                  title={t('liveTutor.shareSlide')}
                  aria-label={t('liveTutor.shareSlide')}
                  className={cn(
                    'size-8 rounded-xl border flex items-center justify-center transition-colors',
                    videoSource === 'screen'
                      ? 'border-violet-400/70 bg-violet-500/30 text-violet-200'
                      : 'border-white/15 bg-white/10 text-white hover:bg-white/20',
                  )}
                >
                  <MonitorUp className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={stopSession}
                title={t('liveTutor.stopSession')}
                className="size-8 rounded-xl bg-red-600/85 hover:bg-red-600 text-white flex items-center justify-center transition-colors"
              >
                <VideoOff className="size-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={textQuestion}
                disabled={turnBusy}
                onChange={(e) => setTextQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !turnBusy) handleSendText();
                }}
                placeholder={t('liveTutor.askPlaceholder')}
                className="flex-1 h-8 rounded-xl border border-white/15 bg-white/10 px-2.5 text-[11px] text-white placeholder:text-gray-400 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-violet-400"
              />
              <button
                type="button"
                disabled={!textQuestion.trim() || turnBusy}
                onClick={handleSendText}
                aria-label={t('liveTutor.sendQuestion')}
                className="size-8 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white flex items-center justify-center shrink-0 transition-colors"
              >
                <Send className="size-3.5" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (portalTarget) return createPortal(card, portalTarget);
  if (embedded) return card;
  return createPortal(card, document.body);
}

/**
 * Classroom Gemini Live Camera & Voice Tutor panel. Renders embedded inside
 * the right-hand sidebar Camera tab on desktop/tablet, or as a floating
 * overlay on narrow mobile portrait screens.
 */
export function InlineQACameraPreview(props: InlineQACameraPreviewProps) {
  if (!props.open) return null;
  if (!props.embedded && !props.portalTarget && typeof document === 'undefined') return null;
  return <InlineQACameraLiveBody {...props} />;
}
