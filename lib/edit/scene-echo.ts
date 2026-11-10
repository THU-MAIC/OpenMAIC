/**
 * Telling a save read back from someone else's change when the sync brings a scene
 * back.
 *
 * The sync already leaves alone any scene with an unsaved edit, and drops a read
 * older than an edit (`lib/workbench/use-workbench-session.ts`). What reaches here is
 * either what this browser saved or another writer's change, and a save replaces
 * scene objects either way, so identity says nothing. Only the second belongs on the
 * course timeline.
 *
 * The server stores content through its sanitizer and strips PBL learner state, so
 * what comes back is not byte for byte what went out (`<p style="">` returns as
 * `<p>`). Every comparison here is made on the form the server would hold.
 */

import { fieldFingerprint, trackedSceneFields } from '@/lib/edit/course-timeline';
import { migrateScene } from '@/lib/edit/slide-schema';
import { pblSceneAsPersisted } from '@/lib/pbl/v2/runtime/persisted-scene';
import { sanitizeSceneContent } from '@/lib/sanitize/scene-content';
import type { Scene, SlideContent } from '@/lib/types/stage';

/**
 * A text box's height (its width, when vertical) is what each browser measures for
 * it, and a measurement is not saved until the next real edit, so it differs from the
 * server's with nobody having changed anything. The other dimension is set on purpose.
 */
function withoutMeasuredSizes(field: string, value: unknown): unknown {
  const content = value as SlideContent | undefined;
  if (field !== 'content' || content?.type !== 'slide' || !content.canvas) return value;
  return {
    ...content,
    canvas: {
      ...content.canvas,
      elements: content.canvas.elements.map((element) => {
        if (element.type !== 'text') return element;
        const { [element.vertical ? 'width' : 'height']: _measured, ...rest } = element;
        return rest;
      }),
    },
  };
}

const storedFormByScene = new WeakMap<Scene, Scene>();

/** Scene objects do not change, and a whole-document save re-reads every scene. */
function storedForm(scene: Scene): Scene {
  let form = storedFormByScene.get(scene);
  if (!form) {
    form = sanitizeSceneContent(pblSceneAsPersisted(migrateScene(scene)));
    storedFormByScene.set(scene, form);
  }
  return form;
}

/**
 * The scenes to merge, field by field: a field the server holds as it is shown keeps
 * the local value, and a scene with nothing new keeps its object, so a save read back
 * changes nothing and cannot look like a change.
 */
export function keepLocalWhereUnchanged(
  current: readonly Scene[],
  fetched: readonly Scene[],
): Scene[] {
  const currentById = new Map(current.map((scene) => [scene.id, scene]));
  return fetched.map((raw) => {
    const server = migrateScene(raw);
    const local = currentById.get(server.id);
    if (!local) return server;
    const serverFields = server as unknown as Record<string, unknown>;
    const localFields = local as unknown as Record<string, unknown>;
    const localAsStored = storedForm(local) as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...serverFields };
    let taken = false;
    for (const field of new Set([...trackedSceneFields(local), ...trackedSceneFields(server)])) {
      if (
        fieldFingerprint(withoutMeasuredSizes(field, localAsStored[field])) !==
        fieldFingerprint(withoutMeasuredSizes(field, serverFields[field]))
      ) {
        taken = true;
      } else if (localFields[field] === undefined) {
        delete merged[field];
      } else {
        merged[field] = localFields[field];
      }
    }
    if (taken) return merged as unknown as Scene;
    return local.order === server.order ? local : ({ ...local, order: server.order } as Scene);
  });
}
