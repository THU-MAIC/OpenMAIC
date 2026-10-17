// @vitest-environment jsdom
import {
  act,
  createElement,
  useEffect,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorTransaction } from '@openmaic/editor/core';
import type { EditableSlideCanvasWithUIProps } from '@openmaic/editor/ui';
import type { Scene, SlideContent, ScenePatch } from '@/lib/types/stage';
import { useSceneData } from '@/lib/contexts/scene-context';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { SlideCanvas } from '@/components/edit/surfaces/slide/SlideCanvas';
import {
  buildInsertItems,
  insertImageElement,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { BackgroundControl } from '@/components/edit/surfaces/slide/BackgroundControl';
import { ColorPicker } from '@/components/edit/surfaces/slide/ColorPicker';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import deDE from '@/lib/i18n/locales/de-DE.json';

const observed = vi.hoisted(() => ({
  rendererEnabled: false,
  rendererProps: undefined as EditableSlideCanvasWithUIProps | undefined,
  legacyUpdate: undefined as ((updater: (draft: SlideContent) => void) => void) | undefined,
  canvasMounts: 0,
  installLegacyDocumentHandlers: false,
  stopLegacyPropagation: false,
  locale: 'zh-CN',
  contentUpdated: '',
  notify: vi.fn(),
  translate: (key: string): string =>
    key === 'edit.contentUpdated' ? observed.contentUpdated : key,
  updateScene: vi.fn(),
}));

vi.mock('@/lib/store/stage', async () => {
  const { create } = await import('zustand');
  const useStore = create<{
    scenes: Scene[];
    currentSceneId: string | null;
    updateScene: (id: string, patch: ScenePatch) => void;
  }>((set) => ({
    scenes: [],
    currentSceneId: null,
    updateScene: (id, patch) => {
      observed.updateScene(id, patch);
      set((state) => ({
        scenes: state.scenes.map((scene) =>
          scene.id === id ? ({ ...scene, ...patch } as Scene) : scene,
        ),
      }));
    },
  }));
  return { useStageStore: useStore };
});

vi.mock('@/lib/config/feature-flags', () => ({
  isEditorRendererEnabled: () => observed.rendererEnabled,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: observed.locale, t: observed.translate }),
}));
vi.mock('sonner', () => ({ toast: { info: observed.notify } }));
vi.mock('@/lib/store/sync-canvas-viewport', () => ({
  useSyncCanvasViewportFromSlide: () => undefined,
}));
vi.mock('@/components/slide-renderer/use-resolved-slide', () => ({
  useResolvedSlide: (slide: SlideContent['canvas']) => slide,
}));
vi.mock('react-colorful', () => ({ HexColorPicker: () => null }));
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TabsList: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TabsTrigger: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TabsContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@/components/edit/surfaces/slide/AnchoredTextBar', () => ({
  AnchoredTextBar: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/AnchoredElementBar', () => ({
  AnchoredElementBar: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/ElementPickLayer', () => ({
  ElementPickLayer: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/ElementRefPinLayer', () => ({
  ElementRefPinLayer: () => null,
}));
vi.mock('@/components/slide-renderer/Editor/SpotlightOverlay', () => ({
  SpotlightOverlay: () => null,
}));
vi.mock('@/components/slide-renderer/Editor/LaserPointerOverlay', () => ({
  LaserPointerOverlay: () => null,
}));
vi.mock('@/components/slide-renderer/Editor/Canvas', () => ({
  default: function LegacyCanvas() {
    const { sceneData, updateSceneData } = useSceneData<SlideContent>();
    observed.legacyUpdate = updateSceneData;
    useEffect(() => {
      observed.canvasMounts += 1;
    }, []);
    return createElement('div', {
      'data-canvas': 'legacy',
      'data-left': sceneData.canvas.elements[0]?.left,
      onMouseDown: (event: ReactMouseEvent) => {
        if (!observed.installLegacyDocumentHandlers) return;
        if (observed.stopLegacyPropagation) event.stopPropagation();
        useCanvasStore.getState().setScalingState(true);
        document.onmouseup = () => useCanvasStore.getState().setActiveElementIdList(['text-1']);
      },
    });
  },
}));
vi.mock('@openmaic/editor/ui', () => ({
  EditableSlideCanvasWithUI: function RendererCanvas(props: EditableSlideCanvasWithUIProps) {
    observed.rendererProps = props;
    useEffect(() => {
      observed.canvasMounts += 1;
    }, []);
    return createElement('div', {
      'data-canvas': 'renderer',
      'data-left': props.slide.elements[0]?.left,
    });
  },
}));

const roots: Root[] = [];

function makeContent(left = 120): SlideContent {
  const canvas = createDefaultSlide('slide-1');
  canvas.elements.push({ ...createDefaultTextElement('text-1'), left });
  return { type: 'slide', canvas };
}

function canonicalScene(content = makeContent()): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    order: 0,
    title: 'Slide',
    type: 'slide',
    content,
  } as Scene;
}

async function mountElement(element: ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
}

async function mountCanvas() {
  return mountElement(createElement(SlideCanvas));
}

const transaction: EditorTransaction = {
  origin: 'toolbar',
  history: 'record',
  operations: [{ type: 'element.update', elementId: 'text-1', patch: { left: 999 } }],
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSlideEditSession.getState().end();
  useCanvasStore.getState().resetCanvasState();
  useStageStore.setState({ scenes: [canonicalScene()], currentSceneId: 'scene-1' });
  observed.rendererEnabled = false;
  observed.rendererProps = undefined;
  observed.legacyUpdate = undefined;
  observed.canvasMounts = 0;
  observed.installLegacyDocumentHandlers = false;
  observed.stopLegacyPropagation = false;
  observed.locale = 'zh-CN';
  observed.contentUpdated = zhCN.edit.contentUpdated;
  observed.notify.mockClear();
  observed.updateScene.mockClear();
});

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  useCanvasStore.getState().resetCanvasState();
  useStageStore.setState({ scenes: [], currentSceneId: null });
  document.body.innerHTML = '';
  document.onmousemove = null;
  document.onmouseup = null;
  document.ontouchmove = null;
  document.ontouchend = null;
  vi.unstubAllGlobals();
});

describe('mounted slide canvas conflict recovery', () => {
  it.each([
    { rendererEnabled: false, locale: 'zh-CN', message: zhCN.edit.contentUpdated },
    { rendererEnabled: true, locale: 'de-DE', message: deDE.edit.contentUpdated },
  ])(
    'refreshes the canvas and rejects old callbacks ($locale, renderer: $rendererEnabled)',
    async ({ rendererEnabled, locale, message }) => {
      observed.rendererEnabled = rendererEnabled;
      observed.locale = locale;
      observed.contentUpdated = message;
      const host = await mountCanvas();
      expect(observed.notify).not.toHaveBeenCalled();
      await act(async () => {
        useCanvasStore.getState().setActiveElementIdList(['text-1']);
        useCanvasStore.getState().setEditingElementId('text-1');
        useCanvasStore.getState().setCreatingElement({ type: 'text' });
      });
      const mountsBeforeConflict = observed.canvasMounts;
      const staleRenderer = observed.rendererProps;
      const staleLegacyUpdate = observed.legacyUpdate;
      const staleEpoch = useSlideEditSession.getState().epoch;
      const agentContent = makeContent(720);

      await act(async () => {
        useStageStore.setState({ scenes: [canonicalScene(agentContent)] });
      });
      await act(async () => {
        if (rendererEnabled) staleRenderer?.onTransaction?.(transaction);
        else staleLegacyUpdate?.((draft) => void (draft.canvas.elements[0].left = 999));
      });

      expect(observed.updateScene).not.toHaveBeenCalled();
      expect(useStageStore.getState().scenes[0].content).toBe(agentContent);
      expect(useSlideEditSession.getState().epoch).toBe(staleEpoch + 1);
      expect(useSlideEditSession.getState().history?.past).toEqual([]);
      expect(useSlideEditSession.getState().history?.future).toEqual([]);
      expect(host.querySelector('[data-canvas]')?.getAttribute('data-left')).toBe('720');
      expect(observed.canvasMounts).toBe(mountsBeforeConflict + 1);
      expect(useCanvasStore.getState()).toMatchObject({
        activeElementIdList: [],
        editingElementId: '',
        creatingElement: null,
      });
      expect(observed.notify).toHaveBeenCalledExactlyOnceWith(message);

      // 刷新前的鼠标松开、自动排版和选择回调都属于旧画布，必须失效。
      await act(async () => {
        staleLegacyUpdate?.((draft) => void (draft.canvas.elements[0].left = 444));
        staleRenderer?.onTransaction?.(transaction);
        staleRenderer?.onSelectionChange?.({ elementIds: ['text-1'], editingId: 'text-1' });
      });
      expect(observed.updateScene).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().activeElementIdList).toEqual([]);
      expect(observed.notify).toHaveBeenCalledTimes(1);

      await act(async () => {
        if (rendererEnabled) observed.rendererProps?.onTransaction?.(transaction);
        else observed.legacyUpdate?.((draft) => void (draft.canvas.elements[0].left = 888));
      });
      expect(observed.updateScene).toHaveBeenCalledTimes(1);
      const current = useStageStore.getState().scenes[0].content as SlideContent;
      expect(current.canvas.elements[0].left).toBe(rendererEnabled ? 999 : 888);
      expect(observed.notify).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects callbacks from a scene that was left and then reopened', async () => {
    await mountCanvas();
    const staleLegacyUpdate = observed.legacyUpdate;
    await act(async () => {
      const other = { ...canonicalScene(makeContent(300)), id: 'scene-2' } as Scene;
      useStageStore.setState({ scenes: [canonicalScene(), other], currentSceneId: other.id });
    });
    await act(async () => useStageStore.setState({ currentSceneId: 'scene-1' }));
    await act(async () => {
      staleLegacyUpdate?.((draft) => void (draft.canvas.elements[0].left = 999));
    });

    expect(observed.updateScene).not.toHaveBeenCalled();
    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].left).toBe(120);
    expect(observed.notify).not.toHaveBeenCalled();
  });

  it('does not show a historical conflict notification when entering a new editor', async () => {
    const content = useStageStore.getState().scenes[0].content as SlideContent;
    useSlideEditSession.getState().seed('scene-1', content);
    useStageStore.setState({ scenes: [canonicalScene(makeContent(720))] });
    useSlideEditSession.getState().undo();
    useSlideEditSession.getState().end();

    await mountCanvas();

    expect(observed.notify).not.toHaveBeenCalled();
    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].left).toBe(720);
  });

  it('drops an image load started before the conflict and permits a new insertion', async () => {
    const pending: DelayedImage[] = [];
    class DelayedImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 160;
      naturalHeight = 80;
      src = '';
      constructor() {
        pending.push(this);
      }
    }
    vi.stubGlobal('Image', DelayedImage);
    await mountCanvas();
    insertImageElement('old.png');
    expect(pending).toHaveLength(1);
    await act(async () => {
      useStageStore.setState({ scenes: [canonicalScene(makeContent(720))] });
      useSlideEditSession.getState().undo();
    });

    await act(async () => pending[0].onload?.());
    expect(observed.updateScene).not.toHaveBeenCalled();
    expect(useSlideEditSession.getState().history?.present.canvas.elements).toHaveLength(1);

    insertImageElement('new.png');
    await act(async () => pending[1].onload?.());
    expect(observed.updateScene).toHaveBeenCalledTimes(1);
    expect(useSlideEditSession.getState().history?.present.canvas.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image', src: 'new.png' })]),
    );
    expect(observed.notify).toHaveBeenCalledExactlyOnceWith(zhCN.edit.contentUpdated);
  });

  it.each(['insert-image', 'background-image'] as const)(
    'binds a real %s picker to the epoch before its FileReader resolves',
    async (kind) => {
      const readers: DelayedFileReader[] = [];
      class DelayedFileReader {
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        result = 'data:image/png;base64,cGlja2Vy';
        readAsDataURL = vi.fn();
        constructor() {
          readers.push(this);
        }
      }
      const images: DelayedImage[] = [];
      class DelayedImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 100;
        naturalHeight = 80;
        src = '';
        constructor() {
          images.push(this);
        }
      }
      vi.stubGlobal('FileReader', DelayedFileReader);
      vi.stubGlobal('Image', DelayedImage);
      await mountCanvas();
      const picker = buildInsertItems(observed.translate).find(
        (item) => item.id === 'insert-image',
      );
      const host = await mountElement(
        kind === 'insert-image' ? picker?.popoverContent?.() : createElement(BackgroundControl),
      );
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['image'], 'old.png', { type: 'image/png' })],
      });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      expect(readers).toHaveLength(1);
      await act(async () => {
        useStageStore.setState({ scenes: [canonicalScene(makeContent(720))] });
        useSlideEditSession.getState().undo();
      });

      await act(async () => readers[0].onloadend?.());
      await act(async () => images.forEach((image) => image.onload?.()));

      expect(observed.updateScene).not.toHaveBeenCalled();
      expect(useSlideEditSession.getState().history?.present.canvas.elements).toHaveLength(1);
      expect(useSlideEditSession.getState().history?.present.canvas.elements[0].left).toBe(720);
      expect(observed.notify).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a background EyeDropper result from before the refresh and accepts a fresh pick', async () => {
    const pending: ((result: { sRGBHex: string }) => void)[] = [];
    class EyeDropper {
      open() {
        return new Promise<{ sRGBHex: string }>((resolve) => pending.push(resolve));
      }
    }
    vi.stubGlobal('EyeDropper', EyeDropper);
    await mountCanvas();
    const host = await mountElement(createElement(BackgroundControl));
    const sample = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Sample a color from the screen"]',
    )!;
    await act(async () => sample.click());
    expect(pending).toHaveLength(1);
    await act(async () => {
      useStageStore.setState({ scenes: [canonicalScene(makeContent(720))] });
      useSlideEditSession.getState().undo();
    });

    await act(async () => pending[0]({ sRGBHex: '#ff0000' }));
    expect(observed.updateScene).not.toHaveBeenCalled();
    expect(useSlideEditSession.getState().history?.present.canvas.background).toEqual({
      type: 'solid',
      color: '#ffffff',
    });

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Sample a color from the screen"]')!
        .click();
    });
    await act(async () => pending[1]({ sRGBHex: '#00ff00' }));
    expect(observed.updateScene).toHaveBeenCalledTimes(1);
    expect(useSlideEditSession.getState().history?.present.canvas.background).toEqual({
      type: 'solid',
      color: '#00ff00',
    });
    expect(observed.notify).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending text-color EyeDropper result when its picker unmounts', async () => {
    let resolvePick!: (result: { sRGBHex: string }) => void;
    class EyeDropper {
      open() {
        return new Promise<{ sRGBHex: string }>((resolve) => {
          resolvePick = resolve;
        });
      }
    }
    vi.stubGlobal('EyeDropper', EyeDropper);
    const onCommit = vi.fn();
    const host = await mountElement(
      createElement(ColorPicker, { value: '#ffffff', onChange: vi.fn(), onCommit }),
    );
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Sample a color from the screen"]')!
        .click();
    });
    await act(async () => roots.pop()!.unmount());
    await act(async () => resolvePick({ sRGBHex: '#ff0000' }));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each([
    { hasReplacement: false, stopPropagation: false },
    { hasReplacement: true, stopPropagation: false },
    { hasReplacement: false, stopPropagation: true },
  ])(
    'cleans up legacy gestures (replacement: $hasReplacement, stopped propagation: $stopPropagation)',
    async ({ hasReplacement, stopPropagation }) => {
      observed.installLegacyDocumentHandlers = true;
      observed.stopLegacyPropagation = stopPropagation;
      const host = await mountCanvas();
      await act(async () => {
        host
          .querySelector<HTMLElement>('[data-canvas="legacy"]')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(document.onmouseup).toBeTypeOf('function');
      const replacement = vi.fn();
      if (hasReplacement) document.onmouseup = replacement;

      await act(async () => {
        useStageStore.setState({ scenes: [canonicalScene(makeContent(720))] });
        useSlideEditSession.getState().undo();
      });

      expect(document.onmouseup).toBe(hasReplacement ? replacement : null);
      expect(useCanvasStore.getState().activeElementIdList).toEqual([]);
      expect(useCanvasStore.getState().isScaling).toBe(false);
      expect(observed.notify).toHaveBeenCalledTimes(1);
    },
  );
});
