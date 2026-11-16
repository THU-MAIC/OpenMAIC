import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DESIGN_TOKENS,
  generateDesignTokenCss,
  generateSceneContent,
  generateWidgetContent,
  injectDesignTokenCss,
  isColorDark,
  resolveDesignTokens,
  type AICallFn,
  type SceneOutline,
} from '@openmaic/generation';

describe('interactive design tokens', () => {
  test('resolves an explicit structured palette without parsing prose', () => {
    const tokens = resolveDesignTokens({
      background: '#0b0f19',
      surface: '#151c2e',
      text: '#f1f5f9',
      muted: '#94a3b8',
      border: '#334155',
      accent: '#38bdf8',
    });
    expect(tokens).toMatchObject({
      background: '#0b0f19',
      surface: '#151c2e',
      text: '#f1f5f9',
      mutedText: '#94a3b8',
      border: '#334155',
      accent: '#38bdf8',
      isDark: true,
    });
    expect(resolveDesignTokens()).toEqual(DEFAULT_DESIGN_TOKENS);
    expect(isColorDark('#ffffff')).toBe(false);
  });

  test('injects only variables and does not override page backgrounds', () => {
    const css = generateDesignTokenCss(DEFAULT_DESIGN_TOKENS);
    expect(css).toContain('--color-background: #ffffff;');
    expect(css).toContain('--color-accent: #2563eb;');
    expect(css).not.toContain('!important');
    expect(css).not.toContain('bg-black');
    expect(css).not.toContain('bg-slate-900');
  });

  test('injects the token block once', () => {
    const html = '<!DOCTYPE html><html><head></head><body>Content</body></html>';
    const injected = injectDesignTokenCss(html, DEFAULT_DESIGN_TOKENS);
    expect(injected).toContain('<style data-openmaic-theme-tokens>');
    expect(injectDesignTokenCss(injected, DEFAULT_DESIGN_TOKENS)).toBe(injected);
  });

  test('passes the caller palette to widget prompts and output HTML', async () => {
    let capturedSystem = '';
    const aiCall: AICallFn = async (system) => {
      capturedSystem = system;
      return '<!DOCTYPE html><html><head></head><body><div>Simulation</div></body></html>';
    };
    const outline: SceneOutline = {
      id: 'scene-interactive-1',
      type: 'interactive',
      title: 'Wave Interference',
      description: 'Explore interference.',
      keyPoints: ['Wavelength'],
      order: 1,
      widgetType: 'simulation',
      widgetOutline: { concept: 'Wave Interference', designIdea: 'Use a different theme.' },
    };
    const tokens = resolveDesignTokens({
      background: '#0f172a',
      surface: '#1e293b',
      text: '#f8fafc',
      muted: '#94a3b8',
      border: '#334155',
      accent: '#38bdf8',
    });
    const result = await generateSceneContent(outline, aiCall, { tokens });
    expect(capturedSystem).toContain('The course style is **Dark**');
    expect(capturedSystem).toContain('#0f172a');
    expect(capturedSystem).not.toContain('Strict Light guarantee');
    expect(result && 'html' in result ? result.html : '').toContain('--color-background: #0f172a;');
  });

  test('uses the default palette when no palette is supplied', async () => {
    let capturedSystem = '';
    const aiCall: AICallFn = async (system) => {
      capturedSystem = system;
      return '<!DOCTYPE html><html><head></head><body><div>Game</div></body></html>';
    };
    const outline: SceneOutline = {
      id: 'scene-interactive-2',
      type: 'interactive',
      title: 'Quiz',
      description: 'Practice.',
      keyPoints: [],
      order: 2,
      widgetType: 'game',
      widgetOutline: { concept: 'Quiz', designIdea: 'dark background #000000' },
    };
    const result = await generateWidgetContent(outline, aiCall);
    expect(capturedSystem).toContain('The course style is **Light**');
    expect(result?.html).toContain('--color-background: #ffffff;');
  });
});
