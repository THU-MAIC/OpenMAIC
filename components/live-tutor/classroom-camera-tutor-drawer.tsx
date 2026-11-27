'use client';

import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Minimize2, PencilLine } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore, useCanvasStore } from '@/lib/store';
import { applyWhiteboardOps, buildWhiteboardFromSteps } from '@/lib/live-tutor/whiteboard-elements';
import type { PracticeProblem, WhiteboardOp, WhiteboardStepItem } from '@/lib/live-tutor/types';
import { LiveCameraPanel } from './live-camera-panel';

interface ClassroomCameraTutorDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ClassroomCameraTutorDrawer({
  open,
  onOpenChange,
}: ClassroomCameraTutorDrawerProps) {
  const { t } = useI18n();
  const stageId = useStageStore((s) => s.stage?.id);
  const stageName = useStageStore((s) => s.stage?.name);
  const currentScene = useStageStore((s) => s.getCurrentScene());

  const [problem, setProblem] = useState<PracticeProblem | null>(null);
  const [wbSteps, setWbSteps] = useState<WhiteboardStepItem[]>([]);

  const sceneContext = useMemo(() => {
    if (!currentScene) return stageName ?? '';
    const parts: string[] = [];
    if (stageName) parts.push(`Course: ${stageName}`);
    if (currentScene.title) parts.push(`Current scene: ${currentScene.title}`);
    if (currentScene.type === 'quiz' && 'questions' in currentScene.content) {
      const q = currentScene.content.questions?.[0];
      if (q?.question) parts.push(`Current quiz question: ${q.question}`);
    }
    return parts.join('\n');
  }, [currentScene, stageName]);

  const syncStepsToClassroomWhiteboard = useCallback(
    (nextSteps: WhiteboardStepItem[]) => {
      if (!stageId) return;
      const wb = buildWhiteboardFromSteps(nextSteps);
      useCanvasStore.setState((prev) => ({
        whiteboardOpen: true,
        runtimeWhiteboardProjection: {
          stageId,
          lastSeq: (prev.runtimeWhiteboardProjection?.lastSeq ?? 0) + 1,
          whiteboard: wb,
        },
        runtimeWhiteboardProjectionGeneration: prev.runtimeWhiteboardProjectionGeneration + 1,
      }));
    },
    [stageId],
  );

  const handleWhiteboardOps = useCallback(
    (ops: WhiteboardOp[]) => {
      setWbSteps((prev) => {
        const next = applyWhiteboardOps(prev, ops);
        syncStepsToClassroomWhiteboard(next);
        return next;
      });
    },
    [syncStepsToClassroomWhiteboard],
  );

  const [everOpened, setEverOpened] = useState(false);
  if (open && !everOpened) {
    setEverOpened(true);
  }
  if (!everOpened && !open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <aside
      data-testid="classroom-camera-tutor-drawer"
      className={`fixed top-4 right-4 bottom-4 z-[60] w-[min(420px,calc(100vw-32px))] rounded-3xl bg-white/95 dark:bg-gray-900/95 backdrop-blur-2xl border border-violet-200/70 dark:border-violet-800/60 shadow-[0_24px_70px_-16px_rgba(0,0,0,0.3)] flex flex-col overflow-hidden transition-all duration-200 ${
        open
          ? 'opacity-100 translate-x-0 pointer-events-auto'
          : 'opacity-0 translate-x-8 pointer-events-none'
      }`}
    >
      <div className="h-13 px-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="size-8 rounded-xl bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 flex items-center justify-center shrink-0">
            <Camera className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">
              {t('liveTutor.classroomTitle')}
            </h3>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => useCanvasStore.setState((s) => ({ whiteboardOpen: !s.whiteboardOpen }))}
            className="p-2 rounded-lg text-gray-500 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/30 transition-colors"
            title={t('liveTutor.toggleWhiteboard')}
          >
            <PencilLine className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title={t('common.close')}
          >
            <Minimize2 className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-4 overflow-y-auto">
        <LiveCameraPanel
          topic={currentScene?.title || stageName}
          problem={problem}
          sceneContext={sceneContext}
          whiteboardStepsText={wbSteps.map((s) => s.content)}
          onWhiteboardOps={handleWhiteboardOps}
          onProblemAssigned={setProblem}
          compact
        />
      </div>
    </aside>,
    document.body,
  );
}
