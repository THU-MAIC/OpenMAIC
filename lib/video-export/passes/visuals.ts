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
import type { CompilerScene } from '../deps';
import type { Diagnostic, PblCoverVisual, VideoTimelineScene, VisualSegment } from '../ir';
import {
  isRunnablePblV2CoverProject,
  isUsableLegacyCoverConfig,
  pblLegacyCover,
} from '../legacy/read';

export interface VisualsResult {
  scenes: VideoTimelineScene[];
  diagnostics: Diagnostic[];
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
): VisualsResult {
  const diagnostics: Diagnostic[] = [];
  const scenes = timelineScenes.map((timeline, index): VideoTimelineScene => {
    const source = sourceScenes[index];
    if (!source || (source.type !== 'quiz' && source.type !== 'pbl')) return timeline;

    const visual =
      source.type === 'quiz' ? quizCover(source, timeline) : pblCover(source, timeline);
    diagnostics.push({
      severity: 'info',
      code: 'cover-card',
      sceneId: timeline.id,
      message: `Scene "${timeline.title}" (${timeline.type}) is rendered as a deterministic static cover card.`,
    });
    return {
      ...timeline,
      supported: true,
      base: { kind: 'visual-segments' },
      visuals: [visual],
    };
  });
  return { scenes, diagnostics };
}
