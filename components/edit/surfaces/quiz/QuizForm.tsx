'use client';

import { Reorder } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { QuestionCard } from './QuestionCard';
import {
  reorderQuizQuestions,
  useQuizSurfaceLifecycle,
  useResolvedQuizContent,
} from './use-quiz-surface';

/**
 * The quiz `SceneEditorSurface` center component — a single-column accordion
 * of question cards. Self-contained: owns its expansion state, seeds/tears
 * down the quiz-edit session, and dispatches every edit through the bound
 * mutations in `use-quiz-surface`. Renders inside the EditShell's studio-frame
 * card (full height, own scroll) and contributes no canvas-style selection.
 *
 * "Add question" lives in the chrome's FloatingInsertToolbar (the
 * `add-question` insert item), mirroring how the slide surface surfaces its
 * Text / Image inserts — so it isn't duplicated here.
 */
export function QuizForm() {
  useQuizSurfaceLifecycle();
  const content = useResolvedQuizContent();
  const questions = content.questions;

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Auto-expand a question added DURING the session: when exactly one new id
  // appears since the last render, open it (and collapse whatever was open).
  // `prevIds` is seeded null and baselined on the first run so the questions
  // already present at mount don't count as "added" (no surprise expansion).
  const prevIds = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = questions.map((q) => q.id);
    if (prevIds.current === null) {
      prevIds.current = ids;
      return;
    }
    const added = ids.filter((id) => !prevIds.current!.includes(id));
    if (added.length === 1) setExpandedId(added[0]);
    prevIds.current = ids;
  }, [questions]);

  return (
    <div className="h-full w-full overflow-y-auto" data-testid="quiz-surface">
      <div className="mx-auto flex max-w-2xl flex-col gap-2 px-4 pb-16 pt-16">
        {questions.length === 0 ? (
          <EmptyState />
        ) : (
          <Reorder.Group
            axis="y"
            as="ol"
            values={questions.map((q) => q.id)}
            onReorder={reorderQuizQuestions}
            className="m-0 flex list-none flex-col gap-2 p-0"
          >
            {questions.map((q, index) => (
              <QuestionCard
                key={q.id}
                question={q}
                index={index}
                expanded={expandedId === q.id}
                onToggle={() => setExpandedId((id) => (id === q.id ? null : q.id))}
              />
            ))}
          </Reorder.Group>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  const { t } = useI18n();
  return (
    <div
      className="mt-16 flex flex-col items-center gap-2 text-center text-zinc-400 dark:text-zinc-500"
      data-testid="quiz-empty"
    >
      <ListChecks className="h-10 w-10 opacity-50" />
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{t('edit.quiz.empty')}</p>
      <p className="text-xs">{t('edit.quiz.emptyHint')}</p>
    </div>
  );
}
