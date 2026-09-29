'use client';

import { useMemo } from 'react';
import type { Scene, StageMode } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { findQuizRenderingIssue, type QuizRenderingIssue } from '@/lib/quiz/validation';
import { SlideEditor as SlideRenderer } from '../slide-renderer/Editor';
import { QuizView } from '../scene-renderers/quiz-view';
import { InteractiveRenderer } from '../scene-renderers/interactive-renderer';
import { PBLRenderer } from '../scene-renderers/pbl-renderer';

interface SceneRendererProps {
  readonly scene: Scene;
  readonly mode: StageMode;
}

type Translator = (key: string, options?: Record<string, unknown>) => string;

function translateQuizRenderingIssue(issue: QuizRenderingIssue, t: Translator): string {
  switch (issue.code) {
    case 'missing-question-id':
      return t('quiz.invalidContent.missingQuestionId', {
        question: issue.question,
      });
    case 'duplicate-question-id':
      return t('quiz.invalidContent.duplicateQuestionId', {
        question: issue.question,
        value: issue.value,
      });
    case 'missing-options':
      return t('quiz.invalidContent.missingOptions', {
        question: issue.question,
      });
    case 'missing-option-value':
      return t('quiz.invalidContent.missingOptionValue', {
        question: issue.question,
        option: issue.option,
      });
    case 'duplicate-option-value':
      return t('quiz.invalidContent.duplicateOptionValue', {
        question: issue.question,
        value: issue.value,
      });
  }
}

/**
 * Playback scene dispatcher. In Pro (edit) mode, Stage renders EditShell
 * directly as a top-level takeover — SceneRenderer is only on the playback
 * path, so it does not branch on `mode === 'edit'`.
 */
export function SceneRenderer({ scene, mode }: SceneRendererProps) {
  const { t } = useI18n();

  const renderer = useMemo(() => {
    switch (scene.type) {
      case 'slide':
        if (scene.content.type !== 'slide') return <div>Invalid slide content</div>;
        return <SlideRenderer mode={mode} />;

      case 'quiz': {
        if (scene.content.type !== 'quiz') return <div>Invalid quiz content</div>;

        const renderingIssue = findQuizRenderingIssue(scene.content.questions);
        if (renderingIssue) {
          return (
            <div className="flex h-full w-full items-center justify-center p-8">
              <div className="max-w-lg rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                <p className="font-semibold">{t('quiz.invalidContent.title')}</p>
                <p className="mt-2 text-sm">{translateQuizRenderingIssue(renderingIssue, t)}</p>
              </div>
            </div>
          );
        }

        return (
          <QuizView
            key={scene.id}
            questions={scene.content.questions}
            sceneId={scene.id}
            stageId={scene.stageId}
          />
        );
      }

      case 'interactive':
        if (scene.content.type !== 'interactive') return <div>Invalid interactive content</div>;
        return <InteractiveRenderer content={scene.content} sceneId={scene.id} />;

      case 'pbl':
        if (scene.content.type !== 'pbl') return <div>Invalid PBL content</div>;
        return <PBLRenderer content={scene.content} mode={mode} sceneId={scene.id} />;

      default:
        return <div>Unknown scene type</div>;
    }
  }, [scene, mode, t]);

  return <div className="w-full h-full">{renderer}</div>;
}
