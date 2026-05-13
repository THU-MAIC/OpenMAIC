'use client';

import { useMemo } from 'react';
import type { Scene, StageMode } from '@/lib/types/stage';
import { SlideEditor as SlideRenderer } from '../slide-renderer/Editor';
import { QuizView } from '../scene-renderers/quiz-view';
import { InteractiveRenderer } from '../scene-renderers/interactive-renderer';
import { PBLRenderer } from '../scene-renderers/pbl-renderer';
import { EditShell } from '@/components/edit/EditShell';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { useI18n } from '@/lib/hooks/use-i18n';

interface SceneRendererProps {
  readonly scene: Scene;
  readonly mode: StageMode;
  readonly sidebarCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
}

export function SceneRenderer({
  scene,
  mode,
  sidebarCollapsed,
  onToggleSidebar,
}: SceneRendererProps) {
  const { t } = useI18n();

  const renderer = useMemo(() => {
    // Edit (Pro) mode: defer rendering to a registered SceneEditorSurface, or
    // show a friendly fallback when no surface is registered for this scene
    // type. Surfaces are wired up by later PRs (slide first); the shell only
    // depends on the registry contract from #561.
    if (mode === 'edit') {
      const sceneTypeLabel = t(`edit.sceneType.${scene.type}`);
      const surface = sceneEditorRegistry.resolve(scene.type);
      if (!surface) {
        return (
          <div className="flex h-full w-full items-center justify-center bg-zinc-50 text-sm text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
            {t('edit.unsupportedScene', { type: sceneTypeLabel })}
          </div>
        );
      }
      return (
        <EditShell
          surface={surface}
          title={t('edit.title', { type: sceneTypeLabel })}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
        />
      );
    }

    switch (scene.type) {
      case 'slide':
        if (scene.content.type !== 'slide') return <div>Invalid slide content</div>;
        return <SlideRenderer mode={mode} />;
      case 'quiz':
        if (scene.content.type !== 'quiz') return <div>Invalid quiz content</div>;
        return <QuizView key={scene.id} questions={scene.content.questions} sceneId={scene.id} />;
      case 'interactive':
        if (scene.content.type !== 'interactive') return <div>Invalid interactive content</div>;
        return <InteractiveRenderer content={scene.content} sceneId={scene.id} />;
      case 'pbl':
        if (scene.content.type !== 'pbl') return <div>Invalid PBL content</div>;
        return <PBLRenderer content={scene.content} mode={mode} sceneId={scene.id} />;
      default:
        return <div>Unknown scene type</div>;
    }
  }, [scene, mode, t, sidebarCollapsed, onToggleSidebar]);

  return <div className="w-full h-full">{renderer}</div>;
}
