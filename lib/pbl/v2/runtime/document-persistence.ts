import type { Scene } from '@/lib/types/stage';
import { resolvePBLContent } from '@/lib/pbl/legacy/read';
import { synchronizePBLProjectRuntime } from './hydration';
import { stripToDesignTemplate } from './learner-state';

/**
 * Strip scenes with an authoritative projectV2 to their design templates before
 * document persistence. Authority is decided by `resolvePBLContent`, the same
 * rule the renderer uses: a payload the classroom will not show as v2 (damaged
 * or not runnable) is inert bytes here too and round-trips untouched, as does
 * any legacy projectConfig on the same scene — the original v1 record,
 * including its chat history, is never rewritten or lost.
 */
export async function preparePBLScenesForDocumentPersistence(
  stageId: string,
  scenes: readonly Scene[],
): Promise<Scene[]> {
  await Promise.all(
    scenes.map(async (scene) => {
      const content = scene.content;
      if (content.type !== 'pbl') return;
      const resolved = resolvePBLContent(content);
      if (resolved.kind !== 'v2') return;
      await synchronizePBLProjectRuntime({
        stageId,
        sceneId: scene.id,
        project: resolved.projectV2,
      });
    }),
  );

  return scenes.map((scene) => {
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
  });
}
