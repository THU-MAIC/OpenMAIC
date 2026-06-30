import { describe, expect, test } from 'vitest';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

function outlinePromptText() {
  const prompt = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
    requirement: 'Create a role-play PBL where I practise comforting a stressed friend',
    pdfContent: 'None',
    availableImages: 'No images available',
    userProfile: '',
    researchContext: 'None',
    teacherContext: '',
    hasSourceImages: false,
    imageEnabled: false,
    videoEnabled: false,
    mediaEnabled: false,
  });
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('requirements-to-outlines PBL prompt', () => {
  test('documents scenario role-play PBL flags in pblConfig', () => {
    const text = outlinePromptText();

    expect(text).toContain('Role-play scenario PBL');
    expect(text).toContain('scenarioRoleplay: true');
    expect(text).toContain('scenarioBrief');
    expect(text).toContain('downstream runtime switch');
    expect(text).toContain('Omit `scenarioRoleplay` and `scenarioBrief`');
    expect(text).not.toContain('{{');
  });
});
