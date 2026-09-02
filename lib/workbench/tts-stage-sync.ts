import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { WorkbenchEvent } from '@/lib/workbench/session-store';

interface GenerateTtsDetails {
  sceneId?: unknown;
  sceneActions?: unknown;
}

/**
 * Fold a completed generate_tts result into the browser's live scene copy.
 *
 * Checkpoints remain the durable, whole-document synchronization path. This
 * narrow fold closes the live gap between a successful tool card and playback:
 * the completion already carries the exact action array that was persisted,
 * including any long-speech splits performed during synthesis.
 */
export function applyGenerateTtsResultToScenes(
  scenes: readonly Scene[],
  event: WorkbenchEvent,
): readonly Scene[] {
  if (event.type !== 'tool_execution_end') return scenes;

  const data = (event.data ?? {}) as Record<string, unknown>;
  if (data.toolName !== 'generate_tts' || data.isError === true) return scenes;

  const result = data.result as { details?: GenerateTtsDetails } | undefined;
  const details = result?.details;
  if (typeof details?.sceneId !== 'string' || !Array.isArray(details.sceneActions)) return scenes;

  const sceneIndex = scenes.findIndex((scene) => scene.id === details.sceneId);
  if (sceneIndex < 0) return scenes;

  const next = [...scenes];
  next[sceneIndex] = {
    ...next[sceneIndex],
    actions: details.sceneActions as Action[],
  } as Scene;
  return next;
}
