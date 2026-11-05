// @vitest-environment jsdom

/**
 * The legacy canvas removes an empty text box. A removal saves the whole scene,
 * so it must follow something the user did: leaving that box. Rendering one, as
 * entering Edit does, must not write this tab's copy over the server's. The real
 * text element, canvas operations, controller, edit session, stage store and save
 * scheduler run here; only ResizeObserver, the rich-text editor and the storage
 * module's write are faked.
 */
import { act, createElement, type FC, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saveStageDataIncremental = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ failedChanges: [] as unknown[] }),
);

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental,
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/hooks/use-history-snapshot', () => ({
  useHistorySnapshot: () => ({ addHistorySnapshot: vi.fn() }),
}));
const editorInput = vi.hoisted(() => new Map<string, (value: string) => void>());
vi.mock('@/components/slide-renderer/components/element/ProsemirrorEditor', () => ({
  ProsemirrorEditor: ({
    elementId,
    onUpdate,
  }: {
    elementId: string;
    onUpdate: (update: { value: string }) => void;
  }) => {
    editorInput.set(elementId, (value) => onUpdate({ value }));
    return null;
  },
}));

import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import {
  useResolvedSlideContent,
  useSlideCanvasController,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { TextElement } from '@/components/slide-renderer/components/element/TextElement';
import { SceneProvider, type SceneDataController } from '@/lib/contexts/scene-context';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Text = ReturnType<typeof createDefaultTextElement>;
const Provider = SceneProvider as FC<{ controller?: SceneDataController; children?: ReactNode }>;

function slideWith(...texts: [id: string, content: string][]): Scene {
  const canvas = createDefaultSlide('slide-1');
  canvas.elements.push(
    ...texts.map(([id, content]) => ({ ...createDefaultTextElement(id), content, height: 47 })),
  );
  return {
    id: 'scene-1',
    stageId: 'stage-a',
    order: 0,
    title: 'Page',
    type: 'slide',
    content: { type: 'slide', canvas },
  } as Scene;
}

function storedIds(): string[] {
  const content = useStageStore.getState().scenes[0]!.content as SlideContent;
  return content.canvas.elements.map((element) => element.id);
}

function EditCanvas() {
  const { controller } = useSlideCanvasController();
  const elements = useResolvedSlideContent().canvas.elements as Text[];
  return createElement(
    Provider,
    { controller },
    ...elements.map((element) =>
      createElement(TextElement, { key: element.id, elementInfo: element }),
    ),
  );
}

let root: ReturnType<typeof createRoot> | null = null;

async function openEditor(scene: Scene) {
  useStageStore.setState({
    stage: { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [scene],
    currentSceneId: 'scene-1',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(EditCanvas)));
}

async function settle(ms = 1_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** What the sync does with a server copy: into the store, with no save. */
async function serverCopyWith(id: string, content: string) {
  await act(async () => {
    const scene = structuredClone(useStageStore.getState().scenes[0]!);
    const elements = (scene.content as SlideContent).canvas.elements;
    (elements.find((element) => element.id === id) as Text).content = content;
    useStageStore.setState({ scenes: [scene] });
  });
}

async function select(id: string) {
  await act(async () => useCanvasStore.getState().setActiveElementIdList(id ? [id] : []));
}

beforeEach(() => {
  vi.useFakeTimers();
  saveStageDataIncremental.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useCanvasStore.setState({ activeElementIdList: [], handleElementId: '' });
  useStageStore.getState().clearStore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('an empty text box on the legacy canvas', () => {
  it('from before stays, and nothing saves, when the canvas renders it', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['empty', '']));
    await settle();

    expect(storedIds()).toEqual(['kept', 'empty']);
    expect(saveStageDataIncremental).not.toHaveBeenCalled();
  });

  it('from before goes when the user selects it and leaves it', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['empty', '']));

    await select('empty');
    await settle();
    expect(storedIds()).toEqual(['kept', 'empty']);

    await select('');
    await settle();

    expect(storedIds()).toEqual(['kept']);
    expect(saveStageDataIncremental).toHaveBeenCalledTimes(1);
  });

  it('goes when newly inserted and the user clicks away with nothing typed', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>']));
    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.add',
        element: { ...createDefaultTextElement('fresh'), content: '' },
      }),
    );
    await select('fresh');
    await settle();
    expect(storedIds()).toEqual(['kept', 'fresh']);

    await select('kept');
    await settle();

    expect(storedIds()).toEqual(['kept']);
  });

  it('an undo past the removal brings it back, and it stays until left again', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['empty', '']));
    // The removal is no undo step of its own: undo steps back over the last edit,
    // whose earlier copy still holds the box.
    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.update',
        elementId: 'kept',
        patch: { left: 321 },
      }),
    );
    await select('empty');
    await select('');
    await settle();
    expect(storedIds()).toEqual(['kept']);

    await act(async () => useSlideEditSession.getState().undo());
    await settle();
    expect(storedIds()).toEqual(['kept', 'empty']);

    await select('empty');
    await select('');
    await settle();
    expect(storedIds()).toEqual(['kept']);
  });

  it('goes when the user clears it and clicks away before the editor reports the change', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['cleared', '<p>was here</p>']));

    await select('cleared');
    await select('');
    // The editor's input is debounced: the empty content arrives after the leave.
    await settle(200);
    act(() => editorInput.get('cleared')!(''));
    await settle();

    expect(storedIds()).toEqual(['kept']);
  });

  it('stays when an undo empties it just after the user left it', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '']));
    await select('box');
    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.update',
        elementId: 'box',
        patch: { content: '<p>hello</p>' },
      }),
    );
    await settle(100);
    await select('');
    await settle(400);

    await act(async () => useSlideEditSession.getState().undo());
    await settle();

    expect(storedIds()).toEqual(['kept', 'box']);
  });

  it('stays, unsaved, when a server copy empties it just after the user left it', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '<p>was here</p>']));
    await select('box');
    await select('');
    await settle(200);
    saveStageDataIncremental.mockClear();

    await serverCopyWith('box', '');
    await settle(2_000);

    expect(storedIds()).toEqual(['kept', 'box']);
    expect(saveStageDataIncremental).not.toHaveBeenCalled();
  });

  it('stays when the user comes back to it before the check fires, and types', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '<p>was</p>']));
    await select('box');
    await select('');
    await settle(100);
    act(() => editorInput.get('box')!(''));
    await settle(100);

    await select('box');
    await settle(50);
    act(() => editorInput.get('box')!('<p>typing again</p>'));
    await settle();

    expect(storedIds()).toEqual(['kept', 'box']);
  });

  it('stays when the user comes back to it before the editor reports it empty', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '<p>was</p>']));
    await select('box');
    await select('');
    await settle(100);

    await select('box');
    act(() => editorInput.get('box')!(''));
    await settle();

    expect(storedIds()).toEqual(['kept', 'box']);
  });

  it('keeps text typed into it just before the user clicked away', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '']));
    await select('box');
    await settle(100);
    await select('');
    // The input debounce started before the leave, so it fires before the check.
    await settle(100);
    act(() => editorInput.get('box')!('<p>typed</p>'));
    await settle();

    expect(storedIds()).toEqual(['kept', 'box']);
  });

  it('stays when an agent writes text into it just after the user left it', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '']));
    await select('box');
    await select('');
    await settle(100);

    await serverCopyWith('box', '<p>agent text</p>');
    await settle(2_000);

    expect(storedIds()).toEqual(['kept', 'box']);
  });

  it('a removal builds on the copy of when it fires, not of when the user left', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '']));
    await select('box');
    await select('');
    await settle(100);

    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.update',
        elementId: 'kept',
        patch: { left: 321 },
      }),
    );
    await settle();

    const content = useStageStore.getState().scenes[0]!.content as SlideContent;
    expect(content.canvas.elements.map((element) => element.id)).toEqual(['kept']);
    expect(content.canvas.elements[0]).toMatchObject({ left: 321 });
  });

  it('does not fire once the canvas is gone', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['box', '']));
    await select('box');
    await select('');

    await act(async () => root?.unmount());
    root = null;
    await settle();

    expect(storedIds()).toEqual(['kept', 'box']);
  });

  it('stays when another box is the one the user leaves', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>'], ['empty', '']));

    await select('kept');
    await select('');
    await settle();

    expect(storedIds()).toEqual(['kept', 'empty']);
    expect(saveStageDataIncremental).not.toHaveBeenCalled();
  });

  it('with text stays when the user leaves it', async () => {
    await openEditor(slideWith(['kept', '<p>text</p>']));

    await select('kept');
    await select('');
    await settle();

    expect(storedIds()).toEqual(['kept']);
    expect(saveStageDataIncremental).not.toHaveBeenCalled();
  });
});
