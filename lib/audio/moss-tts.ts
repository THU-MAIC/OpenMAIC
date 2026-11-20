import { speechForTts } from '@openmaic/generation/browser';
import type { Scene } from '@/lib/types/stage';
import type { ConfiguredTTSVoice } from './types';
import type { VoiceDesign } from './voice-design';

export const MOSS_REQUEST_TIMEOUT_MS = 240_000;

/** Spoken text to send to TTS for a speech action (uses paired `spokenText` when present). */
export function narrationSpokenText(action: { text?: string; spokenText?: string }): string {
  return speechForTts(action);
}

/** Only the configured speech API can opt into MOSS course narration extensions. */
export function isManagedMossTts(target: {
  providerId: string;
  managed?: boolean;
  options?: Record<string, unknown>;
}): boolean {
  return (
    target.managed === true &&
    target.providerId === 'openai-tts' &&
    target.options?.backend === 'moss'
  );
}

/** Longest `subject` the MOSS speech endpoint accepts. */
export const MOSS_SUBJECT_MAX_CHARS = 200;

/** A request's `subject` as MOSS accepts it: a trimmed, non-empty string of ≤200 chars. */
export function mossSubjectParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const subject = value.trim();
  return subject && subject.length <= MOSS_SUBJECT_MAX_CHARS ? subject : undefined;
}

/**
 * The subject MOSS narration sends for a course: the outline's subject label,
 * else the course name (older courses carry no subject; the server maps free
 * text by keywords, so the title is a reasonable hint). Over-long names are
 * truncated rather than dropped.
 */
export function mossCourseSubject(
  stage: { subject?: string; name?: string } | null | undefined,
): string | undefined {
  const subject = stage?.subject?.trim() || stage?.name?.trim();
  return subject ? subject.slice(0, MOSS_SUBJECT_MAX_CHARS) : undefined;
}

/** Older course profiles sometimes specify gender only in their voice identity. */
export function mossRoleGender(design?: VoiceDesign): 'male' | 'female' | undefined {
  if (design?.gender) return design.gender;
  const identity = design?.identity ?? '';
  const male = /男(?:性|声|生|士|孩|老师|教师|助教|学生|同学)|\b(?:male|man|boy)\b/i.test(identity);
  const female = /女(?:性|声|生|士|孩|老师|教师|助教|学生|同学)|\b(?:female|woman|girl)\b/i.test(
    identity,
  );
  return male === female ? undefined : male ? 'male' : 'female';
}

/** Use the deployment's voice catalogue and default when an older binding no longer fits. */
export function mossRoleVoice(
  voices: readonly ConfiguredTTSVoice[] | undefined,
  preferred?: string,
  gender?: 'male' | 'female',
  defaultVoice?: string,
): string {
  if (!voices?.length) return preferred || defaultVoice || '';
  const selected = voices.find((voice) => voice.id === preferred);
  if (selected && (!gender || selected.gender === gender)) return selected.id;
  const fallback = voices.find((voice) => voice.id === defaultVoice) ?? voices[0];
  if (!gender || fallback.gender === gender) return fallback.id;
  return voices.find((voice) => voice.gender === gender)?.id ?? fallback.id;
}

/** The frozen rules carry a topic for three speech lines, in document order. */
export function precedingSpeechTexts(
  scenes: readonly Pick<Scene, 'id' | 'actions'>[],
  sceneId: string,
  actionId: string,
): string[] {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex < 0) return [];
  const index = scenes[sceneIndex].actions?.findIndex((action) => action.id === actionId) ?? -1;
  if (index < 0) return [];
  const previous: string[] = [];
  for (let i = sceneIndex; i >= 0 && previous.length < 3; i--) {
    const actions = scenes[i].actions ?? [];
    for (
      let j = i === sceneIndex ? index - 1 : actions.length - 1;
      j >= 0 && previous.length < 3;
      j--
    ) {
      const action = actions[j];
      if (action.type === 'speech') {
        const spoken = narrationSpokenText(action);
        if (spoken) previous.push(spoken.slice(-4096));
      }
    }
  }
  return previous.reverse();
}
