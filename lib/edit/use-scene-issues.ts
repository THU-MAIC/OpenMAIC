'use client';

import { useEffect, useState } from 'react';
import { collectCourseIssues } from '@openmaic/dsl';
import { observeLegacySpeechAudio } from '@/lib/device-storage/observe-legacy-speech-audio';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import type { Scene } from '@/lib/types/stage';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { serverTTSAvailable } from '@/lib/audio/tts-selection';

/**
 * Identity of the narration inputs the device-local audio evidence was checked
 * against: reuse evidence across unrelated edits, never across different
 * narration inputs.
 */
export function legacySpeechEvidenceKey(
  scene: Pick<Scene, 'stageId' | 'id' | 'order' | 'actions'>,
) {
  return JSON.stringify([
    scene.stageId,
    scene.id,
    scene.order,
    (scene.actions ?? [])
      .filter((action) => action.type === 'speech')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, text, audioId, audioInvalidated }) => [id, text, audioId, audioInvalidated]),
  ]);
}

/** Current document issues plus the timeline's browser-local audio fallback. */
export function useSceneIssues(scene: Scene) {
  const narrationEnabled = serverTTSAvailable(useModelCapabilities());
  const legacyKey = legacySpeechEvidenceKey(scene);
  const [legacy, setLegacy] = useState<{ key: string; audio: Set<string> } | null>(null);
  useEffect(() => {
    return observeLegacySpeechAudio(
      scene,
      (audio) => setLegacy({ key: legacyKey, audio }),
      // A failed lookup must not leave thumbnail warnings pending indefinitely.
      () => setLegacy({ key: legacyKey, audio: new Set() }),
    );
  }, [scene, legacyKey]);
  const runtimeErrors = useSceneRuntimeErrors((state) => state.errors[scene.id]);
  return collectCourseIssues(
    { scenes: [scene] },
    {
      narrationEnabled,
      hasLegacyAudio: (_, action) =>
        legacy?.key === legacyKey ? legacy.audio.has(action.id) : undefined,
      runtimeErrors: () => runtimeErrors,
    },
  );
}
