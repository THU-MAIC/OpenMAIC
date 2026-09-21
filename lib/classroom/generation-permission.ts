'use client';

/**
 * One answer to "may this browser start generation for this course?", shared by
 * every surface and every affordance that could spend the operator's provider
 * budget.
 *
 * The resume effect is not the only way generation starts: a Retry button on a
 * failed image, or the retry of a whole outline, calls the same providers. A
 * gate that lived only in the resume effect would leave those open, so the
 * permission lives here instead — recorded per course by whichever surface
 * asked the stage-meta sidecar, and read both by the components that decide
 * whether to render a retry affordance and by the functions those affordances
 * call. Render condition and action precondition are then the same value.
 *
 * Fail closed: a course nobody has recorded an answer for is `'unresolved'`,
 * which refuses under server-backed persistence. Browser-only mode has one
 * viewer who is by construction the author, so every answer permits.
 */

import { create } from 'zustand';

import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';

import {
  mayStartOwnerGeneration,
  type ClassroomGenerationOwnership,
} from './stage-ownership-signal';

interface GenerationPermissionState {
  readonly byStage: Readonly<Record<string, ClassroomGenerationOwnership>>;
}

const useGenerationPermissionStore = create<GenerationPermissionState>(() => ({ byStage: {} }));

/** Record what the sidecar said about this course, for every consumer at once. */
export function noteStageGenerationOwnership(
  stageId: string,
  ownership: ClassroomGenerationOwnership,
): void {
  useGenerationPermissionStore.setState((state) =>
    state.byStage[stageId] === ownership
      ? state
      : { byStage: { ...state.byStage, [stageId]: ownership } },
  );
}

function ownershipOf(stageId: string | undefined): ClassroomGenerationOwnership {
  if (!stageId) return 'unresolved';
  return useGenerationPermissionStore.getState().byStage[stageId] ?? 'unresolved';
}

/** Reactive ownership for a course, for components that branch on it. */
export function useStageGenerationOwnership(
  stageId: string | undefined,
): ClassroomGenerationOwnership {
  return useGenerationPermissionStore((state) =>
    stageId ? (state.byStage[stageId] ?? 'unresolved') : 'unresolved',
  );
}

/** Imperative gate, for the functions a generation affordance calls. */
export function mayGenerateForStage(stageId: string | undefined): boolean {
  return mayStartOwnerGeneration(isServerBackedMediaPersistence(), ownershipOf(stageId));
}

/** Reactive gate, for the components that decide whether to offer generation. */
export function useMayGenerateForStage(stageId: string | undefined): boolean {
  const ownership = useStageGenerationOwnership(stageId);
  return mayStartOwnerGeneration(isServerBackedMediaPersistence(), ownership);
}

/** @internal Test-only reset. */
export function resetGenerationPermissionsForTests(): void {
  useGenerationPermissionStore.setState({ byStage: {} });
}
