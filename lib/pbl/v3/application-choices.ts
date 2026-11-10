import type { ProjectDefinition } from './domain/project/project-schema';
import type { PblSessionState } from './domain/orchestration/types';

/** Read-only intent shared by the learner panel and role-scoped product context. */
export function applicationChoices(
  definition: ProjectDefinition,
  state: PblSessionState,
  ids: readonly string[] = [],
) {
  const milestone = definition.milestones[state.position.milestoneIndex];
  if (!milestone) return [];
  const records = state.collected[milestone.id]?.decisions ?? [];
  return ids.flatMap((id) => {
    if (!milestone.decisions.includes(id)) return [];
    const decision = definition.decisions.find((item) => item.id === id);
    if (!decision || decision.responseType === 'text') return [];
    const record = records.findLast((item) => item.id === id);
    const option = decision.options.find((item) => item.id === record?.chosen);
    return option
      ? [{ id, label: decision.desc, choice: option.previewLabel ?? option.label }]
      : [];
  });
}
