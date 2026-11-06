import type { Scene } from '@/lib/types/stage';
import { resolvePBLContent } from '@/lib/pbl/legacy/read';
import { applyLearnerState, extractLearnerState, stripToDesignTemplate } from './learner-state';

/** The scene as document persistence stores it: learner state stripped from a v2 project. */
export function pblSceneAsPersisted(scene: Scene): Scene {
  const content = scene.content;
  if (content.type !== 'pbl') return scene;
  const resolved = resolvePBLContent(content);
  if (resolved.kind !== 'v2') return scene;
  const designTemplate = stripToDesignTemplate(resolved.projectV2);
  return {
    ...scene,
    content: {
      ...content,
      projectV2: designTemplate,
    },
  } as Scene;
}

/**
 * `target`'s design with `current`'s learner state: what undoing a change to a v2
 * project's design should land on. Learner work is not on the timeline, so a step
 * must not take back what a learner did since.
 */
export function withLearnerStateOf(target: Scene, current: Scene): Scene {
  if (target.content.type !== 'pbl' || current.content.type !== 'pbl') return target;
  const next = resolvePBLContent(target.content);
  const now = resolvePBLContent(current.content);
  if (next.kind !== 'v2' || now.kind !== 'v2') return target;
  return {
    ...target,
    content: {
      ...target.content,
      projectV2: applyLearnerState(next.projectV2, extractLearnerState(now.projectV2)),
    },
  } as Scene;
}
