import 'server-only';
import type { StageDefinition } from '@/lib/pbl/v3/domain/project/project-schema';

/** The existing runtime's default teaching sections, shared with built-in package export. */
export function stageSkill(stage: StageDefinition) {
  const progression =
    stage.kind === 'produce'
      ? stage.writes === 'plan'
        ? ['SKILL.md', 'A-generate.md', 'B-understand.md', 'C-review.md', 'D-approve.md']
        : ['SKILL.md', 'A-implement.md', 'B-understand.md', 'C-review.md', 'D-confirm.md']
      : ['SKILL.md', 'A-teach.md', 'B-dialogue.md', 'C-reflect.md'];
  const content = Object.fromEntries(
    progression
      .slice(1)
      .map((name) => [
        name,
        name.startsWith('A-')
          ? 'Introduce this step and produce the appropriate initial work. Explain one manageable part.'
          : name.startsWith('B-')
            ? 'Ask the learner to explain the work in their own words. Address gaps before accepting their understanding.'
            : name === progression.at(-1)
              ? 'Review the current artifact and the learner’s explanation. Request a specific final check and wait for the learner’s next reply.'
              : 'Review the work against the contract and decisions. Ask the learner to check a concrete example.',
      ]),
  );
  return { content, progression };
}
