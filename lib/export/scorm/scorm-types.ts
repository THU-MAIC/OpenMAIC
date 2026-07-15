// lib/export/scorm/scorm-types.ts
//
// Shared contracts for the SCORM 1.2 export pipeline.
//
// The SCORM package embeds a self-contained static player (see
// `scorm-player-template.ts`) that consumes a `course.json` manifest whose
// shape is described by `ScormCourseData` below. Slides are exported as
// pre-rendered PNG snapshots so the package renders identically in any LMS
// without shipping the full OpenMAIC renderer; quizzes are re-rendered by the
// player and report their score through the SCORM 1.2 runtime API.

export const SCORM_FORMAT_VERSION = 1;
export const SCORM_PACKAGE_EXTENSION = '.scorm.zip';
/** Target runtime standard. SCORM 1.2 is the most universally supported. */
export const SCORM_SCHEMA_VERSION = '1.2';

/** One navigable unit inside the SCORM player. */
export type ScormSceneKind = 'slide' | 'quiz' | 'interactive' | 'pbl';

export interface ScormSlideScene {
  kind: 'slide';
  title: string;
  order: number;
  /** ZIP-relative path of the pre-rendered PNG snapshot, e.g. `slides/01_intro.png`. */
  imagePath: string;
  /** Narration transcript assembled from the scene's speech actions. */
  transcript?: string;
  /** ZIP-relative paths of narration audio tracks, in playback order. */
  audioPaths?: string[];
}

export interface ScormQuizQuestionData {
  id: string;
  type: 'single' | 'multiple' | 'short_answer';
  question: string;
  options?: { label: string; value: string }[];
  /** Correct answer values; absent for open text questions. */
  answer?: string[];
  analysis?: string;
  points?: number;
  hasAnswer?: boolean;
}

export interface ScormQuizScene {
  kind: 'quiz';
  title: string;
  order: number;
  questions: ScormQuizQuestionData[];
}

export interface ScormInteractiveScene {
  kind: 'interactive';
  title: string;
  order: number;
  /** ZIP-relative path of the self-contained (asset-inlined) HTML page. */
  htmlPath?: string;
  /** Original external URL, kept as fallback when HTML could not be embedded. */
  url?: string;
  transcript?: string;
  audioPaths?: string[];
}

export interface ScormPblScene {
  kind: 'pbl';
  title: string;
  order: number;
  /** Human-readable project brief rendered by the player. */
  summary?: string;
  transcript?: string;
}

export type ScormScene = ScormSlideScene | ScormQuizScene | ScormInteractiveScene | ScormPblScene;

/** Root payload written to `data/course.json` inside the package. */
export interface ScormCourseData {
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  course: {
    title: string;
    description?: string;
    language?: string;
  };
  /** Passing score (0–100) used for `cmi.core.lesson_status` on quizzes. */
  masteryScore: number;
  scenes: ScormScene[];
}

/** Options accepted by the manifest builder. */
export interface ScormManifestOptions {
  /** Unique package identifier, e.g. `openmaic.course.<uuid>`. */
  identifier: string;
  title: string;
  description?: string;
  /** File paths (ZIP-relative) referenced by the single SCO resource. */
  resourceFiles: string[];
  masteryScore: number;
}
