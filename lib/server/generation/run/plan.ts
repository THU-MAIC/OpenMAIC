/**
 * The run's state machine, as pure functions over what is checkpointed.
 *
 * A run's steps follow the browser's classic order: material analysis (when
 * materials are given) → research → outline → [confirmation] → agents → for
 * each scene in outline order: content → actions → narration → append (the
 * scene's document write). The step list is fixed by the input and the
 * confirmed outline; a step whose capability does not resolve (no web search,
 * no server TTS) still runs and checkpoints that it did nothing, so the plan
 * never depends on configuration read at another moment.
 */
import type { ExecutableRunState, GenerationRunInput, GenerationRunState } from './types';

export type SceneStepKind = 'content' | 'actions' | 'narration' | 'append';

export type RunStep =
  | { id: 'material-analysis'; kind: 'material-analysis' }
  | { id: 'research'; kind: 'research' }
  | { id: 'outline'; kind: 'outline' }
  | { id: 'agents'; kind: 'agents' }
  | { id: string; kind: SceneStepKind; sceneIndex: number };

const SCENE_STEP_KINDS: readonly SceneStepKind[] = ['content', 'actions', 'narration', 'append'];

export function sceneStepId(sceneIndex: number, kind: SceneStepKind): string {
  return `scene:${sceneIndex}:${kind}`;
}

/** The step a step id names, or null for an id no plan produces. */
export function parseStepId(id: string): RunStep | null {
  if (id === 'material-analysis' || id === 'research' || id === 'outline' || id === 'agents') {
    return { id, kind: id } as RunStep;
  }
  const match = /^scene:(\d+):(content|actions|narration|append)$/.exec(id);
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
