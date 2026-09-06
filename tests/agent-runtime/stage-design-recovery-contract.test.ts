import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSkill = (name: string) =>
  readFileSync(resolve(process.cwd(), `skills/agent-runtime/${name}/SKILL.md`), 'utf8').replace(
    /\s+/g,
    ' ',
  );

describe('stage-design generation recovery contract', () => {
  it('bounds retries per page without abandoning the stage', () => {
    const skill = readSkill('stage-design');

    for (const instruction of [
      '`stageId + order`',
      'does not reset the attempt',
      '`prompt-unavailable`',
      'do not repeat the same call',
      '`invalid-model-output`',
      'retry once',
      'continue with later pages in the same stage',
      '`ask_user` after every failed page',
      'silently drop the page from the settled plan',
      'it is not done',
    ]) {
      expect(skill, instruction).toContain(instruction);
    }
  });

  it('keeps the series layer delegated to stage-design', () => {
    const skill = readSkill('curriculum-planner');

    expect(skill).toContain(
      'Page recovery follows `stage-design`; one failed page does not abort the rest of the series.',
    );
    expect(skill).not.toContain('`prompt-unavailable`');
    expect(skill).not.toContain('`invalid-model-output`');
  });
});
