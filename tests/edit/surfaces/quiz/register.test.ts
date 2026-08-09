import { describe, it, expect } from 'vitest';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
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
});
