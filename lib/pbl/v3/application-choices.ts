import type { ProjectDefinition } from './domain/project/project-schema';
import type { PblSessionState } from './domain/orchestration/types';

/** Read-only intent shared by the learner panel and role-scoped product context. */
export function applicationChoices(
  definition: ProjectDefinition,
  state: PblSessionState,
  ids: readonly string[] = [],
) {
  return ids.flatMap((id) => {
    const decision = definition.decisions.find((item) => item.id === id);
    if (!decision || decision.responseType === 'text') return [];
    const record = definition.milestones
      .slice(0, state.position.milestoneIndex + 1)
      .flatMap((item) => state.collected[item.id]?.decisions ?? [])
      .findLast((item) => item.id === id);
    const option = decision.options.find((item) => item.id === record?.chosen);
    return option ? [{ id, label: decision.desc, choice: option.label }] : [];
  });
}
