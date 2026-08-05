/**
 * `visuals` pass — derive deterministic Quiz/PBL cover cards from authored data.
 *
 * This pass deliberately uses local structural narrowing rather than importing
 * app PBL/runtime types. Only learner-visible design fields enter the IR; quiz
 * answers, PBL threads, submissions, progress and internal personas are ignored.
 *
 * Pure: no IO, clock, randomness, DOM, React, or app-layer imports.
 */
import type { CompilerScene } from '../deps';
import type { Diagnostic, PblCoverVisual, VideoTimelineScene, VisualSegment } from '../ir';

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

function legacyIssueRoot(
  issue: UnknownRecord,
  issueById: ReadonlyMap<unknown, UnknownRecord>,
): UnknownRecord | undefined {
  let current = issue;
  const visited = new Set<UnknownRecord>();

  while (current.parent_issue !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const parent = issueById.get(current.parent_issue);
    if (!parent) return undefined;
    current = parent;
  }

  return current;
}

/**
 * Counts authored stages on a legacy issueboard: every root contributes one
 * stage, and an orphan or cycle issue stands alone so a malformed board still
 * yields a stable count instead of vanishing from the cover.
 */
function legacyStageCount(issues: readonly UnknownRecord[]): number {
  const issueById = new Map<unknown, UnknownRecord>();
  for (const issue of issues) issueById.set(issue.id, issue);

  const roots = new Set<UnknownRecord>();
  let standaloneCount = 0;
  for (const issue of issues) {
    const root = legacyIssueRoot(issue, issueById);
    if (root) roots.add(root);
    else standaloneCount += 1;
  }
  return roots.size + standaloneCount;
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

/**
 * A legacy (v1) project has no instructor to put on the cover, so it never
 * names one.
 *
 * Its roster is the 2–4 *development roles the learner chooses between* — the
 * design prompt asks for "Data Analyst", "Frontend Developer" and the like —
 * plus the `Question Agent - <issue>` / `Judge Agent - <issue>` helpers the
 * issueboard spawns per issue. Promoting any of them would print a student
 * role, or a machine name, under a "Tutor" label. Picking by the issueboard's
 * active issue would additionally tie the cover to learner progress. Both are
 * worse than the card simply not claiming an instructor.
 */
function pblLegacyCover(
  project: UnknownRecord,
  scene: CompilerScene,
  timeline: VideoTimelineScene,
): PblCoverVisual {
  const projectInfo = isRecord(project.projectInfo) ? project.projectInfo : {};
  const issueboard = isRecord(project.issueboard) ? project.issueboard : {};
  const issues = records(issueboard.issues);
  return {
    kind: 'pbl-cover',
    startMs: timeline.startMs,
    durationMs: timeline.durationMs,
    title: text(projectInfo.title) ?? scene.title,
    description: text(projectInfo.description) ?? '',
    gains: [],
    stageCount: legacyStageCount(issues),
    taskCount: issues.length,
  };
}

function pblCover(scene: CompilerScene, timeline: VideoTimelineScene): PblCoverVisual {
  const projectV2 =
    scene.content && isRecord(scene.content.projectV2) ? scene.content.projectV2 : undefined;
  if (projectV2) return pblV2Cover(projectV2, scene, timeline);

  const projectConfig =
    scene.content && isRecord(scene.content.projectConfig) ? scene.content.projectConfig : {};
  return pblLegacyCover(projectConfig, scene, timeline);
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
