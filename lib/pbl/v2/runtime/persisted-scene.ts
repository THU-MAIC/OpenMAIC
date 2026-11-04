import type { Scene } from '@/lib/types/stage';
import { resolvePBLContent } from '@/lib/pbl/legacy/read';
import { stripToDesignTemplate } from './learner-state';

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
