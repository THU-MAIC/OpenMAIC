import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { applicationChoices } from '@/lib/pbl/v3/application-choices';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import {
  indexProjectFiles,
  packageBuiltin,
  validateProjectPackage,
} from '@/lib/server/pbl-v3/project-package';

function fixture() {
  const base = installedProject({ id: 'greeting-python', version: '1.0.0' });
  const bundle = packageBuiltin(base);
  const descriptor = JSON.parse(bundle.files['project.json']);
  const selected = descriptor.definition.decisions[0].options.find(
    (option: { id: string }) => option.id === 'concat',
  );
  selected.previewLabel = 'Build the greeting by concatenation';
  const { project } = validateProjectPackage(
    indexProjectFiles(bundle.entry.id, bundle.entry.version, {
      ...bundle.files,
      'project.json': JSON.stringify(descriptor),
    }),
  );
  const definition = project.definition;
  const first = definition.milestones[0];
  const firstDecision = definition.decisions[0];
  const secondDecision = { ...base.definition.decisions[0], id: 'next-choice' };
  const second = { ...first, id: 'next-milestone', decisions: [secondDecision.id] };
  definition.milestones.push(second);
  definition.decisions.push(secondDecision);
  const state = startOrchestration(definition).state;
  const ids = [firstDecision.id, secondDecision.id];
  return { definition, state, ids, first, second, firstDecision, secondDecision };
}

describe('application preview choices', () => {
  it('shows a contextual preview label while keeping the short decision option', () => {
    const { definition, state, ids, first, firstDecision } = fixture();
    const option = firstDecision.options.find((candidate) => candidate.id === 'concat')!;
    expect(option.label).toBe('Concatenation');
    state.collected[first.id]!.decisions = [
      { id: firstDecision.id, chosen: option.id, revision: 1 },
    ];
    expect(applicationChoices(definition, state, ids)).toEqual([
      {
        id: firstDecision.id,
        label: firstDecision.desc,
        choice: 'Build the greeting by concatenation',
      },
    ]);
  });

  it('hides past decisions on transition and falls back to the label for older packages', () => {
    const { definition, state, ids, first, second, firstDecision, secondDecision } = fixture();
    state.collected[first.id]!.decisions = [
      { id: firstDecision.id, chosen: firstDecision.options[0].id, revision: 1 },
    ];
    state.position = { milestoneIndex: 1, milestoneId: second.id, stageIndex: 0 };
    expect(applicationChoices(definition, state, ids)).toEqual([]);
    state.collected[second.id]!.decisions = [
      { id: secondDecision.id, chosen: secondDecision.options[0].id, revision: 2 },
    ];
    expect(applicationChoices(definition, state, ids)).toEqual([
      {
        id: secondDecision.id,
        label: secondDecision.desc,
        choice: secondDecision.options[0].label,
      },
    ]);
    expect(state.collected[first.id]!.decisions).toHaveLength(1);
  });
});
