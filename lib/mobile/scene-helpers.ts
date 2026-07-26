/**
 * lib/mobile/scene-helpers.ts
 *
 * Convert OPENMAIC Scene objects into the flat "podcast-style" structure
 * the mobile app consumes: one (narration_text, audio_url) tuple per
 * chapter. Skips quiz / interactive / pbl scenes entirely (they are
 * not suitable for audio-only podcast playback).
 */

import type { Scene } from '@/lib/types/stage';

/**
 * One audio segment within a chapter. A chapter with multiple speech
 * actions produces multiple segments; the mobile AudioPlayer plays them
 * sequentially (auto-advance from segment N to N+1).
 */
export interface MobileAudioSegment {
  /** Unique identifier (e.g., `${sceneId}:narration` or action id). */
  id: string;
  /** Audio URL for this segment (from Supabase Storage or similar). */
  audioUrl?: string;
  /** Audio ID (cache key). */
  audioId?: string;
  /** Narration text for this segment (for display/logging). */
  text: string;
  /** Playback order within the chapter (0-based). */
  order: number;
  /** Which field provided the audioUrl — for diagnostics. */
  sourceField: string;
}

export interface MobileChapter {
  /** Scene id (stable across visits). */
  sceneId: string;
  /** Scene title (chapter heading). */
  title: string;
  /** Scene order (0-based). */
  order: number;
  /** Scene type — used to flag "interactive skipped" pages. */
  sceneType: 'slide' | 'quiz' | 'interactive' | 'pbl';
  /** Concatenated narration text from all speech actions in order. */
  text: string;
  /** Audio URL for this chapter (first segment's URL, for compat). */
  audioUrl?: string;
  /** Audio ID (first segment's ID, for compat). */
  audioId?: string;
  /** Which field provided the audioUrl — for diagnostics. */
  audioSourceField: string;
  /** All audio segments for sequential playback (primary mobile path). */
  audioSegments: MobileAudioSegment[];
  /** Per-speech fallback when the optional narration file cannot be loaded. */
  fallbackAudioSegments: MobileAudioSegment[];
  /** Total seconds of audio (estimated if not pre-computed). */
  durationSec: number;
}

/**
 * Scene types that represent interactive / non-narrative content.
 * These scenes are filtered out of the mobile podcast playlist because:
 *   - quiz      → requires UI interaction (multiple choice, etc.)
 *   - interactive → embeds external widgets / HTML
 *   - pbl        → project-based learning with its own workspace
 *
 * Only `slide`-type scenes (narrative lecture content) are kept for
 * audio podcast playback.
 */
const INTERACTIVE_SCENE_TYPES = new Set(['quiz', 'interactive', 'pbl']);

/**
 * Determine whether a scene should be excluded from mobile podcast mode.
 *
 * Checks:
 *   1. Scene.type against INTERACTIVE_SCENE_TYPES
 *   2. Fallback: content shape heuristics for scenes with missing/unknown type
 */
export function isInteractiveScene(scene: Scene): boolean {
  // Primary check: known interactive types
  if (scene.type && INTERACTIVE_SCENE_TYPES.has(scene.type)) {
    return true;
  }

  // Secondary heuristic: inspect content shape for interactive markers
  const content = scene.content as unknown as Record<string, unknown> | undefined;
  if (!content) return false;

  // Quiz content has a `questions` array
  if (Array.isArray(content.questions) && content.questions.length > 0) return true;

  // Interactive content has url/html/widgetType/widgetConfig
  if (
    typeof content.url === 'string' ||
    typeof content.html === 'string' ||
    typeof content.widgetType === 'string' ||
    content.widgetConfig !== undefined
  ) {
    return true;
  }

  // PBL content has projectConfig or projectV2
  if (content.projectConfig !== undefined || content.projectV2 !== undefined) {
    return true;
  }

  return false;
}

/**
 * Convert OPENMAIC Scene actions into a single narration string.
 * Sorts by `order` if present, otherwise preserves array order.
 */
function extractNarrationText(scene: Scene): string {
  const actions = scene.actions ?? [];
  const sorted = [...actions].sort((a, b) => {
    const ao = (a as { order?: number }).order ?? 0;
    const bo = (b as { order?: number }).order ?? 0;
    return ao - bo;
  });

  const lines: string[] = [];
  for (const a of sorted) {
    if ((a as { type?: string }).type === 'speech') {
      const text = (a as { text?: string }).text;
      if (text) lines.push(text);
    }
  }
  return lines.join(' ').trim();
}

/**
 * Build audio segments for a scene — the primary mobile playback path.
 *
 * Two modes:
 *   1. scene.narrationAudioUrl exists → single segment (full-chapter audio)
 *   2. Otherwise → one segment per speech action with audioUrl/audioId
 *
 * The mobile AudioPlayer plays these segments sequentially.
 */
function extractSpeechAudioSegments(scene: Scene): MobileAudioSegment[] {
  const actions = scene.actions ?? [];
  const speechActions = actions.filter(
    (a) => (a as { type?: string }).type === 'speech',
  );

  return speechActions
    .map((a, idx) => {
      const sa = a as { id?: string; audioUrl?: string; audioId?: string; text?: string };
      return {
        id: sa.id || `${scene.id}:seg${idx}`,
        audioUrl: sa.audioUrl,
        audioId: sa.audioId,
        text: sa.text || '',
        order: idx,
        sourceField: sa.audioUrl ? 'SpeechAction.audioUrl (segment)' : '(no audio)',
      } satisfies MobileAudioSegment;
    })
    .filter((s) => s.audioUrl || s.audioId); // only include segments that have audio
}

function extractAudioSegments(scene: Scene): MobileAudioSegment[] {
  const sceneRaw = scene as unknown as Record<string, unknown>;
  const narrationUrl = sceneRaw.narrationAudioUrl as string | undefined;
  const narrationId = sceneRaw.narrationAudioId as string | undefined;
  if (narrationUrl) return [{
    id: `${scene.id}:narration`, audioUrl: narrationUrl, audioId: narrationId,
    text: extractNarrationText(scene), order: 0, sourceField: 'Scene.narrationAudioUrl',
  }];
  return extractSpeechAudioSegments(scene);
}

/**
 * Find the primary audio URL for a chapter (backward-compat).
 *
 * Priority (highest first):
 *   1. scene.narrationAudioUrl  — full-chapter narration audio
 *   2. first speechAction.audioUrl — legacy fallback (per-segment)
 *
 * Also returns sourceField for diagnostics.
 */
function extractAudio(scene: Scene): { audioUrl?: string; audioId?: string; sourceField: string } {
  const segments = extractAudioSegments(scene);
  if (segments.length > 0) {
    const first = segments[0];
    return {
      audioUrl: first.audioUrl,
      audioId: first.audioId,
      sourceField: first.sourceField,
    };
  }
  return { sourceField: '(none)' };
}

/**
 * Rough estimate when the scene has no pre-computed duration.
 * Chinese: ~4 characters/sec at 1x speech rate.
 * English: ~2.5 words/sec.
 */
function estimateDurationSec(text: string): number {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cn;
  return Math.max(3, Math.round(cn / 4 + other / 15));
}

/**
 * Convert an OPENMAIC scenes array (in the shape stored in
 * `public.courses.data.scenes`) into mobile chapters.
 *
 * Interactive scenes (quiz/interactive/pbl) are **filtered out** — they
 * cannot be played as audio-only chapters. The returned array contains only
 * narrative `slide`-type scenes suitable for podcast-style playback.
 *
 * Logs [MOBILE LEARN][Scene Filter] with diagnostic info for debugging.
 */
export function buildChapters(scenes: Scene[]): MobileChapter[] {
  // --- Scene filter log ---
  const totalScenes = scenes.length;
  const skippedIds: string[] = [];

  const filtered = scenes.filter((s) => {
    if (isInteractiveScene(s)) {
      skippedIds.push(s.id);
      return false;
    }
    return true;
  });

  const chapters = filtered
    .map((s) => {
      const audio = extractAudio(s);
      const segments = extractAudioSegments(s);
      const fallbackSegments = extractSpeechAudioSegments(s);
      return {
        sceneId: s.id,
        title: s.title || `第 ${s.order + 1} 章`,
        order: s.order,
        sceneType: (s.type ?? 'slide') as MobileChapter['sceneType'],
        text: extractNarrationText(s),
        audioUrl: audio.audioUrl,
        audioId: audio.audioId,
        audioSourceField: audio.sourceField,
        audioSegments: segments,
        fallbackAudioSegments: fallbackSegments,
      };
    })
    .map((c) => ({
      ...c,
      durationSec: estimateDurationSec(c.text),
    }));

  // Dev log for debugging scene filtering decisions
  console.log('[MOBILE LEARN][Scene Filter]', JSON.stringify({
    totalScenes,
    mobileScenes: chapters.length,
    skippedInteractiveScenes: skippedIds.length,
    skippedSceneIds: skippedIds,
    timestamp: new Date().toISOString(),
  }));

  return chapters;
}
