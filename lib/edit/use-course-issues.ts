'use client';

import { useEffect, useMemo, useState } from 'react';
import { collectCourseIssues, type CourseIssue } from '@openmaic/dsl';
import { observeLegacyCourseAudio } from '@/lib/device-storage/observe-legacy-speech-audio';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import { useStageStore } from '@/lib/store/stage';
import { legacySpeechEvidenceKey } from '@/lib/edit/use-scene-issues';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { serverTTSAvailable } from '@/lib/audio/tts-selection';

/**
 * Every issue in the current course, derived the same way the scene thumbnails
 * derive theirs (`collectCourseIssues` over the live document plus the same
 * browser context), so the list and the markers never disagree and an issue
 * disappears the moment its cause is fixed.
 *
 * Runtime errors are this browser's observation of the CURRENT page content
 * (cleared when the content changes or the classroom switches); they reach the
 * agent not through this list's server twin but as evidence in the owner's
 * hand-off message.
 */
export function useCourseIssues(): CourseIssue[] {
  const scenes = useStageStore((s) => s.scenes);
  const narrationEnabled = serverTTSAvailable(useModelCapabilities());
  const runtimeErrors = useSceneRuntimeErrors((s) => s.errors);
  const legacyKey = scenes.map((scene) => legacySpeechEvidenceKey(scene)).join('\n');
  const [legacy, setLegacy] = useState<{ key: string; audio: Map<string, Set<string>> } | null>(
    null,
  );
  useEffect(() => {
    return observeLegacyCourseAudio(
      scenes,
      // A failed lookup must not leave the list's narration issues pending.
      (audio) => setLegacy({ key: legacyKey, audio }),
      () => setLegacy({ key: legacyKey, audio: new Map() }),
    );
  }, [scenes, legacyKey]);
  return useMemo(
    () =>
      collectCourseIssues(
        { scenes },
        {
          narrationEnabled,
          hasLegacyAudio: (scene, action) =>
            legacy?.key === legacyKey
              ? (legacy.audio.get(scene.id)?.has(action.id) ?? false)
              : undefined,
          runtimeErrors: (sceneId) => runtimeErrors[sceneId],
        },
      ),
    [scenes, narrationEnabled, legacy, legacyKey, runtimeErrors],
  );
}
