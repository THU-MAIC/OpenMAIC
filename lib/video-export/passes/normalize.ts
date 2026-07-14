/**
 * `normalize` pass — deterministic scene ordering + action validation.
 *
 * The first compile pass. It (1) puts scenes in a stable, deterministic order
 * (playback order == export order), and (2) validates each action, dropping any
 * that the later passes could not interpret — with a first-class diagnostic so
 * the drop is auditable, never silent (issue AC). Structural failures the
 * compiler cannot degrade past (no scenes at all) throw.
 *
 * Pure: no IO, deterministic; does not mutate its input.
 */
import type { Action } from '@openmaic/dsl';
import { isActionType } from '@openmaic/dsl';
import type { CompilerScene } from '../deps';
import { type Diagnostic, VideoTimelineCompileError } from '../ir';

export interface NormalizeResult {
  /** Scenes in deterministic order, each with only interpretable actions. */
  scenes: CompilerScene[];
  diagnostics: Diagnostic[];
}

/**
 * Fields the later passes require. A missing one means the action can't be laid
 * on the timeline / resolved, so it is dropped with an `invalid-action`
 * diagnostic rather than crashing a downstream pass. Returns the missing field
 * name, or null when the action is well-formed.
 */
function missingRequiredField(action: Action): string | null {
  switch (action.type) {
    case 'spotlight':
    case 'laser':
    case 'play_video':
    case 'wb_delete':
    case 'wb_edit_code':
      return typeof action.elementId === 'string' && action.elementId.length > 0
        ? null
        : 'elementId';
    case 'speech':
      // Empty text is legal (a dwell beat); only a non-string is malformed.
      return typeof action.text === 'string' ? null : 'text';
    case 'wb_draw_code':
      return typeof action.code === 'string' ? null : 'code';
    case 'discussion':
      return typeof action.topic === 'string' && action.topic.length > 0 ? null : 'topic';
    default:
      return null;
  }
}

/** Validate one scene's actions, collecting diagnostics for any that are dropped. */
function validateActions(scene: CompilerScene, diagnostics: Diagnostic[]): Action[] {
  const actions = scene.actions ?? [];
  const kept: Action[] = [];

  for (const action of actions) {
    if (!isActionType((action as Action).type)) {
      diagnostics.push({
        severity: 'warn',
        code: 'unknown-action',
        sceneId: scene.id,
        actionId: (action as { id?: string }).id,
        message: `Dropped action with unknown type "${String((action as { type?: unknown }).type)}".`,
      });
      continue;
    }

    const missing = missingRequiredField(action as Action);
    if (missing) {
      diagnostics.push({
        severity: 'warn',
        code: 'invalid-action',
        sceneId: scene.id,
        actionId: (action as Action).id,
        message: `Dropped ${(action as Action).type} action missing required field "${missing}".`,
      });
      continue;
    }

    kept.push(action as Action);
  }

  return kept;
}

/**
 * Order scenes deterministically and validate their actions.
 *
 * Ordering mirrors the app's export planner: by `order` (falling back to the
 * input index when absent), tie-broken by the original input index so equal
 * `order` values stay stable. Throws when there are no scenes to compile.
 */
export function normalizeScenes(scenes: readonly CompilerScene[]): NormalizeResult {
  if (scenes.length === 0) {
    throw new VideoTimelineCompileError('No scenes to compile into a VideoTimeline.');
  }

  const diagnostics: Diagnostic[] = [];

  const ordered = scenes
    .map((scene, inputIndex) => ({ scene, inputIndex }))
    .sort((a, b) => {
      const orderDiff = (a.scene.order ?? a.inputIndex) - (b.scene.order ?? b.inputIndex);
      return orderDiff === 0 ? a.inputIndex - b.inputIndex : orderDiff;
    })
    .map(({ scene }) => ({ ...scene, actions: validateActions(scene, diagnostics) }));

  return { scenes: ordered, diagnostics };
}
