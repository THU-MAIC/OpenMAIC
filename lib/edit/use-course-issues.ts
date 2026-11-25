'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { collectCourseIssues, type CourseIssue } from '@openmaic/dsl';
import { observeLegacyCourseAudio } from '@/lib/device-storage/observe-legacy-speech-audio';
import { useStageStore } from '@/lib/store/stage';
import { legacySpeechEvidenceKey } from '@/lib/edit/use-scene-issues';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { serverTTSAvailable } from '@/lib/audio/tts-selection';

/**
 * Every issue in the current course, derived the same way the scene thumbnails
 * derive theirs (`collectCourseIssues` over the live document plus the same
 * browser context), so an issue disappears the moment its cause is fixed.
 *
 * Narration issues wait on this device's audio cache. The list checks the
 * whole course against one key, so after a narration edit on any page every
 * page's narration issues are held back until the cache answers again (a
 * moment); the thumbnails, keyed per page, keep the untouched pages' markers.
 */
export function useCourseIssues(): CourseIssue[] {
  const scenes = useStageStore((s) => s.scenes);
  const narrationEnabled = serverTTSAvailable(useModelCapabilities());
  const legacyKey = scenes.map((scene) => legacySpeechEvidenceKey(scene)).join('\n');
  const [legacy, setLegacy] = useState<{ key: string; audio: Map<string, Set<string>> } | null>(
    null,
  );
  // The cache query reads only what `legacyKey` identifies (each scene's id,
  // order, course and narration actions), so an unrelated edit keeps the
  // subscription instead of querying the whole course again.
  const scenesRef = useRef(scenes);
  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);
  useEffect(() => {
    return observeLegacyCourseAudio(
      scenesRef.current,
      // A failed lookup must not leave the list's narration issues pending.
      (audio) => setLegacy({ key: legacyKey, audio }),
      () => setLegacy({ key: legacyKey, audio: new Map() }),
    );
  }, [legacyKey]);
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
        },
      ),
    [scenes, narrationEnabled, legacy, legacyKey],
  );
}
