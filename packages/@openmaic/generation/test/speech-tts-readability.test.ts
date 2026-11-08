import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PROMPT_IDS, loadPrompt, loadSnippet } from '@openmaic/generation';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

const ACTION_PROMPTS = [
  PROMPT_IDS.SLIDE_ACTIONS,
  PROMPT_IDS.QUIZ_ACTIONS,
  PROMPT_IDS.INTERACTIVE_ACTIONS,
  PROMPT_IDS.PBL_ACTIONS,
] as const;

describe('speech TTS readability snippet', () => {
  test('keeps Greek letters as symbols and forbids the π homophone 派', () => {
    const snippet = loadSnippet('speech-tts-readability', PACKAGE_ROOT);

    // Formulas, operators, and units stay verbalized for the speech engine.
    expect(snippet).toContain('E equals m c squared');
    expect(snippet).toContain('\\frac{a}{b}');
    expect(snippet).toContain('greater than or equal to');

    // Captions, the HTML player, and the narration script show this text as-is.
    expect(snippet).toContain('从负π到正π');
    expect(snippet).toContain('一除以π');
    expect(snippet).toContain('from negative π to positive π');
    expect(snippet).toMatch(/never[^\n]*负派到正派/);
    expect(snippet).toMatch(/never[^\n]*一除以派/);

    // The blanket "spell every symbol out" rule is what wrote π as 派.
    expect(snippet).not.toContain('Spell out symbols');
    expect(snippet).not.toContain('Everything else in speech must be pronounceable words');
  });

  test('inlines the symbol-form rule into every actions prompt', () => {
    for (const promptId of ACTION_PROMPTS) {
      const prompt = loadPrompt(promptId, PACKAGE_ROOT);
      expect(prompt, promptId).not.toBeNull();
      expect(prompt!.systemPrompt, promptId).toContain('一除以π');
      expect(prompt!.systemPrompt, promptId).toContain('负派到正派');
    }
  });
});
