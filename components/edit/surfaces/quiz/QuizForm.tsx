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
    <div
      className="h-full w-full overflow-y-auto bg-zinc-50/40 dark:bg-zinc-950/30"
      data-testid="quiz-surface"
      // Faint dot grid gives the authoring canvas a subtle texture so the
      // white question cards read as floating sheets rather than flat boxes.
      style={{
        backgroundImage: 'radial-gradient(circle, rgba(113,113,122,0.10) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-2.5 px-5 pb-20 pt-16">
        {questions.length === 0 ? (
          <EmptyState />
        ) : (
          <Reorder.Group
            axis="y"
            as="ol"
            values={questions.map((q) => q.id)}
            onReorder={reorderQuizQuestions}
            className="m-0 flex list-none flex-col gap-2.5 p-0"
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
    <div className="mt-20 flex flex-col items-center gap-3 text-center" data-testid="quiz-empty">
      <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-100 to-violet-50 text-violet-500 shadow-[0_8px_24px_-12px_rgba(114,46,209,0.5)] dark:from-violet-500/20 dark:to-violet-500/5 dark:text-violet-300">
        <ListChecks className="h-7 w-7" strokeWidth={1.75} />
      </div>
      <p className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
        {t('edit.quiz.empty')}
      </p>
      <p className="max-w-xs text-xs text-zinc-400 dark:text-zinc-500">
        {t('edit.quiz.emptyHint')}
      </p>
    </div>
  );
}
