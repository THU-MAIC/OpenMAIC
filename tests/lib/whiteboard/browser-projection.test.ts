import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';

const mocks = vi.hoisted(() => ({
  persistenceEnabled: true,
  read: vi.fn(),
}));

vi.mock('@/lib/persistence/bootstrap', () => ({
  isBrowserPersistenceEnabled: () => mocks.persistenceEnabled,
}));
vi.mock('@/lib/whiteboard/runtime/store', () => ({
  getWhiteboardRuntimeService: () => ({ read: mocks.read }),
}));

import { refreshWhiteboardRuntimeProjection } from '@/lib/whiteboard/runtime/browser-projection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeState(lastSeq: number | null, label: string) {
  return {
    sessionId: lastSeq === null ? null : 'runtime-session-1',
    lastSeq,
    whiteboard:
      lastSeq === null
        ? null
        : {
            id: 'runtime-board-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: [
              {
                id: `text-${lastSeq}`,
                type: 'text' as const,
                left: 10,
                top: 20,
                width: 200,
                height: 60,
                rotate: 0,
                content: label,
                defaultFontName: 'Inter',
                defaultColor: '#000000',
              },
            ],
          },
  };
}

describe('Browser RuntimeStore whiteboard projection', () => {
  beforeEach(() => {
    mocks.persistenceEnabled = true;
    mocks.read.mockReset();
    useStageStore.setState({ stage: { id: 'stage-1' } as never });
    useCanvasStore.setState({
      runtimeWhiteboardProjection: null,
      runtimeWhiteboardProjectionGeneration: 0,
    });
  });

  it('drops an older response that arrives after a newer projection', async () => {
    const oldRead = deferred<ReturnType<typeof runtimeState>>();
    mocks.read
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValueOnce(runtimeState(1, 'new'));

    const oldRefresh = refreshWhiteboardRuntimeProjection('stage-1');
    await expect(refreshWhiteboardRuntimeProjection('stage-1')).resolves.toBe(true);
    oldRead.resolve(runtimeState(0, 'old'));
    await expect(oldRefresh).resolves.toBe(false);

    expect(useCanvasStore.getState().runtimeWhiteboardProjection).toMatchObject({
      stageId: 'stage-1',
      lastSeq: 1,
      whiteboard: { elements: [{ content: 'new' }] },
    });
  });

  it('drops a response after the active Stage changes', async () => {
    const read = deferred<ReturnType<typeof runtimeState>>();
    mocks.read.mockReturnValue(read.promise);

    const refresh = refreshWhiteboardRuntimeProjection('stage-1');
    useStageStore.setState({ stage: { id: 'stage-2' } as never });
    read.resolve(runtimeState(0, 'stale Stage'));

    await expect(refresh).resolves.toBe(false);
    expect(useCanvasStore.getState().runtimeWhiteboardProjection).toBeNull();
  });

  it('does not apply a projection below the sequence announced by the commit event', async () => {
    mocks.read.mockResolvedValue(runtimeState(2, 'replica lag'));

    await expect(refreshWhiteboardRuntimeProjection('stage-1', 3)).resolves.toBe(false);
    expect(useCanvasStore.getState().runtimeWhiteboardProjection).toBeNull();
  });

  it('allows a later authoritative refetch after a transient read failure', async () => {
    mocks.read
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(runtimeState(1, 'recovered'));

    await expect(refreshWhiteboardRuntimeProjection('stage-1')).resolves.toBe(false);
    await expect(refreshWhiteboardRuntimeProjection('stage-1')).resolves.toBe(true);

    expect(useCanvasStore.getState().runtimeWhiteboardProjection).toMatchObject({
      stageId: 'stage-1',
      lastSeq: 1,
      whiteboard: { elements: [{ content: 'recovered' }] },
    });
  });

  it('does not regress an authoritative same-Stage projection to an empty Runtime fold', async () => {
    useCanvasStore.setState({
      runtimeWhiteboardProjection: {
        stageId: 'stage-1',
        lastSeq: 3,
        whiteboard: runtimeState(3, 'committed').whiteboard,
      },
    });
    mocks.read.mockResolvedValue(runtimeState(null, 'empty'));

    await expect(refreshWhiteboardRuntimeProjection('stage-1')).resolves.toBe(false);
    expect(useCanvasStore.getState().runtimeWhiteboardProjection).toMatchObject({
      stageId: 'stage-1',
      lastSeq: 3,
      whiteboard: { elements: [{ content: 'committed' }] },
    });
  });

  it('clears Runtime presentation when the existing persistence topology is disabled', async () => {
    useCanvasStore.setState({
      runtimeWhiteboardProjection: {
        stageId: 'stage-1',
        lastSeq: 1,
        whiteboard: runtimeState(1, 'existing').whiteboard,
      },
    });
    mocks.persistenceEnabled = false;

    await expect(refreshWhiteboardRuntimeProjection('stage-1')).resolves.toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().runtimeWhiteboardProjection).toBeNull();
  });
});
