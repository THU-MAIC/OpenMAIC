import { describe, expect, it } from 'vitest';
import type { PPTElement, PPTTextElement } from '@openmaic/dsl';
import type { Selection } from '@openmaic/renderer/editing';
import {
  getRendererContextMenuState,
  resolveRendererContextSelection,
} from '@/components/edit/surfaces/slide/RendererCanvasContextMenu';
import type { SlideContent } from '@/lib/types/stage';

function text(id: string, overrides: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id,
    type: 'text',
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    rotate: 0,
    content: `<p>${id}</p>`,
    defaultFontName: 'Inter',
    defaultColor: '#111111',
    ...overrides,
  };
}

function content(elements: PPTElement[]): SlideContent {
  return {
    type: 'slide',
    canvas: { id: 'slide', viewportSize: 1000, viewportRatio: 0.5625, elements },
  } as SlideContent;
}

describe('renderer context menu target resolution', () => {
  const elements = [
    text('g1', { groupId: 'G' }),
    text('g2', { groupId: 'G' }),
    text('solo'),
    text('locked', { lock: true }),
  ];
  const slide = content(elements);

  it('selects the complete group before opening an unlocked element menu', () => {
    const selection: Selection = { elementIds: ['solo'], primaryId: 'solo' };
    expect(resolveRendererContextSelection(slide, selection, 'g2')).toEqual({
      elementIds: ['g1', 'g2'],
      primaryId: 'g2',
    });
  });

  it('keeps an existing multi-selection when the context target is already inside it', () => {
    const selection: Selection = { elementIds: ['g1', 'g2', 'solo'], primaryId: 'solo' };
    expect(resolveRendererContextSelection(slide, selection, 'g1')).toBeNull();
  });

  it('does not select a locked target but exposes unlock-only menu state', () => {
    const selection: Selection = { elementIds: [] };
    expect(resolveRendererContextSelection(slide, selection, 'locked')).toBeNull();
    expect(getRendererContextMenuState(slide, selection, 'locked')).toEqual({
      kind: 'locked',
      targetId: 'locked',
    });
  });

  it('describes canvas, grouped, and ungrouped menu states', () => {
    expect(getRendererContextMenuState(slide, { elementIds: [] }, null)).toEqual({
      kind: 'canvas',
    });
    expect(
      getRendererContextMenuState(slide, { elementIds: ['g1', 'g2'], primaryId: 'g1' }, 'g1'),
    ).toEqual({ kind: 'element', targetId: 'g1', groupAction: 'ungroup' });
    expect(
      getRendererContextMenuState(slide, { elementIds: ['solo', 'g1'], primaryId: 'solo' }, 'solo'),
    ).toEqual({ kind: 'element', targetId: 'solo', groupAction: 'group' });
  });
});
