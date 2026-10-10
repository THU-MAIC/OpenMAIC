/**
 * The briefing of a PBL scene: what a learner reads before the project starts.
 *
 * Shared by the exports that cannot run the project themselves (the standalone
 * HTML player, the PPTX placeholder slide). Authority between the current and
 * the legacy representation is decided exactly as the classroom decides it
 * (`resolvePBLContent`); a legacy project is upgraded the same way the
 * classroom upgrades it. Runtime state (threads, submissions, evaluations),
 * role prompts and the legacy chat are never part of the briefing.
 */
import { resolvePBLContent, upgradeLegacyPBLConfigToProjectV2 } from '@/lib/pbl/legacy/read';
import type { PBLContent } from '@/lib/types/stage';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The briefing of `content`, or null when it has no readable project. */
export function pblBriefing(content: PBLContent) {
  const resolved = resolvePBLContent(content);
  const project =
    resolved.kind === 'v2'
      ? resolved.projectV2
      : resolved.kind === 'legacy'
        ? upgradeLegacyPBLConfigToProjectV2(resolved.projectConfig)
        : undefined;
  if (!project) return null;
  const scenario = isRecord(project.scenario) ? project.scenario : undefined;
  return {
    title: project.title,
    description: project.description,
    learningObjective: project.learningObjective,
    scenario: scenario && {
      setting: scenario.setting,
      goal: scenario.goal,
      learnerRole: scenario.learnerRole,
      characters: (scenario.characters ?? [])
        .filter(isRecord)
        .map((character) => ({ name: character.name, persona: character.persona })),
    },
    milestones: (project.milestones ?? []).filter(isRecord).map((milestone) => ({
      title: milestone.title,
      description: milestone.description,
      order: milestone.order,
      microtasks: (milestone.microtasks ?? []).filter(isRecord).map((task) => ({
        title: task.title,
        description: task.description,
        learnerBrief: task.learnerBrief,
        order: task.order,
      })),
    })),
  };
}

export type PblBriefing = NonNullable<ReturnType<typeof pblBriefing>>;
