// @vitest-environment jsdom
import { act, createElement, forwardRef, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: { div: 'div', button: 'button' },
}));
vi.mock('lucide-react', () => ({
  Eraser: () => null,
  History: () => null,
  Minimize2: () => null,
  PencilLine: () => null,
  RotateCcw: () => null,
}));
vi.mock('@/components/whiteboard/whiteboard-canvas', () => ({
  WhiteboardCanvas: forwardRef(function WhiteboardCanvas() {
    return null;
  }),
}));
vi.mock('@/components/whiteboard/whiteboard-history', () => ({
  WhiteboardHistory: () => null,
}));
vi.mock('@/lib/api/stage-api', () => ({
  createStageAPI: () => ({ whiteboard: { delete: vi.fn() } }),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/whiteboard/runtime/browser-projection', () => ({
  refreshWhiteboardRuntimeProjection: mocks.refresh,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { Whiteboard } from '@/components/whiteboard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function WhiteboardHarness() {
  const isOpen = useCanvasStore((state) => state.whiteboardOpen);
  return createElement(Whiteboard, { isOpen, onClose: vi.fn() });
}

afterEach(() => {
  mocks.refresh.mockReset();
  useStageStore.setState({ stage: null });
  useCanvasStore.setState({
    whiteboardOpen: false,
    whiteboardManualVisibilityRevision: 0,
    runtimeWhiteboardProjection: null,
    runtimeWhiteboardProjectionGeneration: 0,
  });
  document.body.innerHTML = '';
});

describe('Whiteboard RuntimeStore projection recovery', () => {
  it('refetches authoritative state when a manual open follows a failed projection read', async () => {
    mocks.refresh.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    useStageStore.setState({ stage: { id: 'stage-1' } as never });
    useCanvasStore.setState({ whiteboardOpen: false });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(WhiteboardHarness));
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-1');

    await act(async () => {
      useCanvasStore.getState().setWhiteboardOpenManually(true);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-1');

    await act(async () => root.unmount());
  });

  it('refetches once when a Stage change and open transition share a render', async () => {
    mocks.refresh.mockResolvedValue(true);
    useStageStore.setState({ stage: { id: 'stage-1' } as never });
    useCanvasStore.setState({ whiteboardOpen: false });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(WhiteboardHarness));
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-1');
    mocks.refresh.mockClear();

    await act(async () => {
      useStageStore.setState({ stage: { id: 'stage-2' } as never });
      useCanvasStore.getState().setWhiteboardOpenManually(true);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-2');

    await act(async () => root.unmount());
  });
});
