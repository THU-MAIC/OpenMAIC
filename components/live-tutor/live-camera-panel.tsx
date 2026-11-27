'use client';

import { useState } from 'react';
import {
  Camera,
  CameraOff,
  CheckCircle2,
  Eye,
  Lightbulb,
  Loader2,
  Mic,
  MicOff,
  MonitorUp,
  RefreshCw,
  Send,
  Sparkles,
  SwitchCamera,
  VideoOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { renderSafeLatexHtml } from '@/lib/live-tutor/whiteboard-elements';
import type { PracticeProblem, WhiteboardOp } from '@/lib/live-tutor/types';
import { useLiveCameraTutor } from './use-live-camera-tutor';

interface LiveCameraPanelProps {
  readonly topic?: string;
  readonly problem?: PracticeProblem | null;
  readonly sceneContext?: string;
  readonly whiteboardStepsText?: string[];
  readonly onWhiteboardOps?: (ops: WhiteboardOp[]) => void;
  readonly onProblemAssigned?: (problem: PracticeProblem) => void;
  readonly className?: string;
  readonly compact?: boolean;
}

export function LiveCameraPanel({
  topic,
  problem,
  sceneContext,
  whiteboardStepsText,
  onWhiteboardOps,
  onProblemAssigned,
  className,
  compact = false,
}: LiveCameraPanelProps) {
  const { t, locale } = useI18n();
  const [showHint, setShowHint] = useState(false);
  const [textQuestion, setTextQuestion] = useState('');

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
    generatePracticeProblem,
    toggleMic,
    toggleCam,
    flipCamera,
    toggleScreenShare,
  } = useLiveCameraTutor({
    topic,
    problem,
    sceneContext,
    whiteboardStepsText,
    language: locale,
    onWhiteboardOps,
    onProblemAssigned,
  });

  const isLive = status === 'live';
  const isConnecting = status === 'connecting';

  const handleSendText = () => {
    const trimmed = textQuestion.trim();
    if (!trimmed) return;
    setTextQuestion('');
    void sendStudentTurn(trimmed);
  };

  return (
    <div className={cn('flex flex-col h-full min-h-0 gap-3', className)}>
      {/* Assigned Practice Problem Card */}
      <div className="rounded-2xl border border-violet-200/70 dark:border-violet-800/60 bg-violet-50/60 dark:bg-violet-950/25 p-3.5 shrink-0">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
            <Sparkles className="size-3.5" />
            {t('liveTutor.assignedProblem')}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={turnBusy}
            onClick={() => void generatePracticeProblem()}
            className="h-7 px-2.5 text-xs gap-1 rounded-lg"
          >
            {turnBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {problem ? t('liveTutor.newProblem') : t('liveTutor.assignProblem')}
          </Button>
        </div>

        {problem ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 leading-relaxed">
              {problem.statement}
            </p>
            {problem.formulaLatex && (
              <div
                className="overflow-x-auto rounded-xl bg-white/80 dark:bg-gray-900/60 px-3 py-2 text-sm"
                dangerouslySetInnerHTML={{
                  __html: renderSafeLatexHtml(problem.formulaLatex, false),
                }}
              />
            )}
            {problem.hint && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowHint((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400 hover:underline"
                >
                  <Lightbulb className="size-3.5" />
                  {showHint ? t('liveTutor.hideHint') : t('liveTutor.showHint')}
                </button>
                {showHint && (
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 bg-amber-50/80 dark:bg-amber-950/30 rounded-lg px-2.5 py-1.5">
                    {problem.hint}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('liveTutor.noProblemPrompt')}
          </p>
        )}
      </div>

      {/* Camera Viewport */}
      <div
        className={cn(
          'relative flex-1 min-h-[200px] rounded-2xl overflow-hidden bg-gray-950 border border-gray-200 dark:border-gray-800 flex items-center justify-center',
          compact ? 'max-h-[300px]' : '',
        )}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={cn('w-full h-full object-cover', !isLive && 'hidden')}
        />
        <canvas ref={canvasRef} className="hidden" />

        {!isLive && (
          <div className="flex flex-col items-center justify-center text-center px-6 py-8">
            <div className="size-12 rounded-2xl bg-violet-500/15 text-violet-400 flex items-center justify-center mb-3">
              <Camera className="size-6" />
            </div>
            <h4 className="text-sm font-semibold text-white mb-1">
              {t('liveTutor.cameraPlaceholderTitle')}
            </h4>
            <p className="text-xs text-gray-400 max-w-xs leading-relaxed">
              {t('liveTutor.cameraPlaceholderDesc')}
            </p>
          </div>
        )}

        {/* Live Status + Mic Meter Pill */}
        {isLive && (
          <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/65 backdrop-blur-md px-2.5 py-1 text-[11px] font-medium text-emerald-300 border border-white/10">
              <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
              {videoSource === 'screen'
                ? t('liveTutor.watchingSlide')
                : t('liveTutor.watchingNotebook')}
            </span>
            {transportMode === 'gemini-live' && (
              <div className="flex items-center gap-1.5 rounded-full bg-black/65 backdrop-blur-md px-2.5 py-1 border border-white/10">
                <Mic className="size-3 text-emerald-400" />
                <div className="w-10 h-1.5 rounded-full bg-gray-700 overflow-hidden">
                  <div
                    className="h-full bg-emerald-400 transition-all duration-75"
                    style={{ width: `${micLevel}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Live Caption Overlay */}
        {isLive && liveCaption && (
          <div className="absolute bottom-3 left-3 right-3 rounded-xl bg-black/75 backdrop-blur-md border border-white/10 px-3 py-2 text-xs text-gray-100 max-h-24 overflow-y-auto">
            {liveCaption}
          </div>
        )}
      </div>

      {errorMessage && (
        <p className="text-xs text-red-600 dark:text-red-400 px-1">{errorMessage}</p>
      )}

      {/* Primary Camera & Voice Controls */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {!isLive ? (
          <Button
            type="button"
            disabled={isConnecting}
            onClick={() => void startSession()}
            className="flex-1 h-10 rounded-xl bg-violet-600 hover:bg-violet-700 text-white gap-2"
          >
            {isConnecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Camera className="size-4" />
            )}
            {isConnecting ? t('liveTutor.connecting') : t('liveTutor.startCameraHelp')}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              disabled={turnBusy}
              onClick={() => void sendStudentTurn()}
              className="flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            >
              {turnBusy ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
              {t('liveTutor.checkWork')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={stopSession}
              className="h-10 px-3 rounded-xl gap-1.5"
            >
              <VideoOff className="size-4" />
              {t('liveTutor.stopSession')}
            </Button>
          </>
        )}

        {isLive && (
          <div className="flex items-center gap-1.5 w-full sm:w-auto justify-end">
            {transportMode === 'gemini-live' && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={toggleMic}
                title={micMuted ? t('liveTutor.unmuteMic') : t('liveTutor.muteMic')}
                className={cn(
                  'size-10 rounded-xl',
                  micMuted && 'border-red-400 text-red-500 bg-red-50 dark:bg-red-950/30',
                )}
              >
                {micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={toggleCam}
              title={camPaused ? t('liveTutor.resumeCamera') : t('liveTutor.pauseCamera')}
              className={cn('size-10 rounded-xl', camPaused && 'border-amber-400 text-amber-500')}
            >
              {camPaused ? <CameraOff className="size-4" /> : <CheckCircle2 className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void flipCamera()}
              title={t('liveTutor.flipCamera')}
              className="size-10 rounded-xl"
            >
              <SwitchCamera className="size-4" />
            </Button>
            {canShareScreen && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void toggleScreenShare()}
                title={t('liveTutor.shareSlide')}
                className={cn(
                  'size-10 rounded-xl',
                  videoSource === 'screen' &&
                    'border-violet-500 text-violet-600 bg-violet-50 dark:bg-violet-950/30',
                )}
              >
                <MonitorUp className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Optional Typed Question Input (works in both Live & Turn-Based modes) */}
      {isLive && (
        <div className="flex items-center gap-2 shrink-0">
          <input
            type="text"
            value={textQuestion}
            onChange={(e) => setTextQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSendText();
            }}
            placeholder={t('liveTutor.askPlaceholder')}
            className="flex-1 h-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
          />
          <Button
            type="button"
            size="icon"
            disabled={!textQuestion.trim() || turnBusy}
            onClick={handleSendText}
            className="size-10 rounded-xl bg-violet-600 hover:bg-violet-700 text-white shrink-0"
            aria-label={t('liveTutor.sendQuestion')}
          >
            <Send className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
