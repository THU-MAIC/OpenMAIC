import { describe, expect, it } from 'vitest';
import {
  CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
  migrateScene,
  migrateSlideContent,
} from '@/lib/edit/slide-schema';
import type { Scene, SlideContent } from '@/lib/types/stage';
import type { Slide } from '@/lib/types/slides';

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
  };
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

describe('migrateScene', () => {
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
