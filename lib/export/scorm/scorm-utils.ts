// lib/export/scorm/scorm-utils.ts
//
// Pure helpers for the SCORM export pipeline. Everything here is
// side-effect-free and unit-testable: DB access, snapshot rendering and ZIP
// assembly live in `use-export-scorm.ts`.

import type { Scene, QuizContent, PBLContent } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ScormQuizQuestionData } from './scorm-types';

/** Sanitize a title for use inside a ZIP path segment. */
export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'scene'
  );
}

/** Zero-padded, collision-free file stem for a scene, e.g. `03_Intro_a_React`. */
export function sceneFileStem(index: number, title: string): string {
  return `${String(index + 1).padStart(2, '0')}_${sanitizeFileName(title)}`;
}

/**
 * Assemble a narration transcript from a scene's speech actions, in playback
 * order. Returns `undefined` when the scene has no narration.
 */
export function buildTranscript(scene: Scene): string | undefined {
  const parts = (scene.actions ?? [])
    .filter((a): a is SpeechAction => a.type === 'speech')
    .map((a) => a.text?.trim())
    .filter((t): t is string => !!t);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** Collect the ordered audioIds referenced by a scene's speech actions. */
export function sceneAudioIds(scene: Scene): string[] {
  const ids: string[] = [];
  for (const action of scene.actions ?? []) {
    if (action.type === 'speech') {
      const audioId = (action as SpeechAction).audioId;
      if (audioId && !ids.includes(audioId)) ids.push(audioId);
    }
  }
  return ids;
}

/** Map OpenMAIC quiz questions to the portable player shape. */
export function quizToScormQuestions(content: QuizContent): ScormQuizQuestionData[] {
  return content.questions.map((q) => ({
    id: q.id,
    type: q.type,
    question: q.question,
    ...(q.options ? { options: q.options.map((o) => ({ label: o.label, value: o.value })) } : {}),
    ...(q.answer ? { answer: q.answer } : {}),
    ...(q.analysis ? { analysis: q.analysis } : {}),
    ...(q.points !== undefined ? { points: q.points } : {}),
    ...(q.hasAnswer !== undefined ? { hasAnswer: q.hasAnswer } : {}),
  }));
}

/**
 * Produce a human-readable brief for a PBL scene. PBL runtimes are app-bound
 * (they need the OpenMAIC agent stack), so the SCORM package carries a static
 * summary the learner can read inside any LMS.
 */
export function pblSummary(content: PBLContent): string | undefined {
  const cfg = content.projectConfig as unknown as Record<string, unknown> | undefined;
  if (!cfg) return undefined;
  const parts: string[] = [];
  const title = typeof cfg.title === 'string' ? cfg.title : undefined;
  const description =
    typeof cfg.description === 'string'
      ? cfg.description
      : typeof cfg.overview === 'string'
        ? cfg.overview
        : undefined;
  if (title) parts.push(title);
  if (description) parts.push(description);
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

/** Extension for an audio record format, defaulting to mp3. */
export function audioExtension(format?: string): string {
  return format && /^[a-z0-9]{2,5}$/i.test(format) ? format.toLowerCase() : 'mp3';
}

/** Build a stable-but-unique SCORM package identifier. */
export function buildPackageIdentifier(courseName: string): string {
  const slug =
    courseName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'course';
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `openmaic.${slug}.${rand}`;
}
