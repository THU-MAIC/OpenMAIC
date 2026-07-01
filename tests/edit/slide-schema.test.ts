import { describe, expect, it } from 'vitest';
import {
  CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
  migrateInteractiveContent,
  migrateScene,
  migrateSlideContent,
} from '@/lib/edit/slide-schema';
import type { InteractiveContent, Scene, SlideContent } from '@/lib/types/stage';
import type { Slide } from '@openmaic/dsl';

// `teacherActions` was removed from InteractiveContent and from every
// WidgetConfig variant; legacy persisted documents still carry it both at the
// top level and nested inside widgetConfig.
type LegacyInteractiveContent = Omit<InteractiveContent, 'widgetConfig'> & {
  teacherActions?: unknown[];
  widgetConfig?: Record<string, unknown>;
};

function makeSlide(): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      backgroundColor: '#ffffff',
      themeColors: ['#000000'],
      fontColor: '#000000',
      fontName: 'sans-serif',
    },
    elements: [],
  };
}

function makeSlideContent(overrides: Partial<SlideContent> = {}): SlideContent {
  return { type: 'slide', canvas: makeSlide(), ...overrides };
}

function makeSlideScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Test slide',
    order: 1,
    content: makeSlideContent(),
    ...overrides,
    // Fixture spreads a loose `Partial<Scene>` over a fixed-kind literal; cast
    // contained to the test helper.
  } as Scene;
}

function makeInteractiveContent(
  overrides: Partial<LegacyInteractiveContent> = {},
): InteractiveContent {
  return {
    type: 'interactive',
    url: 'about:blank',
    widgetType: 'simulation',
    ...overrides,
  } as InteractiveContent;
}

function makeInteractiveScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-i1',
    stageId: 'stage-1',
    type: 'interactive',
    title: 'Test widget',
    order: 1,
    content: makeInteractiveContent(),
    ...overrides,
    // Fixture spreads a loose `Partial<Scene>` over a fixed-kind literal; cast
    // contained to the test helper.
  } as Scene;
}

describe('migrateSlideContent', () => {
  it('stamps the current schemaVersion on legacy content lacking the field', () => {
    const legacy = makeSlideContent();
    expect(legacy.schemaVersion).toBeUndefined();
    const result = migrateSlideContent(legacy);
    expect(result.schemaVersion).toBe(CURRENT_SLIDE_CONTENT_SCHEMA_VERSION);
  });

  it('returns the same reference when content is already at the current version', () => {
    const current = makeSlideContent({ schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION });
    expect(migrateSlideContent(current)).toBe(current);
  });

  it('does not mutate its input', () => {
    const input = makeSlideContent();
    const snapshot = JSON.parse(JSON.stringify(input));
    migrateSlideContent(input);
    expect(input).toEqual(snapshot);
  });

  it('is idempotent', () => {
    const input = makeSlideContent();
    const once = migrateSlideContent(input);
    const twice = migrateSlideContent(once);
    expect(twice).toEqual(once);
  });

  it('preserves canvas data byte-for-byte', () => {
    const canvas = makeSlide();
    const input: SlideContent = { type: 'slide', canvas };
    const out = migrateSlideContent(input);
    expect(out.canvas).toBe(canvas);
  });

  it('does not downgrade content written with a future schemaVersion', () => {
    // A newer client writes v2; this v1 client should leave it intact
    // rather than silently truncating the schema down to v1.
    const future = makeSlideContent({ schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION + 1 });
    expect(migrateSlideContent(future)).toBe(future);
  });
});

describe('migrateInteractiveContent', () => {
  it('drops the legacy teacherActions field from existing content', () => {
    const legacy = makeInteractiveContent({
      teacherActions: [{ id: 'a', type: 'highlight', target: '#x' }],
    });
    expect('teacherActions' in legacy).toBe(true);
    const result = migrateInteractiveContent(legacy);
    expect('teacherActions' in result).toBe(false);
  });

  it('preserves the surviving interactive fields', () => {
    const legacy = makeInteractiveContent({
      html: '<div id="x"></div>',
      teacherActions: [{ id: 'a' }],
    });
    expect(migrateInteractiveContent(legacy)).toEqual({
      type: 'interactive',
      url: 'about:blank',
      widgetType: 'simulation',
      html: '<div id="x"></div>',
    });
  });

  it('returns the same reference when there is nothing to drop', () => {
    const clean = makeInteractiveContent();
    expect(migrateInteractiveContent(clean)).toBe(clean);
  });

  it('drops teacherActions nested inside widgetConfig, preserving other config', () => {
    const legacy = makeInteractiveContent({
      widgetConfig: { teacherActions: [{ id: 'a' }], variables: [{ name: 'x' }] },
    });
    const result = migrateInteractiveContent(legacy) as InteractiveContent & {
      widgetConfig?: Record<string, unknown>;
    };
    expect('teacherActions' in (result.widgetConfig ?? {})).toBe(false);
    expect(result.widgetConfig).toEqual({ variables: [{ name: 'x' }] });
  });

  it('drops both top-level and widgetConfig teacherActions', () => {
    const legacy = makeInteractiveContent({
      teacherActions: [{ id: 'top' }],
      widgetConfig: { teacherActions: [{ id: 'nested' }] },
    });
    const result = migrateInteractiveContent(legacy) as InteractiveContent & {
      widgetConfig?: Record<string, unknown>;
    };
    expect('teacherActions' in result).toBe(false);
    expect('teacherActions' in (result.widgetConfig ?? {})).toBe(false);
  });

  it('returns the same reference when widgetConfig has no teacherActions', () => {
    const clean = makeInteractiveContent({ widgetConfig: { variables: [] } });
    expect(migrateInteractiveContent(clean)).toBe(clean);
  });

  it('does not mutate its input', () => {
    const input = makeInteractiveContent({ teacherActions: [{ id: 'a' }] });
    const snapshot = JSON.parse(JSON.stringify(input));
    migrateInteractiveContent(input);
    expect(input).toEqual(snapshot);
  });

  it('is idempotent', () => {
    const input = makeInteractiveContent({ teacherActions: [{ id: 'a' }] });
    const once = migrateInteractiveContent(input);
    const twice = migrateInteractiveContent(once);
    expect(twice).toBe(once);
  });
});

describe('migrateScene', () => {
  it('drops teacherActions for interactive scenes', () => {
    const scene = makeInteractiveScene({
      content: makeInteractiveContent({ teacherActions: [{ id: 'a' }] }),
    });
    const out = migrateScene(scene);
    expect(out).not.toBe(scene);
    if (out.content.type !== 'interactive') throw new Error('expected interactive content');
    expect('teacherActions' in out.content).toBe(false);
  });

  it('returns the same reference for interactive scenes with no legacy field', () => {
    const scene = makeInteractiveScene();
    expect(migrateScene(scene)).toBe(scene);
  });

  it('migrates the slide content for slide scenes', () => {
    const scene = makeSlideScene();
    const out = migrateScene(scene);
    expect(out).not.toBe(scene);
    if (out.content.type !== 'slide') throw new Error('expected slide content');
    expect(out.content.schemaVersion).toBe(CURRENT_SLIDE_CONTENT_SCHEMA_VERSION);
  });

  it('returns the same reference for slide scenes already at the current version', () => {
    const scene = makeSlideScene({
      content: makeSlideContent({ schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION }),
    });
    expect(migrateScene(scene)).toBe(scene);
  });

  it('passes non-slide scenes through unchanged', () => {
    const quizScene: Scene = {
      id: 'q1',
      stageId: 'stage-1',
      type: 'quiz',
      title: 'Quiz',
      order: 1,
      content: { type: 'quiz', questions: [] },
    };
    expect(migrateScene(quizScene)).toBe(quizScene);
  });

  it('is idempotent at the scene level', () => {
    const scene = makeSlideScene();
    const once = migrateScene(scene);
    const twice = migrateScene(once);
    expect(twice).toBe(once);
  });
});
