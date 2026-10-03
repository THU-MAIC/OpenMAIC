/**
 * The run's state machine, as pure functions over what is checkpointed.
 *
 * A run's steps follow the browser's classic order: material analysis (when
 * materials are given) → research → outline → [confirmation] → agents → for
 * each scene in outline order: content → actions → narration (which appends
 * the narrated scene to the course in the same commit, so its clips are never
 * held by a checkpoint alone). The step list is fixed by the input and the
 * confirmed outline; a step whose capability does not resolve (no web search,
 * no server TTS) still runs and checkpoints that it did nothing, so the plan
 * never depends on configuration read at another moment.
 */
import { PERMANENT_MEDIA_FAILURE_CODES } from '@/lib/media/media-failure';
import type { MediaGenerationRequest } from '@/lib/media/types';
import type { SceneOutline } from '@/lib/types/generation';

import type { ExecutableRunState, GenerationRunInput, GenerationRunState } from './types';

/** A scene's narration step also appends it to the course, in the same commit. */
export type SceneStepKind = 'content' | 'actions' | 'narration';

export type RunStep =
  | { id: 'material-analysis'; kind: 'material-analysis' }
  | { id: 'research'; kind: 'research' }
  | { id: 'outline'; kind: 'outline' }
  | { id: 'agents'; kind: 'agents' }
  | { id: string; kind: SceneStepKind; sceneIndex: number };

export const SCENE_STEP_KINDS: readonly SceneStepKind[] = ['content', 'actions', 'narration'];

export function sceneStepId(sceneIndex: number, kind: SceneStepKind): string {
  return `scene:${sceneIndex}:${kind}`;
}

/** The step a step id names, or null for an id no plan produces. */
export function parseStepId(id: string): RunStep | null {
  if (id === 'material-analysis' || id === 'research' || id === 'outline' || id === 'agents') {
    return { id, kind: id } as RunStep;
  }
  const match = /^scene:(\d+):(content|actions|narration)$/.exec(id);
  if (!match) return null;
  return { id, kind: match[2] as SceneStepKind, sceneIndex: Number(match[1]) };
}

/** The steps before the outline is confirmed. */
export function preparationSteps(input: Pick<GenerationRunInput, 'materialIds'>): RunStep[] {
  return [
    ...(input.materialIds.length > 0
      ? [{ id: 'material-analysis', kind: 'material-analysis' } as const]
      : []),
    { id: 'research', kind: 'research' },
    { id: 'outline', kind: 'outline' },
  ];
}

/** The steps after the outline is confirmed, for an outline of `sceneCount` scenes. */
export function generationSteps(sceneCount: number): RunStep[] {
  const steps: RunStep[] = [{ id: 'agents', kind: 'agents' }];
  for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex += 1) {
    for (const kind of SCENE_STEP_KINDS) {
      steps.push({ id: sceneStepId(sceneIndex, kind), kind, sceneIndex });
    }
  }
  return steps;
}

/** The state a run is in while `step` runs. */
export function phaseOfStep(step: RunStep): ExecutableRunState {
  if (step.kind === 'material-analysis' || step.kind === 'research') return 'preparing';
  if (step.kind === 'outline') return 'outlining';
  return 'generating';
}

export type RunAdvance =
  /** Run this step next (the run is in its phase). */
  | { kind: 'step'; step: RunStep; state: ExecutableRunState }
  /** The outline is checkpointed: wait for its confirmation, holding no worker. */
  | { kind: 'await-outline-confirmation' }
  /** Every step is checkpointed. */
  | { kind: 'complete' };

/**
 * What a run does next, from its state and the steps already checkpointed.
 * `sceneCount` is the confirmed outline's length (unused before confirmation).
 */
export function advanceRun(input: {
  state: GenerationRunState;
  runInput: Pick<GenerationRunInput, 'materialIds'>;
  completed: ReadonlySet<string>;
  sceneCount: number;
}): RunAdvance {
  const { state, completed } = input;
  if (state === 'preparing' || state === 'outlining') {
    const next = preparationSteps(input.runInput).find((step) => !completed.has(step.id));
    if (!next) return { kind: 'await-outline-confirmation' };
    return { kind: 'step', step: next, state: phaseOfStep(next) };
  }
  if (state === 'generating') {
    const next = generationSteps(input.sceneCount).find((step) => !completed.has(step.id));
    if (!next) return { kind: 'complete' };
    return { kind: 'step', step: next, state: 'generating' };
  }
  throw new Error(`A run in state ${state} has no step to run`);
}

/** The state `retry` returns a run paused at `stepId` to. */
export function stateForRetry(stepId: string): ExecutableRunState {
  const step = parseStepId(stepId);
  if (!step) throw new Error(`Unknown run step ${JSON.stringify(stepId)}`);
  return phaseOfStep(step);
}

/**
 * The checkpoint of one generated image or video. Media is not a step of the
 * plan: it is generated alongside the scenes (see `./media.ts`), and its
 * checkpoints share the run's step table so a takeover finds them.
 */
export function mediaStepId(elementId: string): string {
  return `media:${elementId}`;
}

export const MEDIA_STEP_PREFIX = 'media:';

/** One media request of the confirmed outline, with the scene it belongs to. */
export interface RunMediaItem {
  request: MediaGenerationRequest;
  sceneIndex: number;
}

/**
 * The media the outline asks for, in the order 1.1.x's browser media pass took
 * it (outline order, then each outline's own order). A placeholder requested
 * twice is generated once, as the browser keys its media tasks by it.
 */
export function mediaItemsOf(outlines: readonly SceneOutline[]): RunMediaItem[] {
  const seen = new Set<string>();
  const items: RunMediaItem[] = [];
  outlines.forEach((outline, sceneIndex) => {
    for (const request of outline.mediaGenerations ?? []) {
      if (seen.has(request.elementId)) continue;
      seen.add(request.elementId);
      items.push({ request, sceneIndex });
    }
  });
  return items;
}

/**
 * A media item regenerated after its course completed whose element the
 * course no longer has (the author deleted it, or its scene): the result was
 * dropped. Final: a Retry would pay for media nothing can show.
 */
export const MEDIA_ELEMENT_REMOVED = 'MEDIA_ELEMENT_REMOVED';

/** The failures no Retry of a run changes: the browser's final ones, and a removed element. */
export const FINAL_RUN_MEDIA_FAILURE_CODES: readonly string[] = [
  ...PERMANENT_MEDIA_FAILURE_CODES,
  MEDIA_ELEMENT_REMOVED,
];

/** Whether a failed media item may be retried. */
export function isRetryableRunMedia(failure: { readonly errorCode?: string }): boolean {
  return (
    failure.errorCode === undefined || !FINAL_RUN_MEDIA_FAILURE_CODES.includes(failure.errorCode)
  );
}
