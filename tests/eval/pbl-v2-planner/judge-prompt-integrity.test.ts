import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const promptPaths = [
  'eval/pbl-v2-planner/judge-prompt.md',
  'eval/pbl-v2-planner/judge-prompt-scenario.md',
  'eval/pbl-v2-planner/judge-prompt-completability.md',
];

function readPrompt(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('PBL v2 judge prompt integrity', () => {
  it('does not contain stale XML/tool wrapper tags', () => {
    for (const path of promptPaths) {
      const text = readPrompt(path);

      expect(text).not.toContain('</content>');
      expect(text).not.toContain('</invoke>');
    }
  });

  it('treats scenario learnerBrief as learner-visible judge input', () => {
    const text = readPrompt('eval/pbl-v2-planner/judge-prompt-scenario.md');

    expect(text).toContain(
      'successWhen` / `characterObjective` / `skillFocus` / `learnerBrief` / `narration`',
    );
    expect(text).toContain('`description` / `learnerBrief` / `narration`');
    expect(text).toContain("a beat's `description` / `learnerBrief` / `narration`");
  });
});
