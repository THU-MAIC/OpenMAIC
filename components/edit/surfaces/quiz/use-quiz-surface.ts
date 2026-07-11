'use client';

import { Plus } from 'lucide-react';
import React, { useEffect } from 'react';
import type { EditorHint, InsertPaletteItem, SurfaceState } from '@/lib/edit/scene-editor-surface';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { QuizContent, QuizQuestionType } from '@/lib/types/stage';
import {
  addOption,
  addQuestion,
  deleteOption,
  deleteQuestion,
  isChoice,
  reorderOptions,
  reorderQuestions,
  setQuestionType,
  toggleCorrect,
  updateOptionLabel,
  updateQuestion,
} from './quiz-edit-ops';
import { useQuizEditSession } from './quiz-edit-session';
import { AddQuestionMenu } from './AddQuestionMenu';

/**
 * The quiz form is a self-contained structured editor: it owns its own
 * expansion state internally and contributes no canvas-style selection to the
 * chrome. `undefined` is the honest selection type.
 */
export type QuizSelection = undefined;

const EMPTY_QUIZ: QuizContent = { type: 'quiz', questions: [] };

function currentQuizContent(sceneId: string): QuizContent | null {
  const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
  return scene && scene.type === 'quiz' ? (scene.content as QuizContent) : null;
}

/** The working content: in-memory session present, else the canonical scene, else empty. */
function resolvePresent(): QuizContent {
  const { history, sceneId } = useQuizEditSession.getState();
  return history?.present ?? (sceneId ? currentQuizContent(sceneId) : null) ?? EMPTY_QUIZ;
}

// ---------------------------------------------------------------------------
// Bound mutations. Each reads `present` via getState (a stable module closure,
// never a per-render capture) so the EditShell's `surfaceStateEqual` — which
// does NOT compare callbacks — stays correct without special-casing.
//
// `commit`  = discrete edit → its own undo step.
// `commitText` = coalesced text edit → consecutive same-key edits fold into
//                one step (typing a field), while every keystroke writes
//                through to the store.
// ---------------------------------------------------------------------------

type QuestionTextPatch = Parameters<typeof updateQuestion>[2];

export function addQuizQuestion(type: QuizQuestionType): void {
  useQuizEditSession.getState().commit(addQuestion(resolvePresent(), type));
}
export function deleteQuizQuestion(id: string): void {
  useQuizEditSession.getState().commit(deleteQuestion(resolvePresent(), id));
}
export function reorderQuizQuestions(orderedIds: readonly string[]): void {
  useQuizEditSession.getState().commit(reorderQuestions(resolvePresent(), orderedIds));
}
export function setQuizQuestionType(id: string, type: QuizQuestionType): void {
  useQuizEditSession.getState().commit(setQuestionType(resolvePresent(), id, type));
}
/** Coalesced text/number patch (question / analysis / commentPrompt / points). */
export function typeQuizQuestion(id: string, patch: QuestionTextPatch, coalesceKey: string): void {
  useQuizEditSession
    .getState()
    .commitText(updateQuestion(resolvePresent(), id, patch), coalesceKey);
}
export function addQuizOption(id: string): void {
  useQuizEditSession.getState().commit(addOption(resolvePresent(), id));
}
export function deleteQuizOption(id: string, index: number): void {
  useQuizEditSession.getState().commit(deleteOption(resolvePresent(), id, index));
}
export function typeQuizOptionLabel(id: string, index: number, label: string): void {
  useQuizEditSession
    .getState()
    .commitText(updateOptionLabel(resolvePresent(), id, index, label), `${id}:opt:${index}`);
}
export function reorderQuizOptions(id: string, from: number, to: number): void {
  useQuizEditSession.getState().commit(reorderOptions(resolvePresent(), id, from, to));
}
export function toggleQuizCorrect(id: string, index: number): void {
  useQuizEditSession.getState().commit(toggleCorrect(resolvePresent(), id, index));
}

export function buildQuizInsertItems(t: (k: string) => string): InsertPaletteItem[] {
  return [
    {
      id: 'add-question',
      label: t('edit.quiz.addQuestion'),
      tooltip: t('edit.quiz.addQuestion'),
      icon: React.createElement(Plus, { className: 'h-4 w-4' }),
      onInvoke: () => {}, // popover-only: InsertButton ignores onInvoke when popoverContent is set
      popoverContent: () => React.createElement(AddQuestionMenu),
    },
  ];
}

/** Max validation hints shown at once so the HintRail stays readable. */
const MAX_HINTS = 5;

/**
 * Authoring validation surfaced through the chrome's reserved `hints` slot:
 * one hint per problematic question (highest-priority issue only), so the
 * author sees what still needs fixing before the quiz is playable. A choice
 * question with no correct answer is a warning (it always scores incorrect in
 * playback); blank text / options are gentler suggestions.
 */
export function buildQuizHints(
  content: QuizContent,
  t: (k: string, o?: Record<string, unknown>) => string,
): EditorHint[] {
  const hints: EditorHint[] = [];
  content.questions.forEach((q, i) => {
    if (hints.length >= MAX_HINTS) return;
    const n = i + 1;
    const choice = isChoice(q.type);
    let issue: { severity: EditorHint['severity']; key: string } | null = null;
    if (!q.question.trim()) {
      issue = { severity: 'suggestion', key: 'emptyText' };
    } else if (choice && (q.options?.length ?? 0) < 2) {
      issue = { severity: 'warning', key: 'fewOptions' };
    } else if (choice && (q.options ?? []).some((o) => !o.label.trim())) {
      issue = { severity: 'suggestion', key: 'emptyOption' };
    } else if (choice && (q.answer?.length ?? 0) === 0) {
      issue = { severity: 'warning', key: 'noCorrect' };
    }
    if (issue) {
      hints.push({
        id: q.id,
        severity: issue.severity,
        message: t(`edit.quiz.hint.${issue.key}`, { n }),
      });
    }
  });
  return hints;
}

/**
 * The resolved quiz content the form reads: in-memory session present (once
 * seeded, ref-stable until a commit), else the canonical stage scene as a
 * pre-seed fallback, else an empty quiz.
 */
export function useResolvedQuizContent(): QuizContent {
  const history = useQuizEditSession((s) => s.history);
  // Fall back to the canonical current quiz scene so the form has its content
  // on the very first render — before the session seeds in an effect. (`seed`
  // adopts this exact object, so the ref is stable across the seed and the
  // chrome's `surfaceStateEqual` doesn't see a spurious change.) Reading it
  // from the stage store also keeps the form's question-id set stable from the
  // first populated render, so the "auto-expand a newly added question" logic
  // in QuizForm doesn't fire for the seeded questions.
  const sceneContent = useStageStore((s) => {
    const scene = s.scenes.find((x) => x.id === s.currentSceneId) ?? null;
    return scene && scene.type === 'quiz' ? (scene.content as QuizContent) : null;
  });
  return history?.present ?? sceneContent ?? EMPTY_QUIZ;
}

/**
 * The quiz surface's `useSurfaceState`. Pure read over the shared session
 * store. No selection model, no floating actions — the structured form owns
 * all of its editing affordances inline; the chrome only contributes the
 * "Add question" insert item and undo/redo.
 */
export function useQuizSurfaceState(): SurfaceState<QuizContent, QuizSelection> {
  const { t } = useI18n();
  const history = useQuizEditSession((s) => s.history);
  const content = useResolvedQuizContent();

  return {
    content,
    selection: undefined,
    hasSelection: false,
    history: {
      canUndo: !!history && history.past.length > 0,
      canRedo: !!history && history.future.length > 0,
      undo: () => useQuizEditSession.getState().undo(),
      redo: () => useQuizEditSession.getState().redo(),
    },
    insertItems: buildQuizInsertItems(t),
    floatingActions: [],
    commands: [],
    hints: buildQuizHints(content, t),
  };
}

/**
 * Seeds the quiz-edit session from the active quiz scene and tears it down on
 * exit — mirrors `useSlideCanvasController`'s lifecycle, minus the canvas /
 * gesture tracking. Used by QuizForm (the SurfaceComponent). Returns the
 * resolved quiz scene id ('' when the current scene isn't a quiz).
 */
export function useQuizSurfaceLifecycle(): string {
  const sceneId = useStageStore((s) => {
    const scene = s.scenes.find((x) => x.id === s.currentSceneId) ?? null;
    return scene && scene.type === 'quiz' ? scene.id : '';
  });

  useEffect(() => {
    if (!sceneId) return;
    const content = currentQuizContent(sceneId);
    if (content && useQuizEditSession.getState().sceneId !== sceneId) {
      useQuizEditSession.getState().seed(sceneId, content);
    }
  }, [sceneId]);

  useEffect(() => () => useQuizEditSession.getState().end(), []);

  return sceneId;
}
