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
  const [legacy, setLegacy] = useState<{ scene: Scene; audio: Set<string> } | null>(null);
  useEffect(() => {
    return observeLegacySpeechAudio(
      scene,
      (audio) => setLegacy({ scene, audio }),
      () => setLegacy(null),
    );
  }, [scene]);
  return collectCourseIssues(
    { scenes: [scene] },
    {
      narrationEnabled,
      hasLegacyAudio: (_, action) =>
        legacy?.scene === scene ? legacy.audio.has(action.id) : undefined,
    },
  );
}
