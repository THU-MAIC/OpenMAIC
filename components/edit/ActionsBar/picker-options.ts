import type { Action } from '@/lib/types/action';
import type { SceneType } from '@/lib/types/stage';
import { hasDiscussion } from './actions-edit';
import { ELEMENT_BOUND } from './cue-meta';

/** Addable cue types offered in the picker's "action" group (before discussion). */
const CUE_ORDER = ['speech', 'spotlight', 'laser'] as const;

export type PickerType = (typeof CUE_ORDER)[number] | 'discussion';
export interface PickerOption {
  type: PickerType;
  disabled: boolean;
}

/**
 * Element-bound cues (spotlight/laser) need a slide canvas to bind to, so they
 * are only offered on slide scenes — mirrors the old header-palette filter.
 * Discussion is terminal + at-most-one, so it is disabled when one exists.
 */
export function pickerOptions(sceneType: SceneType, actions: Action[]): PickerOption[] {
  const cues = CUE_ORDER.filter((t) => sceneType === 'slide' || !ELEMENT_BOUND.has(t)).map(
    (type) => ({ type, disabled: false }),
  );
  return [...cues, { type: 'discussion' as const, disabled: hasDiscussion(actions) }];
}
