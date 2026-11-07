import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DESIGN_TOKENS,
  deriveDesignTokens,
  generateDesignTokenCss,
  generateWidgetContent,
  generateSceneContent,
  injectDesignTokenCss,
  isColorDark,
  type AICallFn,
  type SceneOutline,
  type CourseDesignTokens,
} from '@openmaic/generation';

describe('interactive design tokens (#2207)', () => {
  describe('deriveDesignTokens', () => {
    test('returns default light tokens when input is absent or empty', () => {
      expect(deriveDesignTokens()).toEqual(DEFAULT_DESIGN_TOKENS);
      expect(deriveDesignTokens('')).toEqual(DEFAULT_DESIGN_TOKENS);
      expect(deriveDesignTokens('   ')).toEqual(DEFAULT_DESIGN_TOKENS);
      expect(deriveDesignTokens().isDark).toBe(false);
      expect(deriveDesignTokens().background).toBe('#ffffff');
      expect(deriveDesignTokens().accent).toBe('#2563eb');
    });

    test('derives preset tokens correctly', () => {
      const dark = deriveDesignTokens('dark');
      expect(dark.isDark).toBe(true);
      expect(dark.background).toBe('#0f172a');
      expect(dark.text).toBe('#f8fafc');

      const paper = deriveDesignTokens('paper');
      expect(paper.isDark).toBe(false);
      expect(paper.background).toBe('#fbf8f1');
      expect(paper.accent).toBe('#b45309');

      const graphite = deriveDesignTokens('graphite');
      expect(graphite.isDark).toBe(true);
      expect(graphite.background).toBe('#181a1b');

      const highContrast = deriveDesignTokens('high-contrast');
      expect(highContrast.isDark).toBe(false);
      expect(highContrast.background).toBe('#ffffff');
      expect(highContrast.text).toBe('#000000');
    });

    test('derives tokens from natural language design brief', () => {
      const brief =
        'Slide design: Dark background (#0b0f19), cyan accent (#38bdf8), slate surface (#151c2e), white text (#f1f5f9)';
      const tokens = deriveDesignTokens(brief);
      expect(tokens.isDark).toBe(true);
      expect(tokens.background).toBe('#0b0f19');
      expect(tokens.accent).toBe('#38bdf8');
      expect(tokens.surface).toBe('#151c2e');
      expect(tokens.text).toBe('#f1f5f9');
    });

    test('correctly identifies dark colors with isColorDark', () => {
      expect(isColorDark('#000000')).toBe(true);
      expect(isColorDark('#0f172a')).toBe(true);
      expect(isColorDark('#181a1b')).toBe(true);
      expect(isColorDark('black')).toBe(true);
      expect(isColorDark('#ffffff')).toBe(false);
      expect(isColorDark('#f8fafc')).toBe(false);
      expect(isColorDark('#fbf8f1')).toBe(false);
    });
  });

  describe('generateDesignTokenCss & injectDesignTokenCss', () => {
    test('generates CSS variables for all required tokens', () => {
      const css = generateDesignTokenCss(DEFAULT_DESIGN_TOKENS);
      expect(css).toContain('--color-background: #ffffff;');
      expect(css).toContain('--color-surface: #f8fafc;');
      expect(css).toContain('--color-text: #0f172a;');
      expect(css).toContain('--color-ink: #0f172a;');
      expect(css).toContain('--color-muted: #64748b;');
      expect(css).toContain('--color-border: #e2e8f0;');
      expect(css).toContain('--color-accent: #2563eb;');
      expect(css).toContain('--font-family: system-ui, -apple-system, sans-serif;');
    });

    test('enforces strict light rules in light mode', () => {
      const lightCss = generateDesignTokenCss(DEFAULT_DESIGN_TOKENS);
      expect(lightCss).toContain('background-color: #ffffff !important;');
      expect(lightCss).toContain('body > [class*="bg-black"]');
      expect(lightCss).toContain('body > [class*="bg-slate-900"]');

      const darkTokens: CourseDesignTokens = {
        ...DEFAULT_DESIGN_TOKENS,
        background: '#0f172a',
        text: '#f8fafc',
        isDark: true,
      };
      const darkCss = generateDesignTokenCss(darkTokens);
      expect(darkCss).not.toContain('body > [class*="bg-black"]');
      expect(darkCss).toContain('background-color: var(--color-background) !important;');
    });

    test('injects CSS token block into HTML head and prevents duplicate injection', () => {
      const sampleHtml =
        '<!DOCTYPE html><html><head><title>Test</title></head><body>Content</body></html>';
      const injected = injectDesignTokenCss(sampleHtml, DEFAULT_DESIGN_TOKENS);
      expect(injected).toContain('<style data-openmaic-theme-tokens>');
      expect(injected).toContain('--color-background: #ffffff;');
      expect(injected).toContain('</head>');

      // Second injection does nothing
      const reinjected = injectDesignTokenCss(injected, DEFAULT_DESIGN_TOKENS);
      expect(reinjected).toBe(injected);
    });
  });

  describe('prompt propagation & widget content generation', () => {
    test('passes design tokens to interactive widget prompts and injects CSS into output', async () => {
      let capturedSystem = '';
      let _capturedUser = '';
      const aiCall: AICallFn = async (system, user) => {
        capturedSystem = system;
        _capturedUser = user;
        return `<!DOCTYPE html><html><head></head><body><div id="sim">Simulation</div></body></html>`;
      };

      const outline: SceneOutline = {
        id: 'scene-interactive-1',
        type: 'interactive',
        title: 'Wave Interference',
        description: 'Explore double-slit interference patterns with adjustable wavelength.',
        keyPoints: [
          'Constructive and destructive interference',
          'Fringe width proportional to wavelength',
        ],
        order: 2,
        widgetType: 'simulation',
        widgetOutline: {
          concept: 'Wave Interference',
          keyVariables: ['wavelength', 'slitDistance'],
        },
      };

      const result = await generateSceneContent(outline, aiCall);
      expect(result).not.toBeNull();
      expect(capturedSystem).toContain('### Course Theme and Design Tokens');
      expect(capturedSystem).toContain('The course style is **Light** (Light style: true).');
      expect(capturedSystem).toContain('--color-background');
      expect(capturedSystem).toContain('--color-accent');
      expect(capturedSystem).toContain('Strict Light guarantee');

      // Check returned HTML has injected tokens
      expect(result && 'html' in result ? result.html : '').toContain(
        '<style data-openmaic-theme-tokens>',
      );
      expect(result && 'html' in result ? result.html : '').toContain(
        '--color-background: #ffffff;',
      );
    });

    test('derives dark tokens when design brief specifies dark mode', async () => {
      let capturedSystem = '';
      const aiCall: AICallFn = async (system) => {
        capturedSystem = system;
        return `<!DOCTYPE html><html><head></head><body><svg id="diagram"></svg></body></html>`;
      };

      const outline: SceneOutline = {
        id: 'scene-interactive-2',
        type: 'interactive',
        title: 'Dark Theme System Diagram',
        description: 'Architecture diagram on dark background.',
        keyPoints: ['Microservices', 'Event Bus'],
        order: 3,
        widgetType: 'diagram',
        widgetOutline: {
          concept: 'System Architecture',
          diagramType: 'system',
          designIdea: 'Dark theme: background #0f172a, surface #1e293b, accent #38bdf8',
        },
      };

      const result = await generateWidgetContent(outline, aiCall);
      expect(result).not.toBeNull();
      expect(capturedSystem).toContain('The course style is **Dark** (Light style: false).');
      expect(capturedSystem).toContain('--color-background');
      expect(capturedSystem).toContain('#0f172a');
      expect(capturedSystem).toContain('--color-accent');
      expect(capturedSystem).toContain('#38bdf8');

      expect(result?.html).toContain('<style data-openmaic-theme-tokens>');
      expect(result?.html).toContain('--color-background: #0f172a;');
      expect(result?.html).toContain('--color-accent: #38bdf8;');
    });

    test('accepts explicit outline.design brief conforming to #2206', async () => {
      let capturedSystem = '';
      const aiCall: AICallFn = async (system) => {
        capturedSystem = system;
        return `<!DOCTYPE html><html><head></head><body><div>Game</div></body></html>`;
      };

      const outline = {
        id: 'scene-interactive-3',
        type: 'interactive' as const,
        title: 'Cell Biology Quiz Game',
        description: 'Test organelle knowledge.',
        keyPoints: ['Mitochondria', 'Nucleus'],
        order: 4,
        design: 'Paper style: warm background #fbf8f1, rich accent #b45309, text #2d2926',
        widgetType: 'game' as const,
        widgetOutline: {
          concept: 'Organelle Quiz',
        },
      };

      const result = await generateSceneContent(outline, aiCall);
      expect(result).not.toBeNull();
      expect(capturedSystem).toContain('The course style is **Light** (Light style: true).');
      expect(capturedSystem).toContain('#fbf8f1');
      expect(capturedSystem).toContain('#b45309');

      expect(result && 'html' in result ? result.html : '').toContain(
        '--color-background: #fbf8f1;',
      );
      expect(result && 'html' in result ? result.html : '').toContain('--color-accent: #b45309;');
    });
  });
});
