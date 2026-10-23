'use client';

import { useEffect, useState } from 'react';
import { collectCourseIssues } from '@openmaic/dsl';
import { observeLegacySpeechAudio } from '@/lib/device-storage/observe-legacy-speech-audio';
import type { Scene } from '@/lib/types/stage';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { serverTTSAvailable } from '@/lib/audio/tts-selection';

/** Current document issues plus the timeline's browser-local audio fallback. */
export function useSceneIssues(scene: Scene) {
  const narrationEnabled = serverTTSAvailable(useModelCapabilities());
  // Reuse evidence across unrelated edits, but never across different narration inputs.
  const legacyKey = JSON.stringify([
    scene.stageId,
    scene.id,
    scene.order,
    (scene.actions ?? [])
      .filter((action) => action.type === 'speech')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, text, audioId, audioInvalidated }) => [id, text, audioId, audioInvalidated]),
  ]);
  const [legacy, setLegacy] = useState<{ key: string; audio: Set<string> } | null>(null);
  useEffect(() => {
    return observeLegacySpeechAudio(
      scene,
      (audio) => setLegacy({ key: legacyKey, audio }),
      // A failed lookup must not leave thumbnail warnings pending indefinitely.
      () => setLegacy({ key: legacyKey, audio: new Set() }),
    );
  }, [scene, legacyKey]);
  return collectCourseIssues(
    { scenes: [scene] },
    {
      narrationEnabled,
      hasLegacyAudio: (_, action) =>
        legacy?.key === legacyKey ? legacy.audio.has(action.id) : undefined,
    },
  );
}
