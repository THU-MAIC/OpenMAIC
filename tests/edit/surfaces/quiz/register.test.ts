import { describe, it, expect } from 'vitest';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { buildQuizInsertItems } from '@/components/edit/surfaces/quiz/use-quiz-surface';
// Importing the surface index runs its side-effect registration.
import { quizSurface } from '@/components/edit/surfaces/quiz';

describe('quiz surface registration', () => {
  it('registers itself under scene type "quiz"', () => {
    const resolved = sceneEditorRegistry.resolve('quiz');
    expect(resolved).toBe(quizSurface);
    expect(resolved?.sceneType).toBe('quiz');
    expect(resolved?.SurfaceComponent).toBeTypeOf('function');
    expect(resolved?.useSurfaceState).toBeTypeOf('function');
  });

  it('contributes a single "Add question" insert item (identity translator)', () => {
    const items = buildQuizInsertItems((k) => k);
    expect(items.map((i) => i.id)).toEqual(['add-question']);
    expect(items[0].popoverContent).toBeTypeOf('function');
  });
});
