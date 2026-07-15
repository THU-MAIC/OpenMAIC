import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditIntent } from '@openmaic/renderer/editing';
import type { PPTElement } from '@openmaic/dsl';
import type { SlideContent } from '@/lib/types/stage';

const commitContent = vi.fn();
const updateScene = vi.fn();

vi.mock('@/components/edit/surfaces/slide/slide-edit-session', () => ({
  useSlideEditSession: {
    getState: () => ({
      sceneId: mockSession.sceneId,
      history: mockSession.history,
      gestureActive: mockSession.gestureActive,
      commitContent,
    }),
  },
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: {
    getState: () => ({
      getSceneById: (id: string) => mockScenes[id] ?? null,
      updateScene,
    }),
  },
}));

const mockSession: {
  sceneId: string | null;
  history: { present: SlideContent } | null;
  gestureActive: boolean;
} = { sceneId: null, history: null, gestureActive: false };

const mockScenes: Record<string, { content: SlideContent }> = {};

function slideWith(elements: PPTElement[]): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'c1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements,
    },
  } as SlideContent;
}

function textEl(id: string, overrides: Partial<PPTElement> = {}): PPTElement {
  return {
    id,
    type: 'text',
    left: 100,
    top: 80,
    width: 400,
    height: 60,
    rotate: 0,
    content: '<p>Title</p>',
    defaultColor: '#333',
    defaultFontName: 'Arial',
    ...overrides,
  } as PPTElement;
}

describe('applyEditElementsIntents', () => {
  beforeEach(() => {
    commitContent.mockReset();
    updateScene.mockReset();
    mockSession.sceneId = null;
    mockSession.history = null;
    mockSession.gestureActive = false;
    for (const k of Object.keys(mockScenes)) delete mockScenes[k];
  });

  it('detects applyable intents', async () => {
    const { hasEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const intents: EditIntent[] = [{ type: 'element.update', id: 'a', props: { top: 10 } }];
    expect(hasEditElementsIntents({ sceneId: 's1', intents })).toBe(true);
    expect(hasEditElementsIntents({ sceneId: 's1', intents: null })).toBe(false);
    expect(hasEditElementsIntents({ sceneId: 's1', intents: [] })).toBe(false);
    expect(hasEditElementsIntents({ intents })).toBe(false);
  });

  it('refuses atomically when an id is missing at apply time (no partial)', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const present = slideWith([textEl('a')]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents('s1', [
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { top: 10 } },
          { id: 'gone', props: { top: 10 } },
        ],
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/gone|unknown|missing/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('refuses when a target is locked at apply time', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const present = slideWith([textEl('a', { lock: true })]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'a', props: { top: 10 } },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/locked/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('refuses when a target element changed type after the gate ran', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const shape = {
      id: 'a',
      type: 'shape',
      left: 100,
      top: 80,
      width: 400,
      height: 60,
      rotate: 0,
      viewBox: [0, 0],
      path: 'M0,0',
      fixedRatio: false,
      fill: '#eee',
    } as PPTElement;
    const present = slideWith([shape]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents(
      's1',
      [{ type: 'element.update', id: 'a', props: { top: 10 } }],
      { a: 'text' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/changed type/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('allows apply when the gate-time element type still matches', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const present = slideWith([textEl('a')]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents(
      's1',
      [{ type: 'element.update', id: 'a', props: { top: 10 } }],
      { a: 'text' },
    );

    expect(result).toEqual({ ok: true });
    expect(commitContent).toHaveBeenCalledTimes(1);
  });

  it('refuses when a target changed after the gate inventory was captured', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const { elementInventoryFingerprint } = await import('@/lib/agent/tools/edit-elements-gate');
    const gateTime = textEl('a');
    const present = slideWith([textEl('a', { top: 95 })]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents(
      's1',
      [{ type: 'element.update', id: 'a', props: { top: 10 } }],
      { a: 'text' },
      { a: elementInventoryFingerprint(gateTime) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/changed while the edit was being prepared/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('refuses when a non-target element changed after the prompt inventory was captured', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const { elementInventorySnapshotFingerprint } =
      await import('@/lib/agent/tools/edit-elements-gate');
    const gateTime = [textEl('a'), textEl('reference', { left: 600 })];
    const present = slideWith([textEl('a'), textEl('reference', { left: 700 })]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents(
      's1',
      [{ type: 'element.update', id: 'a', props: { top: 200 } }],
      { a: 'text' },
      undefined,
      elementInventorySnapshotFingerprint(gateTime),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/slide elements changed while the edit was being prepared/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('detects concurrent shape vAlign changes through the gate fingerprint', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const { elementInventoryFingerprint } = await import('@/lib/agent/tools/edit-elements-gate');
    const shape = (align: 'top' | 'middle' | 'bottom') =>
      ({
        id: 'sh1',
        type: 'shape',
        left: 10,
        top: 10,
        width: 100,
        height: 80,
        rotate: 0,
        viewBox: [100, 80],
        path: 'M0 0',
        fixedRatio: false,
        fill: '#fff',
        text: {
          content: 'Label',
          defaultFontName: 'Arial',
          defaultColor: '#111',
          align,
        },
      }) as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([shape('bottom')]) };

    const result = applyEditElementsIntents(
      's1',
      [{ type: 'element.update', id: 'sh1', props: { vAlign: 'middle' } }],
      { sh1: 'shape' },
      { sh1: elementInventoryFingerprint(shape('top')) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/changed while the edit was being prepared/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('refuses while a canvas pointer gesture has uncommitted local state', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([textEl('a')]) };
    mockSession.gestureActive = true;

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'a', props: { top: 10 } },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/gesture/i);
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('commits one undo entry when session is open and targets are valid', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const present = slideWith([textEl('a')]);
    mockSession.sceneId = 's1';
    mockSession.history = { present };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'a', props: { top: 10, defaultColor: '#00f' } },
    ]);

    expect(result).toEqual({ ok: true });
    expect(commitContent).toHaveBeenCalledTimes(1);
    const next = commitContent.mock.calls[0][0] as SlideContent;
    expect(commitContent.mock.calls[0][1]).toBe(true);
    expect(next.canvas.elements[0]).toMatchObject({ top: 10, defaultColor: '#00f' });
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('merges partial nested style patches without dropping existing values', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const image = {
      id: 'img1',
      type: 'image',
      left: 10,
      top: 10,
      width: 100,
      height: 80,
      rotate: 0,
      fixedRatio: true,
      src: 'https://example.com/image.png',
      filters: { blur: '2px', contrast: '90%' },
    } as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([image]) };

    const result = applyEditElementsIntents('s1', [
      {
        type: 'element.update',
        id: 'img1',
        props: { filters: { brightness: '120%' } } as Partial<PPTElement>,
      },
    ]);

    expect(result).toEqual({ ok: true });
    const next = commitContent.mock.calls[0][0] as SlideContent;
    expect(next.canvas.elements[0]).toMatchObject({
      filters: { blur: '2px', contrast: '90%', brightness: '120%' },
    });
  });

  it('clears higher-priority shape paints when applying a solid fill', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const shape = {
      id: 'sh1',
      type: 'shape',
      left: 10,
      top: 10,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [100, 80],
      path: 'M0,0 L100,0 L100,80 Z',
      fixedRatio: false,
      fill: '#eee',
      pattern: 'https://example.com/pattern.png',
      gradient: {
        type: 'linear',
        colors: [
          { pos: 0, color: '#000' },
          { pos: 100, color: '#fff' },
        ],
        rotate: 0,
      },
    } as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([shape]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'sh1', props: { fill: '#00f' } },
    ]);

    expect(result).toEqual({ ok: true });
    const next = commitContent.mock.calls[0][0] as SlideContent;
    expect(next.canvas.elements[0]).toMatchObject({ fill: '#00f' });
    expect(next.canvas.elements[0]).not.toHaveProperty('pattern');
    expect(next.canvas.elements[0]).not.toHaveProperty('gradient');
  });

  it('recomputes formula-backed shape geometry when resizing', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const shape = {
      id: 'sh1',
      type: 'shape',
      left: 10,
      top: 10,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [100, 80],
      path: 'old path',
      pathFormula: 'roundRect',
      keypoints: [0.125],
      fixedRatio: false,
      fill: '#eee',
    } as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([shape]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'sh1', props: { width: 200, height: 120 } },
    ]);

    expect(result).toEqual({ ok: true });
    const next = commitContent.mock.calls[0][0] as SlideContent;
    expect(next.canvas.elements[0]).toMatchObject({ viewBox: [200, 120] });
    expect((next.canvas.elements[0] as { path: string }).path).not.toBe('old path');
  });

  it('keeps table row height in sync when resizing its height', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const table = {
      id: 'tb1',
      type: 'table',
      left: 10,
      top: 10,
      width: 300,
      height: 120,
      rotate: 0,
      cellMinHeight: 40,
      rowHeights: [50, 70],
      colWidths: [1],
      data: [[{ id: 'a', text: 'A' }], [{ id: 'b', text: 'B' }]],
      outline: { width: 1, color: '#000', style: 'solid' },
      theme: {
        color: '#00f',
        rowHeader: false,
        rowFooter: false,
        colHeader: false,
        colFooter: false,
      },
    } as unknown as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([table]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'tb1', props: { height: 160 } },
    ]);

    expect(result).toEqual({ ok: true });
    const next = commitContent.mock.calls[0][0] as SlideContent;
    expect(next.canvas.elements[0]).toMatchObject({
      height: 160,
      cellMinHeight: 60,
      rowHeights: [50 * (160 / 120), 70 * (160 / 120)],
    });
  });

  it('refuses when no edit session is open (no irreversible fallback write)', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    mockScenes.s1 = { content: slideWith([textEl('a')]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'a', props: { top: 10 } },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/session/i);
    expect(updateScene).not.toHaveBeenCalled();
    expect(commitContent).not.toHaveBeenCalled();
  });

  it('maps shape text chrome onto shape.text instead of top-level', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const shape = {
      id: 'sh1',
      type: 'shape',
      left: 10,
      top: 10,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [0, 0],
      path: 'M0,0',
      fixedRatio: false,
      fill: '#eee',
      text: {
        content: 'Label',
        defaultFontName: 'Arial',
        defaultColor: '#111',
        align: 'middle',
      },
    } as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([shape]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'sh1', props: { defaultColor: '#00f' } },
    ]);

    expect(result).toEqual({ ok: true });
    const next = commitContent.mock.calls[0][0] as SlideContent;
    const el = next.canvas.elements[0] as {
      defaultColor?: string;
      text?: { defaultColor?: string };
    };
    expect(el.defaultColor).toBeUndefined();
    expect(el.text?.defaultColor).toBe('#00f');
  });

  it('refuses styling text chrome on a shape with no label', async () => {
    const { applyEditElementsIntents } = await import('@/lib/agent/client/apply-edit-elements');
    const shape = {
      id: 'sh1',
      type: 'shape',
      left: 10,
      top: 10,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [0, 0],
      path: 'M0,0',
      fixedRatio: false,
      fill: '#eee',
    } as PPTElement;
    mockSession.sceneId = 's1';
    mockSession.history = { present: slideWith([shape]) };

    const result = applyEditElementsIntents('s1', [
      { type: 'element.update', id: 'sh1', props: { defaultColor: '#00f' } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no text label/i);
    expect(commitContent).not.toHaveBeenCalled();
  });
});
