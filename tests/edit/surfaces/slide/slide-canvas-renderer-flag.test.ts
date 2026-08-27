import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlideContent } from '@openmaic/dsl';
import type { EditorTransaction } from '@openmaic/editor/core';
import type { EditableSlideCanvasWithUIProps } from '@openmaic/editor/ui';

const state = vi.hoisted(() => ({
  rendererEnabled: true,
  pickTarget: null as unknown,
  lastRendererProps: undefined as EditableSlideCanvasWithUIProps | undefined,
  legacyCanvasRenders: 0,
  legacyTextBarRenders: 0,
  applyTransaction: vi.fn(),
  setActiveElementIdList: vi.fn(),
  setEditingElementId: vi.fn(),
  setCanvasScale: vi.fn(),
  translate: vi.fn((key: string) => `app:${key}`),
}));

const content: SlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      backgroundColor: '#ffffff',
      themeColors: ['#7c3aed'],
      fontColor: '#333333',
      fontName: 'Inter',
    },
    elements: [
      {
        id: 'text-1',
        type: 'text',
        left: 40,
        top: 40,
        width: 240,
        height: 80,
        rotate: 0,
        content: '<p>Editor</p>',
        defaultFontName: 'Inter',
        defaultColor: '#333333',
      },
    ],
  },
};

vi.mock('@/lib/config/feature-flags', () => ({
  isEditorRendererEnabled: () => state.rendererEnabled,
}));

vi.mock('@/components/slide-renderer/Editor/Canvas', () => ({
  default: () => {
    state.legacyCanvasRenders += 1;
    return createElement('div', { 'data-legacy-canvas': '' });
  },
}));

vi.mock('@/components/slide-renderer/Editor/SpotlightOverlay', () => ({
  SpotlightOverlay: () => null,
}));

vi.mock('@/components/slide-renderer/Editor/LaserPointerOverlay', () => ({
  LaserPointerOverlay: () => null,
}));

vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: ReactNode }) => children,
  useSceneData: () => ({ sceneId: 'scene-1' }),
  useSceneSelector: () => undefined,
}));

vi.mock('@/components/edit/surfaces/slide/AnchoredTextBar', () => ({
  AnchoredTextBar: () => {
    state.legacyTextBarRenders += 1;
    return null;
  },
}));

vi.mock('@/components/edit/surfaces/slide/AnchoredElementBar', () => ({
  AnchoredElementBar: () => null,
}));

vi.mock('@/components/edit/surfaces/slide/ElementPickLayer', () => ({
  ElementPickLayer: () => null,
}));

vi.mock('@/components/edit/surfaces/slide/use-slide-surface', () => ({
  useSlideCanvasController: () => ({ controller: {}, gestureProps: {} }),
  useEditingTextElementId: () => 'text-1',
  useSelectedNonTextElement: () => null,
  useSyncEditingElementId: () => undefined,
  useResolvedSlideContent: () => content,
}));

vi.mock('@/components/slide-renderer/use-resolved-slide', () => ({
  useResolvedSlide: () => content.canvas,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'ja-JP', t: state.translate }),
}));

vi.mock('@/lib/edit/element-id', () => ({
  createElementId: (type: string) => `app-${type}`,
}));

vi.mock('@/components/edit/surfaces/slide/slide-edit-session', () => ({
  useSlideEditSession: {
    getState: () => ({
      sceneId: 'scene-1',
      applyTransactionForScene: (sceneId: string, transaction: EditorTransaction) => {
        state.applyTransaction(sceneId, transaction);
      },
    }),
  },
}));

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      activeElementIdList: () => ['text-1'],
      hiddenElementIdList: () => [],
      editingElementId: () => 'text-1',
      canvasScale: () => 1,
      pickTarget: () => state.pickTarget,
      setActiveElementIdList: () => state.setActiveElementIdList,
      setEditingElementId: () => state.setEditingElementId,
      setCanvasScale: () => state.setCanvasScale,
    },
    getState: () => ({ creatingElement: null, setCreatingElement: vi.fn() }),
  },
}));

vi.mock('@openmaic/editor/ui', () => ({
  EditableSlideCanvasWithUI: (props: EditableSlideCanvasWithUIProps) => {
    state.lastRendererProps = props;
    return createElement('div', { 'data-renderer-editor': '' });
  },
}));

import { SlideCanvas } from '@/components/edit/surfaces/slide/SlideCanvas';

beforeEach(() => {
  state.rendererEnabled = true;
  state.pickTarget = null;
  state.lastRendererProps = undefined;
  state.legacyCanvasRenders = 0;
  state.legacyTextBarRenders = 0;
  state.applyTransaction.mockReset();
  state.setActiveElementIdList.mockReset();
  state.setEditingElementId.mockReset();
  state.setCanvasScale.mockReset();
  state.translate.mockClear();
});

describe('slide editor renderer feature flag', () => {
  it('uses the renderer editor host bridge when enabled', () => {
    const markup = renderToStaticMarkup(createElement(SlideCanvas));

    expect(markup).toContain('data-renderer-editor');
    expect(state.legacyCanvasRenders).toBe(0);
    expect(state.legacyTextBarRenders).toBe(0);
    expect(state.lastRendererProps).toMatchObject({
      slide: content.canvas,
      selection: { elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' },
      insertToolbarPlacement: 'top',
      snapping: true,
    });
    expect(state.lastRendererProps?.host).toMatchObject({
      locale: 'ja-JP',
      shortcutsEnabled: true,
    });
    expect(state.lastRendererProps?.host?.translate?.('insert.textBox')).toBe(
      'app:edit.insert.textBox',
    );
    expect(state.lastRendererProps?.host?.createElementId?.('image')).toBe('app-image');
  });

  it('forwards transactions and controlled selection through generic callbacks', () => {
    renderToStaticMarkup(createElement(SlideCanvas));
    const transaction: EditorTransaction = {
      origin: 'toolbar',
      history: 'record',
      operations: [{ type: 'element.deleteMany', elementIds: ['text-1'] }],
    };

    state.lastRendererProps?.onTransaction?.(transaction);
    state.lastRendererProps?.onSelectionChange?.({ elementIds: ['next'], editingId: 'next' });

    expect(state.applyTransaction).toHaveBeenCalledWith('scene-1', transaction);
    expect(state.setActiveElementIdList).toHaveBeenCalledWith(['next']);
    expect(state.setEditingElementId).toHaveBeenCalledWith('next');
  });

  it('suppresses editor shortcuts while an external pick interaction is active', () => {
    state.pickTarget = { type: 'image' };
    renderToStaticMarkup(createElement(SlideCanvas));

    expect(state.lastRendererProps?.host?.shortcutsEnabled).toBe(false);
  });

  it('preserves the legacy editor path when disabled', () => {
    state.rendererEnabled = false;
    const markup = renderToStaticMarkup(createElement(SlideCanvas));

    expect(markup).toContain('data-legacy-canvas');
    expect(state.lastRendererProps).toBeUndefined();
    expect(state.legacyCanvasRenders).toBe(1);
    expect(state.legacyTextBarRenders).toBe(1);
  });
});
