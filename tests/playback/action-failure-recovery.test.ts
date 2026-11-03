import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionEngine } from '@/lib/action/engine';
import { PlaybackEngine } from '@/lib/playback/engine';
import type { StageStore } from '@/lib/api/stage-api';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { PPTElement } from '@openmaic/dsl';

const board = vi.hoisted(() => ({
  elements: [] as PPTElement[],
  open: false,
}));
vi.mock('@/lib/api/stage-api', () => ({
  createStageAPI: () => ({
    whiteboard: {
      get: () => ({ success: true, data: { id: 'board', elements: board.elements } }),
      addElement: (element: PPTElement) => board.elements.push(element),
      update: ({ elements }: { elements: PPTElement[] }) => {
        board.elements = elements;
      },
    },
  }),
}));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    getState: () => ({
      whiteboardOpen: board.open,
      setWhiteboardOpen: (open: boolean) => {
        board.open = open;
      },
      setWhiteboardClearing: vi.fn(),
      clearAllEffects: vi.fn(),
      pauseVideo: vi.fn(),
    }),
  },
}));

function scene(actions: Action[]): Scene {
  return {
    id: 'scene',
    stageId: 'stage',
    type: 'slide',
    title: 'Playback recovery',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function shape(params: object): Action {
  // Imported/stored actions can predate the typed Legacy shape contract.
  return {
    id: 'shape',
    type: 'wb_draw_shape',
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    ...params,
  } as Action;
}

const followingText: Action = {
  id: 'following-text',
  type: 'wb_draw_text',
  content: 'Playback should continue',
  x: 10,
  y: 120,
};
const ending: Action = { id: 'ending', type: 'speech', text: '' } as Action;
const engines: PlaybackEngine[] = [];
const actionEngines: ActionEngine[] = [];

function setup(shapeAction: Action) {
  const actions: Action[] = [{ id: 'open', type: 'wb_open' }, shapeAction, followingText, ending];
  const actionEngine = new ActionEngine({} as StageStore);
  actionEngines.push(actionEngine);
  const onComplete = vi.fn();
  const onProgress = vi.fn();
  const audioPlayer = {
    play: vi.fn(async () => false),
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: () => false,
    hasActiveAudio: () => false,
  } as unknown as AudioPlayer;
  const engine = new PlaybackEngine([scene(actions)], actionEngine, audioPlayer, {
    onComplete,
    onProgress,
  });
  engines.push(engine);
  return { engine, actionEngine, onComplete, onProgress };
}

describe('stored action failure recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    board.elements = [];
    board.open = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    engines.splice(0).forEach((engine) => engine.stop());
    actionEngines.splice(0).forEach((engine) => engine.dispose());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe.each([
    { name: 'unknown shape', params: { shape: 'ellipse' } },
    { name: 'Native rotation field', params: { shape: 'rectangle', rotate: 30 } },
  ])('$name', ({ params }) => {
    it('continues normal playback after a rejected stored action and completes once', async () => {
      const { engine, onComplete, onProgress } = setup(shape(params));
      engine.start();
      await vi.runAllTimersAsync();

      expect(board.elements.map((element) => element.type)).toEqual(['text']);
      expect(onProgress.mock.calls.map(([snapshot]) => snapshot.actionIndex)).toContain(2);
      expect(engine.getMode()).toBe('idle');
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Legacy wb_draw_shape'));
    });

    it('recovers seek restoration after a rejected stored action and can resume', async () => {
      const { engine, onComplete } = setup(shape(params));

      await expect(engine.jumpToAction(3, { autoplay: false })).resolves.toBe(true);
      expect(board.elements.map((element) => element.type)).toEqual(['text']);
      expect(engine.getSnapshot().actionIndex).toBe(3);
      expect(onComplete).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Legacy wb_draw_shape'));

      engine.continuePlayback();
      await vi.runAllTimersAsync();
      expect(engine.getMode()).toBe('idle');
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['rectangle', 'circle', 'triangle'])(
    'preserves valid Legacy %s playback',
    async (preset) => {
      const { engine, onComplete } = setup(shape({ shape: preset }));
      engine.start();
      await vi.runAllTimersAsync();

      expect(board.elements.map((element) => element.type)).toEqual(['shape', 'text']);
      expect(engine.getMode()).toBe('idle');
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it.each(['rectangle', 'circle', 'triangle'])(
    'preserves valid Legacy %s seek restoration',
    async (preset) => {
      const { engine } = setup(shape({ shape: preset }));

      await expect(engine.jumpToAction(3, { autoplay: false })).resolves.toBe(true);

      expect(board.elements.map((element) => element.type)).toEqual(['shape', 'text']);
      expect(board.elements[0]).toMatchObject({
        rotate: 0,
        viewBox: [1000, 1000],
        fill: '#5b9bd5',
      });
      expect(engine.getSnapshot().actionIndex).toBe(3);
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it('does not resume stopped playback when a pending action rejects', async () => {
    const { engine, actionEngine, onComplete } = setup(shape({ shape: 'rectangle' }));
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const execute = vi.spyOn(actionEngine, 'execute').mockReturnValueOnce(pending);

    engine.start();
    engine.stop();
    reject(new Error('Late action failure'));
    await vi.runAllTimersAsync();

    expect(engine.getMode()).toBe('idle');
    expect(board.elements).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not continue a superseded seek when its pending action rejects', async () => {
    const { engine, actionEngine, onProgress } = setup(shape({ shape: 'rectangle' }));
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const execute = vi.spyOn(actionEngine, 'execute').mockReturnValueOnce(pending);

    const staleJump = engine.jumpToAction(3, { autoplay: false });
    await expect(engine.jumpToAction(3, { autoplay: false })).resolves.toBe(true);
    reject(new Error('Superseded restoration failure'));
    await expect(staleJump).resolves.toBe(false);

    expect(engine.getSnapshot().actionIndex).toBe(3);
    expect(board.elements.map((element) => element.type)).toEqual(['shape', 'text']);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
