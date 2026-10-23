// @vitest-environment jsdom
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { WorkbenchPanelProvider } from '@/lib/workbench/panel-context';

const probe = vi.hoisted(() => ({
  teardown: vi.fn(),
  preload: vi.fn(),
  preloaded: false,
  learningMount: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/config/feature-flags', () => ({
  isMaicEditorEnabled: () => true,
  isWorkbenchEnabled: () => true,
}));
vi.mock('@/lib/edit/preload-editor', () => ({
  preloadEditor: () => probe.preload(),
  isEditorPreloaded: () => probe.preloaded,
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (s: (v: unknown) => unknown) => s({ setPanelOpen: vi.fn() }),
}));
vi.mock('@/components/edit/EditChromeRoot', () => ({
  EditChromeRoot: () => createElement('div', { 'data-testid': 'edit' }),
}));
vi.mock('@/components/edit/PlaybackChromeRoot', () => ({
  PlaybackChromeRoot: forwardRef(function Playback(_, ref) {
    useImperativeHandle(ref, () => ({ teardown: () => probe.teardown() }));
    useLayoutEffect(() => {
      probe.learningMount();
    }, []);
    return createElement('div', { 'data-testid': 'learning' });
  }),
}));
vi.mock('@/components/scene-renderers/InteractiveIframeHost', () => ({
  InteractiveIframeHost: () => null,
}));
vi.mock('@/components/workbench/WorkbenchReturnControl', () => ({
  WorkbenchReturnControl: () => null,
}));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children }: { children: ReactNode }) => createElement('div', null, children) },
}));

import { Stage } from '@/components/stage';
let root: Root;
const has = (id: string) => document.querySelector(`[data-testid="${id}"]`) !== null;
async function render(learning: boolean, courseId = 'stage-1', visible = true) {
  const providerProps = {
    learning,
    visible,
    children: createElement(Stage, { classroomId: courseId }),
  };
  await act(async () => root.render(createElement(WorkbenchPanelProvider, providerProps)));
}

beforeEach(() => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  probe.preloaded = false;
  probe.learningMount.mockClear();
  probe.teardown.mockReset().mockResolvedValue(undefined);
  probe.preload.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) }),
  );
  useStageStore.setState({
    stage: { id: 'stage-1' } as never,
    scenes: [{ id: 'scene-1', type: 'slide' }] as never,
    currentSceneId: 'scene-1',
    generatingOutlines: [],
    isOwner: true,
    readOnly: false,
    courseGenerating: false,
    mode: 'playback',
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('hosted Stage mode enforcement and playback lifecycle', () => {
  it('mounts a cold editing intent through loading without ever mounting learning', async () => {
    let finish!: () => void;
    probe.preload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render(false);
    expect(has('stage-editor-loading')).toBe(true);
    expect(probe.learningMount).not.toHaveBeenCalled();
    expect(probe.teardown).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(has('edit')).toBe(true);
    expect(probe.learningMount).not.toHaveBeenCalled();
  });

  it('unfolds a remembered editing intent without mounting learning', async () => {
    probe.preloaded = true;
    await render(false);
    expect(has('edit')).toBe(true);
    await render(false, 'stage-1', false);
    expect(has('stage-editor-loading')).toBe(true);
    await render(false);
    expect(has('edit')).toBe(true);
    expect(probe.learningMount).not.toHaveBeenCalled();
    expect(probe.teardown).not.toHaveBeenCalled();
  });

  it('loads the requested editing course without a learning mount', async () => {
    await render(false, 'stage-2');
    expect(has('stage-editor-loading')).toBe(true);
    await act(async () => useStageStore.setState({ stage: { id: 'stage-2' } as never }));
    expect(has('edit')).toBe(true);
    expect(probe.learningMount).not.toHaveBeenCalled();
  });

  it('keeps learning mounted until teardown and editor preload finish', async () => {
    let finish!: () => void;
    probe.teardown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render(true);
    await render(false);
    expect(probe.teardown).toHaveBeenCalledOnce();
    expect(probe.preload).toHaveBeenCalledOnce();
    expect(has('learning')).toBe(true);
    expect(has('edit')).toBe(false);
    await act(async () => finish());
    expect(has('edit')).toBe(true);
    useCanvasStore.getState().setActiveElementIdList(['title']);
    await render(true);
    expect(has('learning')).toBe(true);
    expect(useCanvasStore.getState().activeElementIdList).toEqual([]);
  });

  it('enforces generation over a hostile edit request and safely restores it on completion', async () => {
    await act(async () => useStageStore.setState({ courseGenerating: true }));
    await render(false);
    expect(has('learning')).toBe(true);
    expect(has('edit')).toBe(false);
    expect(probe.preload).not.toHaveBeenCalled();
    let finish!: () => void;
    probe.teardown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => useStageStore.setState({ courseGenerating: false }));
    expect(has('learning')).toBe(true);
    expect(has('edit')).toBe(false);
    await act(async () => finish());
    expect(has('edit')).toBe(true);
    await act(async () => useStageStore.setState({ courseGenerating: true }));
    expect(has('learning')).toBe(true);
    expect(has('edit')).toBe(false);
  });

  it('ignores an edit transition overtaken by generation or a learning choice', async () => {
    let finish!: () => void;
    probe.teardown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render(true);
    await render(false);
    await act(async () => useStageStore.setState({ courseGenerating: true }));
    await act(async () => finish());
    expect(has('edit')).toBe(false);
    await act(async () => useStageStore.setState({ courseGenerating: false }));
    await render(true);
    await act(async () => finish());
    expect(has('learning')).toBe(true);
    expect(has('edit')).toBe(false);
  });

  it('does not mount either chrome against another course document', async () => {
    await render(true, 'stage-2');
    expect(has('learning')).toBe(false);
    expect(has('edit')).toBe(false);
    await render(false, 'stage-2');
    expect(has('edit')).toBe(false);
  });

  it('stays in learning if editor loading fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    probe.preload.mockRejectedValue(new Error('chunk failed'));
    await render(true);
    await render(false);
    expect(has('edit')).toBe(false);
    expect(has('learning')).toBe(true);
    vi.restoreAllMocks();
  });

  it('remounts a torn-down learning surface when Learn is chosen before edit entry finishes', async () => {
    let finish!: () => void;
    probe.preload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render(true);
    expect(probe.learningMount).toHaveBeenCalledTimes(1);
    await render(false);
    expect(probe.teardown).toHaveBeenCalledOnce();
    await render(true);
    // The stopped root is replaced by a fresh one, not left on screen.
    expect(has('learning')).toBe(true);
    expect(probe.learningMount).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    expect(has('edit')).toBe(false);
    expect(probe.learningMount).toHaveBeenCalledTimes(2);
  });

  it('remounts a torn-down learning surface when editor preload fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    probe.preload.mockRejectedValue(new Error('chunk failed'));
    await render(true);
    expect(probe.learningMount).toHaveBeenCalledTimes(1);
    await render(false);
    expect(probe.teardown).toHaveBeenCalledOnce();
    expect(has('learning')).toBe(true);
    expect(probe.learningMount).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('does not remount learning when no teardown ran', async () => {
    await render(true);
    await act(async () => useStageStore.setState({ courseGenerating: true }));
    await render(false);
    expect(probe.teardown).not.toHaveBeenCalled();
    expect(probe.learningMount).toHaveBeenCalledTimes(1);
  });

  it('mounts the fresh learning root only after the old teardown has settled', async () => {
    let finishTeardown!: () => void;
    probe.teardown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishTeardown = resolve;
        }),
    );
    probe.preload.mockImplementation(() => new Promise<void>(() => {}));
    await render(true);
    await render(false);
    expect(probe.teardown).toHaveBeenCalledOnce();
    // Back to Learn while the old root is still tearing down: no new root yet.
    await render(true);
    expect(probe.learningMount).toHaveBeenCalledTimes(1);
    await act(async () => finishTeardown());
    expect(probe.learningMount).toHaveBeenCalledTimes(2);
    expect(has('learning')).toBe(true);
  });

  it('mounts one fresh learning root after a failed preload, not another on the next change', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    probe.preload.mockRejectedValue(new Error('chunk failed'));
    await render(true);
    await render(false);
    expect(probe.learningMount).toHaveBeenCalledTimes(2);
    // Picking Learn afterwards keeps that fresh root.
    await render(true);
    expect(probe.learningMount).toHaveBeenCalledTimes(2);
    expect(has('learning')).toBe(true);
    vi.restoreAllMocks();
  });
});
