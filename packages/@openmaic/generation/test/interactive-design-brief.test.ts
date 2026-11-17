import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  generateSceneContent,
  generateWidgetContent,
  PROMPT_IDS,
  type AICallFn,
  type SceneOutline,
} from '@openmaic/generation';

const DESIGN_STYLE = 'Dark slate #0f172a, cards #1e293b, text #f8fafc, accent sky blue #38bdf8';

function capture(): { aiCall: AICallFn; user: () => string; system: () => string } {
  let user = '';
  let system = '';
  const aiCall: AICallFn = async (sys, prompt) => {
    system = sys;
    user = prompt;
    return '<!DOCTYPE html><html><head></head><body><div>Content</div></body></html>';
  };
  return { aiCall, user: () => user, system: () => system };
}

describe('interactive design brief', () => {
  it('threads course visual style into simulation widget prompt', async () => {
    const { aiCall, user } = capture();
    const outline: SceneOutline = {
      id: 'scene-sim-1',
      type: 'interactive',
      title: 'Wave Interference',
      description: 'Explore wave interference.',
      keyPoints: ['Wavelength and frequency'],
      order: 1,
      widgetType: 'simulation',
      widgetOutline: { concept: 'Wave Interference' },
      design: DESIGN_STYLE,
    };

    const result = await generateSceneContent(outline, aiCall);
    const prompt = user();

    expect(prompt).toContain('## Course Visual Style');
    expect(prompt).toContain('Follow this style for page background, panels, text and accent colours:');
    expect(prompt).toContain(DESIGN_STYLE);
    expect(result && 'html' in result ? result.html : '').not.toContain('data-openmaic-theme-tokens');
  });

  it('threads course visual style into all widget types', async () => {
    const widgetTypes: Array<NonNullable<SceneOutline['widgetType']>> = [
      'simulation',
      'diagram',
      'code',
      'game',
      'visualization3d',
    ];

    for (const widgetType of widgetTypes) {
      const { aiCall, user } = capture();
      const outline: SceneOutline = {
        id: `scene-${widgetType}`,
        type: 'interactive',
        title: `Test ${widgetType}`,
        description: `Description for ${widgetType}`,
        keyPoints: ['Key point 1'],
        order: 1,
        widgetType,
        widgetOutline: { concept: `Concept ${widgetType}` },
        design: DESIGN_STYLE,
      };

      await generateWidgetContent(outline, aiCall);
      const prompt = user();
      expect(prompt).toContain('## Course Visual Style');
      expect(prompt).toContain('Follow this style for page background, panels, text and accent colours:');
      expect(prompt).toContain(DESIGN_STYLE);
    }
  });

  it('omits Course Visual Style section when design is absent or empty', async () => {
    for (const design of [undefined, '', '   ']) {
      const { aiCall, user } = capture();
      const outline: SceneOutline = {
        id: 'scene-no-design',
        type: 'interactive',
        title: 'Wave Interference',
        description: 'Explore wave interference.',
        keyPoints: ['Wavelength'],
        order: 1,
        widgetType: 'simulation',
        widgetOutline: { concept: 'Wave Interference' },
        ...(design !== undefined ? { design } : {}),
      };

      await generateWidgetContent(outline, aiCall);
      const prompt = user();
      expect(prompt).not.toContain('Course Visual Style');
      expect(prompt).not.toContain('Follow this style for page background');
    }
  });

  it('leaves the simulation prompt without design byte-identical to base template', () => {
    const baseVars = {
      conceptName: 'Gravity',
      conceptOverview: 'Overview of gravity',
      keyPoints: 'Point 1',
      variables: 'g: 9.8',
      designIdea: 'Idea',
      languageDirective: '',
    };
    const withoutDesign = buildPrompt(PROMPT_IDS.SIMULATION_CONTENT, { ...baseVars, design: '' });
    const withDesign = buildPrompt(PROMPT_IDS.SIMULATION_CONTENT, { ...baseVars, design: DESIGN_STYLE });

    expect(withoutDesign).not.toBeNull();
    expect(withDesign).not.toBeNull();
    expect(withoutDesign!.user).not.toContain('Course Visual Style');
    expect(withDesign!.user).toContain('## Course Visual Style');
    expect(withDesign!.user).toContain(DESIGN_STYLE);

    const section = withDesign!.user.slice(
      withDesign!.user.indexOf('## Course Visual Style'),
      withDesign!.user.indexOf('## Language'),
    );
    expect(withDesign!.user.replace(section, '')).toBe(withoutDesign!.user);
    expect(withDesign!.system).toBe(withoutDesign!.system);
  });

  it('3D template system prompt does not unconditionally force dark background', () => {
    const prompt = buildPrompt(PROMPT_IDS.VISUALIZATION3D_CONTENT, {
      title: 'Solar System',
      visualizationType: 'astronomy',
      description: 'Orbits',
      keyPoints: 'Planets',
      objects: [],
      interactions: [],
      languageDirective: '',
    });
    expect(prompt).not.toBeNull();
    expect(prompt!.system).toContain('follow the course visual style when given');
    expect(prompt!.system).not.toContain('var(--color-background)');
    expect(prompt!.system).not.toContain('interactive-theme-tokens');
  });
});
