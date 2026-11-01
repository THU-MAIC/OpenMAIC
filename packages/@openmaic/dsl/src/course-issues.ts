import { isConcreteMediaAddress } from './media-address.js';
import type { Action, SpeechAction } from './action.js';
import type { SceneCore, SceneType, SlideContent } from './stage.js';
import { isSlideContent } from './stage.js';
import { slideMediaSlotDescriptors } from './slide-media-slots.js';

export type CourseIssueKind =
  | 'speech-without-audio'
  | 'media-not-generated'
  | 'dangling-cue'
  | 'empty-actions'
  | 'empty-speech'
  | 'unbound-cue'
  | 'empty-discussion';

export interface CourseIssue {
  /** Opaque identity derived from kind and document target; stable across recomputation. */
  id: string;
  kind: CourseIssueKind;
  sceneId: string;
  elementId?: string;
  actionId?: string;
  severity: 'error' | 'warning';
  source: 'document' | 'run' | 'runtime';
  /** Device-local evidence has not been checked for an eligible legacy action. */
  evidence?: 'local-audio-unchecked';
}

/** Structural view shared by the app's extended scenes and SDK documents. */
export type CourseIssueScene = SceneCore & {
  content: SlideContent | { type: SceneType };
};

export interface CourseIssueContext {
  /** False when the workspace cannot generate narration; defaults to inspecting it. */
  narrationEnabled?: boolean;
  /** Browser evidence for an unstamped legacy action; undefined means unknown. */
  hasLegacyAudio?: (scene: CourseIssueScene, action: SpeechAction) => boolean | undefined;
}

export const ELEMENT_BOUND_CUE_TYPES: ReadonlySet<string> = new Set([
  'spotlight',
  'laser',
  'play_video',
]);
const blank = (value: string | undefined) => !value?.trim();
const issueId = (
  kind: CourseIssueKind,
  sceneId: string,
  actionId?: string,
  elementId?: string,
  slideId?: string,
) => JSON.stringify([kind, sceneId, actionId, elementId, slideId]);

type ActionContentIssue = CourseIssue & {
  kind: 'empty-speech' | 'unbound-cue' | 'empty-discussion';
  actionId: string;
};

/** Whether a value has the generated image/video placeholder shape. */
export function isGeneratedMediaPlaceholder(value: string | undefined): value is string {
  return !!value && /^gen_(img|vid)_[\w-]+$/i.test(value);
}

/** Existing timeline lint, shared with the course collector. */
function collectActionContentIssues(
  sceneId: string,
  actions: readonly Action[],
): ActionContentIssue[] {
  const issues: ActionContentIssue[] = [];
  for (const action of actions) {
    let kind: ActionContentIssue['kind'] | undefined;
    if (action.type === 'speech' && blank(action.text)) kind = 'empty-speech';
    else if (
      ELEMENT_BOUND_CUE_TYPES.has(action.type) &&
      blank((action as { elementId?: string }).elementId)
    )
      kind = 'unbound-cue';
    else if (action.type === 'discussion' && blank(action.topic)) kind = 'empty-discussion';
    if (kind)
      issues.push({
        id: issueId(kind, sceneId, action.id),
        kind,
        sceneId,
        actionId: action.id,
        severity: 'warning',
        source: 'document',
      });
  }
  return issues;
}

/** Pure current-document derivation: changing the cause removes the issue. */
export function collectCourseIssues(
  document: { scenes: readonly CourseIssueScene[] },
  context: CourseIssueContext = {},
): CourseIssue[] {
  const issues: CourseIssue[] = [];
  for (const scene of document.scenes) {
    const actions = scene.actions ?? [];
    const add = (kind: CourseIssueKind, fields: Partial<CourseIssue> = {}, slideId?: string) =>
      issues.push({
        id: issueId(kind, scene.id, fields.actionId, fields.elementId, slideId),
        kind,
        sceneId: scene.id,
        severity: 'warning',
        source: 'document',
        ...fields,
      });
    if (!actions.length) add('empty-actions');
    issues.push(...collectActionContentIssues(scene.id, actions));
    const canvas = isSlideContent(scene.content) ? scene.content.canvas : undefined;
    const targets = new Map((canvas?.elements ?? []).map((element) => [element.id, element.type]));
    for (const action of actions) {
      if (
        action.type === 'speech' &&
        !blank(action.text) &&
        blank(action.audioId) &&
        context.narrationEnabled !== false
      ) {
        const legacyUrl = (action as SpeechAction & { audioUrl?: string }).audioUrl;
        const legacy =
          action.audioInvalidated || blank(action.id)
            ? false
            : context.hasLegacyAudio?.(scene, action);
        if ((!action.audioInvalidated && !blank(legacyUrl)) || legacy === true) continue;
        add('speech-without-audio', {
          actionId: action.id,
          ...(legacy === undefined ? { evidence: 'local-audio-unchecked' as const } : {}),
        });
      } else if (ELEMENT_BOUND_CUE_TYPES.has(action.type)) {
        const elementId = (action as { elementId?: string }).elementId;
        if (
          elementId &&
          !blank(elementId) &&
          (!targets.has(elementId) ||
            (action.type === 'play_video' && targets.get(elementId) !== 'video'))
        )
          add('dangling-cue', { actionId: action.id, elementId });
      }
    }
    for (const slide of [...(canvas ? [canvas] : []), ...(scene.whiteboards ?? [])]) {
      const reported = new Set<number | undefined>();
      for (const slot of slideMediaSlotDescriptors(slide)) {
        if (!isGeneratedMediaPlaceholder(slot.ref) || reported.has(slot.elementIndex)) continue;
        const element =
          slot.elementIndex === undefined ? undefined : slide.elements[slot.elementIndex];
        if (
          element?.type === 'video' &&
          (slot.property === 'src' || slot.property === 'mediaRef')
        ) {
          const source = isConcreteMediaAddress(element.src)
            ? element.src
            : element.mediaRef || element.src;
          if (!isGeneratedMediaPlaceholder(source)) continue;
        }
        reported.add(slot.elementIndex);
        add(
          'media-not-generated',
          {
            ...(slot.elementIndex === undefined
              ? {}
              : { elementId: slide.elements[slot.elementIndex].id }),
          },
          slide.id,
        );
      }
    }
  }
  return issues;
}
