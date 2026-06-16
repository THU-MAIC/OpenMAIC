import { describe, expect, it } from 'vitest';
import { createBlankSlideScene, duplicateSlideScene } from '@/lib/edit/slide-defaults';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@/lib/edit/slide-schema';
import type { Scene, SlideContent } from '@/lib/types/stage';
import type { PPTTextElement } from '@maic/dsl';

function makeTextEl(id: string, groupId?: string): PPTTextElement {
  return {
    type: 'text',
    id,
    left: 0,
    top: 0,
    width: 200,
    height: 80,
    rotate: 0,
    defaultColor: '#000',
    defaultFontName: 'Inter',
    lineHeight: 1.2,
    content: '<p>x</p>',
    ...(groupId ? { groupId } : {}),
  };
}

function makeGroupedSlideScene(): Scene {
  return makeSlideScene({
    content: {
      type: 'slide',
      schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
      canvas: {
        id: 'slide-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [makeTextEl('el-a', 'group-1'), makeTextEl('el-b', 'group-1')],
        background: { type: 'solid', color: '#ffffff' },
      },
    },
  });
}

function makeSlideScene(overrides: Partial<Scene> = {}): Scene {
  const slideContent: SlideContent = {
    type: 'slide',
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#fff',
        themeColors: ['#000'],
        fontColor: '#000',
        fontName: 'Inter',
      },
      elements: [makeTextEl('el-a'), makeTextEl('el-b')],
      background: { type: 'solid', color: '#ffffff' },
    },
  };
  return {
    id: 'scene-source',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Source slide',
    order: 1,
    content: slideContent,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('createBlankSlideScene', () => {
  it('produces a slide scene with the current schema version', () => {
    const s = createBlankSlideScene('stage-1', 'Untitled', 1);
    expect(s.type).toBe('slide');
    expect(s.stageId).toBe('stage-1');
    expect(s.title).toBe('Untitled');
    if (s.content.type !== 'slide') throw new Error('expected slide content');
    expect(s.content.schemaVersion).toBe(CURRENT_SLIDE_CONTENT_SCHEMA_VERSION);
    expect(s.content.canvas.elements).toEqual([]);
    expect(s.content.canvas.background?.type).toBe('solid');
  });

  it('mints a fresh scene id + slide id on every call', () => {
    const a = createBlankSlideScene('stage-1', 'A', 1);
    const b = createBlankSlideScene('stage-1', 'B', 2);
    expect(a.id).not.toBe(b.id);
    if (a.content.type !== 'slide' || b.content.type !== 'slide') {
      throw new Error('expected slide content');
    }
    expect(a.content.canvas.id).not.toBe(b.content.canvas.id);
  });
});

describe('duplicateSlideScene', () => {
  it('returns a deep-cloned slide with new scene id + new slide id', () => {
    const source = makeSlideScene();
    const dup = duplicateSlideScene(source, '(copy)', 2);
    expect(dup.id).not.toBe(source.id);
    if (source.content.type !== 'slide' || dup.content.type !== 'slide') {
      throw new Error('expected slide content');
    }
    expect(dup.content.canvas.id).not.toBe(source.content.canvas.id);
    expect(dup.content).not.toBe(source.content);
    expect(dup.content.canvas).not.toBe(source.content.canvas);
  });

  it('reassigns every element id so React keys cannot collide', () => {
    const source = makeSlideScene();
    const dup = duplicateSlideScene(source, '(copy)', 2);
    if (source.content.type !== 'slide' || dup.content.type !== 'slide') {
      throw new Error('expected slide content');
    }
    const srcIds = source.content.canvas.elements.map((e) => e.id);
    const dupIds = dup.content.canvas.elements.map((e) => e.id);
    expect(dupIds).toHaveLength(srcIds.length);
    for (const id of dupIds) {
      expect(srcIds).not.toContain(id);
    }
  });

  it('appends the copy suffix to the title', () => {
    const source = makeSlideScene({ title: 'Hello' });
    const dup = duplicateSlideScene(source, '(copy)', 2);
    expect(dup.title).toBe('Hello (copy)');
  });

  it('passes title through unchanged when copy suffix is empty', () => {
    const source = makeSlideScene({ title: 'Hello' });
    const dup = duplicateSlideScene(source, '', 2);
    expect(dup.title).toBe('Hello');
  });

  it('remaps grouped elements to a new shared group id', () => {
    const source = makeGroupedSlideScene();
    const dup = duplicateSlideScene(source, '(copy)', 2);
    if (source.content.type !== 'slide' || dup.content.type !== 'slide') {
      throw new Error('expected slide content');
    }
    const [a, b] = dup.content.canvas.elements;

    // Element ids are freshly minted and distinct.
    expect(a.id).not.toBe('el-a');
    expect(b.id).not.toBe('el-b');
    expect(a.id).not.toBe(b.id);

    // Grouped clones share one NEW group id, not the source's dangling ref.
    expect(a.groupId).toBeDefined();
    expect(a.groupId).not.toBe('group-1');
    expect(a.groupId).toBe(b.groupId);
  });

  it('throws when the source is not a slide scene', () => {
    const quiz: Scene = {
      id: 'q',
      stageId: 'stage-1',
      type: 'quiz',
      title: 'Quiz',
      order: 1,
      content: { type: 'quiz', questions: [] },
    };
    expect(() => duplicateSlideScene(quiz, '(copy)', 2)).toThrow();
  });
});
