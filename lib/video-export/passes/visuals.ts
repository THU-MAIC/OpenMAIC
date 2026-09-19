/**
 * `visuals` pass — derive deterministic Quiz/PBL cover cards from authored data.
 *
 * This pass uses structural narrowing for current content and delegates legacy
 * PBL reads to the permanent read-only adapter. Only learner-visible design
 * fields enter the IR; quiz answers, threads, submissions, progress and internal
 * personas are ignored.
 *
 * Pure: no IO, clock, randomness, DOM, React, or app-layer imports.
 */
import type { CompilerScene, QuizLayoutMeasurement, QuizLayoutProbe } from '../deps';
import type {
  Diagnostic,
  PblCoverVisual,
  QuizQuestionListQuestion,
  QuizQuestionListVisual,
  VideoTimelineScene,
  VisualSegment,
} from '../ir';
import {
  isRunnablePblV2CoverProject,
  isUsableLegacyCoverConfig,
  pblLegacyCover,
} from '../legacy/read';

export interface VisualsResult {
  scenes: VideoTimelineScene[];
  diagnostics: Diagnostic[];
  /** Per-scene duration inserted after the original authored scene timeline. */
  extensionsMs: number[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function quizOption(value: unknown, index: number): { value: string; label: string } | null {
  if (typeof value === 'string') {
    const label = text(value);
    return label ? { value: String.fromCharCode(65 + index), label } : null;
  }
  if (!isRecord(value)) return null;
  const optionValue = text(value.value);
  const label = text(value.label);
  return optionValue && label ? { value: optionValue, label } : null;
}

/**
 * Project a Quiz scene onto the complete learner-visible field whitelist used
 * by export. This is the only path from authored Quiz data into question-list
 * IR, so answer keys and runtime state cannot leak into the emitter.
 */
export function prepareQuizQuestionList(scene: CompilerScene): QuizQuestionListQuestion[] {
  const raw = Array.isArray(scene.content?.questions) ? scene.content.questions : [];
  const questions: QuizQuestionListQuestion[] = [];
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const id = text(value.id);
    const question = text(value.question);
    const type = value.type;
    if (!id || !question || (type !== 'single' && type !== 'multiple' && type !== 'short_answer')) {
      continue;
    }
    if (type === 'short_answer') {
      questions.push({ id, type, question });
      continue;
    }
    const options = Array.isArray(value.options)
      ? value.options
          .map((option, index) => quizOption(option, index))
          .filter((option): option is { value: string; label: string } => option !== null)
      : [];
    questions.push({ id, type, question, options });
  }
  return questions;
}

const QUIZ_TRANSITION_MS = 600;
const QUIZ_TOP_HOLD_MS = 1200;
const QUIZ_BOTTOM_HOLD_MS = 1200;
const QUIZ_SCROLL_PX_PER_SECOND_720P = 96;
const QUIZ_MIN_SCROLL_MS = 4000;
const QUIZ_MAX_SCROLL_MS = 24_000;

function validMeasurement(value: QuizLayoutMeasurement | null): value is QuizLayoutMeasurement {
  return (
    value !== null &&
    Number.isFinite(value.contentHeightPx) &&
    value.contentHeightPx > 0 &&
    Number.isFinite(value.viewportHeightPx) &&
    value.viewportHeightPx > 0 &&
    Number.isFinite(value.frameHeightPx) &&
    value.frameHeightPx > 0
  );
}

function quizQuestionListVisual(
  source: CompilerScene,
  timeline: VideoTimelineScene,
  questions: QuizQuestionListQuestion[],
  measurement: QuizLayoutMeasurement,
): QuizQuestionListVisual {
  const scrollDistancePx = Math.max(0, measurement.contentHeightPx - measurement.viewportHeightPx);
  const targetPixelsPerSecond = QUIZ_SCROLL_PX_PER_SECOND_720P * (measurement.frameHeightPx / 720);
  const unclampedScrollMs = Math.round((scrollDistancePx / targetPixelsPerSecond) * 1000);
  const scrollDurationMs =
    scrollDistancePx === 0
      ? 0
      : Math.min(QUIZ_MAX_SCROLL_MS, Math.max(QUIZ_MIN_SCROLL_MS, unclampedScrollMs));
  const pixelsPerSecond = scrollDurationMs === 0 ? 0 : scrollDistancePx / (scrollDurationMs / 1000);
  const durationMs = QUIZ_TRANSITION_MS + QUIZ_TOP_HOLD_MS + scrollDurationMs + QUIZ_BOTTOM_HOLD_MS;
  return {
    kind: 'quiz-question-list',
    startMs: timeline.startMs + timeline.durationMs,
    durationMs,
    title: source.title,
    questions,
    contentHeightPx: measurement.contentHeightPx,
    viewportHeightPx: measurement.viewportHeightPx,
    scrollDistancePx,
    pixelsPerSecond,
    transitionDurationMs: QUIZ_TRANSITION_MS,
    topHoldDurationMs: QUIZ_TOP_HOLD_MS,
    scrollDurationMs,
    bottomHoldDurationMs: QUIZ_BOTTOM_HOLD_MS,
  };
}

function quizCover(scene: CompilerScene, timeline: VideoTimelineScene): VisualSegment {
  const questions = Array.isArray(scene.content?.questions) ? scene.content.questions : [];
  const totalPoints = questions.reduce((sum, question) => {
    if (!isRecord(question)) return sum + 1;
    const points = question.points;
    return sum + (typeof points === 'number' && Number.isFinite(points) ? points : 1);
  }, 0);
  return {
    kind: 'quiz-cover',
    startMs: timeline.startMs,
    durationMs: timeline.durationMs,
    title: scene.title,
    questionCount: questions.length,
    totalPoints,
  };
}

function pblV2Cover(
  project: UnknownRecord,
  scene: CompilerScene,
  timeline: VideoTimelineScene,
): PblCoverVisual {
  const milestones = records(project.milestones);
  const roles = records(project.roles);
  const instructor = roles.find(
    (role) => role.type === 'instructor' && role.id !== 'role-compat-instructor',
  );
  const authoredGains = Array.isArray(project.gains)
    ? project.gains.map(text).filter((gain): gain is string => gain !== undefined)
    : [];
  const learningObjective = text(project.learningObjective);
  const gains =
    authoredGains.length > 0 ? authoredGains : learningObjective ? [learningObjective] : [];
  const scenario = isRecord(project.scenario) ? project.scenario : undefined;
  const scenarioCharacter = records(scenario?.characters)[0];
  const instructorName = text(instructor?.name);
  const instructorDescription = text(instructor?.description);
  const scenarioCharacterName = text(scenarioCharacter?.name);

  return {
    kind: 'pbl-cover',
    startMs: timeline.startMs,
    durationMs: timeline.durationMs,
    title: text(project.title) ?? scene.title,
    description: text(project.description) ?? '',
    gains,
    stageCount: milestones.length,
    taskCount: milestones.reduce((sum, milestone) => sum + records(milestone.microtasks).length, 0),
    ...(instructorName ? { instructorName } : {}),
    ...(instructorDescription ? { instructorDescription } : {}),
    ...(scenarioCharacterName ? { scenarioCharacterName } : {}),
  };
}

function pblCover(scene: CompilerScene, timeline: VideoTimelineScene): PblCoverVisual {
  const projectV2 = scene.content?.projectV2;
  const projectConfig =
    scene.content && isRecord(scene.content.projectConfig)
      ? scene.content.projectConfig
      : undefined;
  // On a hybrid scene a damaged or non-runnable v2 payload must not shadow usable legacy data:
  // the renderer falls back to the legacy config there, and the exported cover
  // has to agree with what the classroom shows. When the legacy config is
  // absent, empty, or garbage (the renderer would not show it either), the
  // cover keeps reading a partial v2 payload defensively — a sparse cover
  // beats an empty one, and there is nothing usable to diverge from.
  const legacyUsable = isUsableLegacyCoverConfig(projectConfig);
  const v2Runnable = isRunnablePblV2CoverProject(projectV2);
  if (isRecord(projectV2) && (v2Runnable || !legacyUsable)) {
    return pblV2Cover(projectV2, scene, timeline);
  }
  return pblLegacyCover(projectConfig ?? {}, scene, timeline);
}

export function applyVisuals(
  timelineScenes: readonly VideoTimelineScene[],
  sourceScenes: readonly CompilerScene[],
  quizLayout?: QuizLayoutProbe,
): VisualsResult {
  const diagnostics: Diagnostic[] = [];
  const extensionsMs = timelineScenes.map(() => 0);
  const scenes = timelineScenes.map((timeline, index): VideoTimelineScene => {
    const source = sourceScenes[index];
    if (!source || (source.type !== 'quiz' && source.type !== 'pbl')) return timeline;

    const visual =
      source.type === 'quiz' ? quizCover(source, timeline) : pblCover(source, timeline);
    let visuals: VisualSegment[] = [visual];
    if (source.type === 'quiz') {
      const questions = prepareQuizQuestionList(source);
      if (questions.length > 0) {
        let measurement: QuizLayoutMeasurement | null = null;
        if (quizLayout) {
          try {
            measurement = quizLayout.measureQuestionList(source);
          } catch {
            measurement = null;
          }
        }
        if (validMeasurement(measurement)) {
          const list = quizQuestionListVisual(source, timeline, questions, measurement);
          extensionsMs[index] = list.durationMs;
          visuals = [
            { ...visual, durationMs: timeline.durationMs + list.transitionDurationMs },
            list,
          ];
        } else {
          diagnostics.push({
            severity: 'warn',
            code: 'quiz-layout-unavailable',
            sceneId: timeline.id,
            message: `Quiz question-list layout was unavailable for scene "${timeline.title}"; using the deterministic cover-only fallback.`,
          });
        }
      }
    }
    diagnostics.push({
      severity: 'info',
      code: 'cover-card',
      sceneId: timeline.id,
      message:
        timeline.type === 'quiz' && visuals.some((item) => item.kind === 'quiz-question-list')
          ? `Scene "${timeline.title}" (quiz) is rendered as a deterministic cover-to-question-list sequence.`
          : `Scene "${timeline.title}" (${timeline.type}) is rendered as a deterministic static cover card.`,
    });
    return {
      ...timeline,
      supported: true,
      base: { kind: 'visual-segments' },
      visuals,
    };
  });
  return { scenes, diagnostics, extensionsMs };
}
