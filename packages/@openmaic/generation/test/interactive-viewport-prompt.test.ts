import { describe, expect, test } from 'vitest';
import { loadPrompt } from '@openmaic/generation';

const GENUI_PROMPT_IDS = [
  'simulation-content',
  'diagram-content',
  'game-content',
  'code-content',
  'visualization3d-content',
  'procedural-skill-content',
] as const;

describe('GenUI frame instruction', () => {
  test.each(GENUI_PROMPT_IDS)(
    '%s tells the model to fill a variable frame without scrolling',
    (id) => {
      const system = loadPrompt(id)?.systemPrompt ?? '';
      expect(system).toContain('## REQUIRED: fill the frame, never scroll the page');
      expect(system).toContain('at least 1280×720 CSS pixels');
      expect(system).toContain('no page-level scrolling');
      expect(system).toContain('fixed narrow column');
      expect(system).not.toContain('{{snippet:');
    },
  );

  test('the simulation prompt no longer steers toward a scrollable mobile-first stack', () => {
    const system = loadPrompt('simulation-content')?.systemPrompt ?? '';
    expect(system).not.toMatch(/320px/);
    expect(system).not.toMatch(/overflow-auto max-h-\[40vh\]/);
  });
});
