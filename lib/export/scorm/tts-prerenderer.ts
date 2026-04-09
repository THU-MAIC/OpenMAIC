/**
 * TTS pre-renderer for SCORM export.
 *
 * Walks every SpeechAction in the given stages, synthesizes audio with the
 * configured TTS provider, returns a map of audioId -> { buffer, format }
 * and mutates each action to point at the local asset path (`assets/audio/{id}.{ext}`).
 */
import { generateTTS } from '@/lib/audio/tts-providers';
import { resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { PersistedClassroomData } from '@/lib/server/classroom-storage';

export interface TTSConfig {
  providerId: TTSProviderId;
  voice: string;
  speed?: number;
  apiKey?: string;
  baseUrl?: string;
}

export interface PrerenderedAudio {
  audioId: string;
  buffer: Uint8Array;
  format: string;
}

/**
 * Walks all speech actions in the given stages, generates audio, and returns
 * a list of audio buffers ready to be written into the zip.
 *
 * Mutates the scene actions in place: each SpeechAction gets its `audioUrl`
 * rewritten to `assets/audio/{audioId}.{format}` so the offline player can
 * load it directly.
 */
export async function prerenderCourseAudio(
  stages: PersistedClassroomData[],
  ttsConfig: TTSConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<PrerenderedAudio[]> {
  // Collect all speech actions that need rendering
  const targets: Array<{ scene: Scene; action: SpeechAction }> = [];
  for (const stage of stages) {
    for (const scene of stage.scenes) {
      for (const action of scene.actions ?? []) {
        if (action.type === 'speech' && action.text) {
          targets.push({ scene, action });
        }
      }
    }
  }

  if (targets.length === 0) return [];

  // Resolve credentials using the same rules as the TTS API route
  const apiKey = resolveTTSApiKey(ttsConfig.providerId, ttsConfig.apiKey);
  const baseUrl = resolveTTSBaseUrl(ttsConfig.providerId, ttsConfig.baseUrl);

  const config = {
    providerId: ttsConfig.providerId,
    voice: ttsConfig.voice,
    speed: ttsConfig.speed ?? 1.0,
    apiKey,
    baseUrl,
  };

  const results: PrerenderedAudio[] = [];

  // Sequential to avoid rate-limiting most providers. Could be made concurrent
  // with a small pool if needed.
  for (let i = 0; i < targets.length; i++) {
    const { action } = targets[i];
    const audioId = action.audioId || action.id || `speech-${i}`;
    try {
      const { audio, format } = await generateTTS(config, action.text);
      results.push({ audioId, buffer: audio, format });
      // Rewrite the action so the offline player reads from the local asset
      action.audioUrl = `assets/audio/${audioId}.${format}`;
      action.audioId = audioId;
    } catch (err) {
      console.warn(`[SCORM export] TTS failed for action ${audioId}:`, err);
      // Leave the action's audioUrl unset so the player falls back to text-only
    }
    if (onProgress) onProgress(i + 1, targets.length);
  }

  return results;
}
