/**
 * Regression tests for OpenMAIC Course Style & Theme Choice (#2207)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  COURSE_STYLES,
  DEFAULT_COURSE_STYLE,
  VALID_COURSE_STYLE_IDS,
  normalizeCourseStyle,
  isValidCourseStyle,
  resolveCourseTheme,
  resolveSubjectTheme,
  isColorDark,
  generateDesignTokenCss,
} from '@/configs/theme';
import { parseRunInput } from '@/lib/server/generation/run/input';
import { buildOutlinePrompt } from '@openmaic/generation';
import { buildPrompt, PROMPT_IDS } from '@openmaic/generation';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import { computeSlideBackgroundStyle } from '@/packages/@openmaic/renderer/src/hooks/useSlideBackgroundStyle';
import { useStageStore } from '@/lib/store/stage';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { buildCompleteScene } from '@openmaic/generation';
import type { SceneOutline } from '@openmaic/generation';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';

describe('Course Style & Theme (#2207)', () => {
  describe('1. Style selection & presets', () => {
    it('defaults to Light', () => {
      expect(DEFAULT_COURSE_STYLE).toBe('light');
      expect(normalizeCourseStyle(undefined)).toBe('light');
      expect(normalizeCourseStyle('')).toBe('light');
    });

    it('exposes Light, Dark, Follow the subject, and named presets Paper, Graphite, High-contrast', () => {
      expect(VALID_COURSE_STYLE_IDS).toContain('light');
      expect(VALID_COURSE_STYLE_IDS).toContain('dark');
      expect(VALID_COURSE_STYLE_IDS).toContain('subject');
      expect(VALID_COURSE_STYLE_IDS).toContain('paper');
      expect(VALID_COURSE_STYLE_IDS).toContain('graphite');
      expect(VALID_COURSE_STYLE_IDS).toContain('high-contrast');

      expect(COURSE_STYLES.light.label).toBe('Light');
      expect(COURSE_STYLES.dark.label).toBe('Dark');
      expect(COURSE_STYLES.subject.label).toBe('Follow the subject');
      expect(COURSE_STYLES.paper.label).toBe('Paper');
      expect(COURSE_STYLES.graphite.label).toBe('Graphite');
      expect(COURSE_STYLES['high-contrast'].label).toBe('High-contrast');
    });

    it('normalizes style strings case-insensitively and aliases', () => {
      expect(isValidCourseStyle('light')).toBe(true);
      expect(isValidCourseStyle('unknown')).toBe(false);
      expect(normalizeCourseStyle('LIGHT')).toBe('light');
      expect(normalizeCourseStyle('Dark')).toBe('dark');
      expect(normalizeCourseStyle('Follow the subject')).toBe('subject');
      expect(normalizeCourseStyle('High Contrast')).toBe('high-contrast');
      expect(normalizeCourseStyle('unknown-style')).toBe('light');
      expect(resolveCourseTheme('paper').id).toBe('paper');
    });
  });

  describe('2. Persistence and generation', () => {
    it('parseRunInput accepts valid style and defaults to light', () => {
      const defaultRun = parseRunInput({ requirement: 'Intro to Quantum Computing' });
      expect(defaultRun.ok).toBe(true);
      if (defaultRun.ok) {
        expect(defaultRun.value.style).toBe('light');
      }

      const paperRun = parseRunInput({
        requirement: 'History of Architecture',
        style: 'paper',
      });
      expect(paperRun.ok).toBe(true);
      if (paperRun.ok) {
        expect(paperRun.value.style).toBe('paper');
      }

      const invalidRun = parseRunInput({
        requirement: 'Invalid style run',
        style: 'neon-glow-invalid',
      });
      expect(invalidRun.ok).toBe(false);
    });

    it('resolves Follow the subject deterministically per course', () => {
      const biology1 = resolveSubjectTheme({ name: 'Cell Biology', requirement: 'Learn mitosis' });
      const biology2 = resolveSubjectTheme({ name: 'Cell Biology', requirement: 'Learn mitosis' });
      expect(biology1.tokens.accent).toBe(biology2.tokens.accent);
      expect(biology1.tokens.colors).toEqual(biology2.tokens.colors);

      const math = resolveSubjectTheme({ name: 'Calculus and Linear Algebra' });
      expect(math.id).toBe('subject');
      expect(math.tokens.accent).toBeDefined();
    });
  });

  describe('3. Prompt propagation', () => {
    it('injects visual style and design tokens into outline-generation prompt', () => {
      const prompt = buildOutlinePrompt({
        requirement: 'Machine Learning Basics',
        style: 'graphite',
      });
      expect(prompt).not.toBeNull();
      expect(prompt?.user).toContain('Visual Theme & Style');
      expect(prompt?.user).toContain('Graphite');
      expect(prompt?.user).toContain('#181a1b');
      expect(prompt?.user).toContain('#8ab4f8');
    });

    it('injects design token directives into interactive widget prompts', () => {
      const simulationPrompt = buildPrompt(PROMPT_IDS.SIMULATION_CONTENT, {
        conceptName: 'Gravity',
        conceptOverview: 'Planetary gravity',
        keyPoints: '1. Mass\n2. Distance',
        variables: 'mass, distance',
        designIdea: 'interactive sliders',
        languageDirective: '',
        styleName: 'Paper',
        isLightStyle: true,
        themeBackground: '#fbf8f1',
        themeSurface: '#f3ede0',
        themeText: '#2d2926',
        themeMuted: '#78716c',
        themeBorder: '#e6ddd0',
        themeAccent: '#b45309',
        themeFont: 'Georgia, serif',
      });

      expect(simulationPrompt).not.toBeNull();
      expect(simulationPrompt?.system).toContain('Course Theme and Design Tokens');
      expect(simulationPrompt?.system).toContain('--color-background');
      expect(simulationPrompt?.system).toContain('#fbf8f1');
      expect(simulationPrompt?.system).toContain('#b45309');
    });

    it('diagram prompt removes hardcoded dark background and enforces theme tokens', () => {
      const diagramPrompt = buildPrompt(PROMPT_IDS.DIAGRAM_CONTENT, {
        title: 'Photosynthesis Workflow',
        diagramType: 'flowchart',
        description: 'Light and dark reactions',
        keyPoints: 'Chloroplasts',
        nodeCount: 4,
        prescribedNodes: [],
        hasNodeCount: true,
        hasPrescribedNodes: false,
        languageDirective: '',
      });

      expect(diagramPrompt).not.toBeNull();
      expect(diagramPrompt?.system).not.toContain('White nodes on dark background');
      expect(diagramPrompt?.system).toContain('Contrast & Theme');
      expect(diagramPrompt?.system).toContain('--color-background');
    });
  });

  describe('4. Consistent rendering & token injection', () => {
    it('injects design tokens and Strict Light CSS into interactive HTML', () => {
      const rawHtml = '<!DOCTYPE html><html><head><title>Sim</title></head><body><div class="bg-black">Content</div></body></html>';
      const patched = patchHtmlForIframe(rawHtml, undefined, { style: 'light' });

      expect(patched).toContain('data-openmaic-theme-tokens');
      expect(patched).toContain('--color-background: #ffffff');
      expect(patched).toContain('--color-accent: #2563eb');
      expect(patched).toContain('--font-family:');
      // Strict light background rule overrides .bg-black
      expect(patched).toContain('background-color: #ffffff !important');
    });

    it('injects custom style tokens when a preset style like graphite is used', () => {
      const rawHtml = '<!DOCTYPE html><html><head></head><body><div>Content</div></body></html>';
      const patched = patchHtmlForIframe(rawHtml, undefined, { style: 'graphite' });

      expect(patched).toContain('--color-background: #181a1b');
      expect(patched).toContain('--color-accent: #8ab4f8');
    });
  });

  describe('5. Editor support: changing saved style without regeneration', () => {
    beforeEach(() => {
      useStageStore.getState().clearStore();
    });

    it('setStageStyle recolors existing slides and resets iframe pool without regenerating content', () => {
      const resetSpy = vi.spyOn(useInteractiveIframePool.getState(), 'reset');

      const mockStage: Stage = {
        id: 'stage_test_1',
        name: 'Test Course',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        style: 'light',
      };

      const mockSlideScene: Scene = {
        id: 'scene_slide_1',
        stageId: 'stage_test_1',
        type: 'slide',
        order: 1,
        title: 'Slide 1',
        content: {
          type: 'slide',
          canvas: {
            theme: COURSE_STYLES.light.slideTheme,
            background: { type: 'solid', color: '#ffffff' },
            elements: [
              {
                id: 'txt_1',
                type: 'text',
                left: 10,
                top: 10,
                width: 100,
                height: 50,
                content: 'Hello World',
                defaultColor: '#0f172a',
              },
            ],
          },
        } as unknown as SlideContent,
      };

      const mockInteractiveScene: Scene = {
        id: 'scene_interactive_2',
        stageId: 'stage_test_1',
        type: 'interactive',
        order: 2,
        title: 'Interactive 1',
        content: {
          type: 'interactive',
          html: '<div>Widget</div>',
        },
      };

      useStageStore.setState({
        stage: mockStage,
        scenes: [mockSlideScene, mockInteractiveScene],
        currentSceneId: 'scene_slide_1',
      });

      // Change style in editor to 'graphite'
      useStageStore.getState().setStageStyle('graphite');

      const updatedStage = useStageStore.getState().stage;
      expect(updatedStage?.style).toBe('graphite');

      const updatedSlide = useStageStore.getState().scenes[0].content as SlideContent;
      // Slide theme and background recolored to graphite
      expect(updatedSlide.canvas.theme.backgroundColor).toBe('#181a1b');
      expect(updatedSlide.canvas.background?.type).toBe('solid');
      expect(updatedSlide.canvas.background?.color).toBe('#181a1b');

      // Element content preserved without regeneration
      expect((updatedSlide.canvas.elements[0] as { content: string }).content).toBe('Hello World');

      // Interactive content html string is preserved intact (not regenerated)
      const updatedInteractive = useStageStore.getState().scenes[1];
      expect((updatedInteractive.content as { html: string }).html).toBe('<div>Widget</div>');

      // Iframe pool reset was triggered to refresh tokens
      expect(resetSpy).toHaveBeenCalled();
    });
  });

  describe('6. Strict Light behavior guarantee across scene types', () => {
    it('isColorDark accurately identifies dark backgrounds', () => {
      expect(isColorDark('#000000')).toBe(true);
      expect(isColorDark('#0f172a')).toBe(true);
      expect(isColorDark('#181a1b')).toBe(true);
      expect(isColorDark('black')).toBe(true);
      expect(isColorDark('rgb(15, 23, 42)')).toBe(true);

      expect(isColorDark('#ffffff')).toBe(false);
      expect(isColorDark('#f8fafc')).toBe(false);
      expect(isColorDark('#fbf8f1')).toBe(false);
      expect(isColorDark('rgb(255, 255, 255)')).toBe(false);
    });

    it('computeSlideBackgroundStyle overrides dark background when slide theme is Light', () => {
      const style = computeSlideBackgroundStyle(
        { type: 'solid', color: '#000000' },
        COURSE_STYLES.light.slideTheme,
      );
      expect(style.backgroundColor).toBe('#ffffff');
    });

    it('buildCompleteScene overrides dark slide background when style is Light', () => {
      const outline: SceneOutline = {
        id: 'outline_1',
        type: 'slide',
        order: 1,
        title: 'Slide With Accidental Dark Background',
        description: 'Test',
        keyPoints: [],
      };

      const scene = buildCompleteScene(
        outline,
        {
          elements: [],
          background: { type: 'solid', color: '#000000' }, // Model returned dark background
        },
        [],
        'stage_test',
        { style: 'light' },
      );

      expect(scene).not.toBeNull();
      const slide = scene!.content as SlideContent;
      // Strict Light overrides black to light background
      expect(slide.canvas.background?.type).toBe('solid');
      expect(slide.canvas.background?.color).toBe('#ffffff');
    });

    it('interactive HTML in Light mode includes strict light container CSS overrides', () => {
      const lightTokenCss = generateDesignTokenCss(COURSE_STYLES.light.tokens);
      expect(lightTokenCss).toContain('background-color: #ffffff !important');
      expect(lightTokenCss).toContain('body > [class*="bg-black"]');
      expect(lightTokenCss).toContain('body > [class*="bg-slate-900"]');
    });
  });
});
