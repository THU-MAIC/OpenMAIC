import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '@/lib/pbl/v3/domain/orchestration/prompts';

describe('PBL role prompt context', () => {
  it.each(['Help with the current task.', 'Current task: {{seed}}'])(
    'preserves mandatory context with a course-authored template: %s',
    (systemPrompt) => {
      const seed = {
        referenceMaterials: [{ path: 'docs/brief.md', text: "Keep $&, $` and $' literal." }],
      };
      const prompt = buildSystemPrompt({
        role: 'coder',
        project: { agents: { coder: { systemPrompt } } },
        seed,
      });
      expect(prompt).toContain(JSON.stringify(seed));
      expect(prompt).not.toContain('{{seed}}');
      expect(prompt.split(JSON.stringify(seed))).toHaveLength(2);
    },
  );
});
