import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import {
  buildActionNavigationTargets,
  canJumpWithinReconstructablePrefix,
  getActionLineProgress,
  getNextSafeSpeechActionIndex,
  getPreviousSafeSpeechActionIndex,
} from '@/lib/playback/action-navigation';
import {
  clearActionResumePosition,
  createActionResumePosition,
  getActionResumeRestoreCursor,
  getValidActionResumePosition,
  readActionResumeState,
  saveActionResumePosition,
} from '@/lib/playback/action-resume';
import { useSettingsStore } from '@/lib/store/settings';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';

function speech(id: string, text = id): Action {
  return { id, type: 'speech', text } as Action;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createActionEngine() {
  const executions: Array<{ action: Action; silent?: boolean }> = [];
  return {
    executions,
    engine: {
      execute: vi.fn(async (action: Action, options?: { silent?: boolean }) => {
        executions.push({ action, silent: options?.silent });
      }),
      clearEffects: vi.fn(),
      resetPlaybackVisualState: vi.fn(),
    } as unknown as ActionEngine,
  };
}

function createAudioPlayer(play?: (audioId: string, audioUrl?: string) => Promise<boolean>) {
  let ended: (() => void) | null = null;
  return {
    player: {
      play: vi.fn(play ?? (async () => false)),
      onEnded: vi.fn((callback: () => void) => {
        ended = callback;
      }),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPlaying: vi.fn(() => false),
      hasActiveAudio: vi.fn(() => false),
    } as unknown as AudioPlayer,
    fireEnded: () => ended?.(),
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function createMemoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    read: (key: string) => data.get(key) ?? null,
  };
}

describe('action navigation helpers', () => {
  it('builds speech targets with action index metadata', () => {
    const actions = [
      speech('a', 'First'),
      { id: 'spot-1', type: 'spotlight', elementId: 'box' } as Action,
      speech('b', 'Second'),
    ];

    expect(buildActionNavigationTargets(actions)).toEqual([
      { actionIndex: 0, actionId: 'a', actionType: 'speech', lineNumber: 1, canJump: true },
      { actionIndex: 2, actionId: 'b', actionType: 'speech', lineNumber: 2, canJump: true },
    ]);
  });

  it('computes previous and next safe speech actions', () => {
    const actions = [speech('a'), { id: 'wb', type: 'wb_open' } as Action, speech('b')];

    expect(getPreviousSafeSpeechActionIndex(actions, 2)).toBe(0);
    expect(getNextSafeSpeechActionIndex(actions, 0)).toBe(2);
    expect(getActionLineProgress(actions, 2)).toEqual({ currentLine: 2, totalLines: 2 });
  });

  it('does not introduce timestamp or duration navigation state', () => {
    const targets = buildActionNavigationTargets([speech('a')]);
    expect(targets[0]).not.toHaveProperty('timestampMs');
    expect(targets[0]).not.toHaveProperty('durationMs');
    expect(targets[0]).not.toHaveProperty('progress');
  });

  it('guards targets and current cursors that require unsafe reconstruction', () => {
    const actions = [
      speech('a'),
      { id: 'widget-1', type: 'widget_setState', state: {} } as Action,
      speech('b'),
    ];

    expect(canJumpWithinReconstructablePrefix(actions, 0, 0)).toBe(true);
    expect(canJumpWithinReconstructablePrefix(actions, 0, 2)).toBe(false);
    expect(canJumpWithinReconstructablePrefix(actions, 2, 0)).toBe(false);
  });
});

describe('action resume storage', () => {
  it('stores action-level resume positions without time or progress fields', () => {
    const storage = createMemoryStorage();
    const actions = [speech('a'), speech('b')];
    const position = createActionResumePosition(actions, 1);

    expect(position).toEqual({ actionIndex: 1, actionId: 'b', actionType: 'speech' });
    saveActionResumePosition(storage, 'resume-key', 'scene-1', position!);

    const raw = storage.read('resume-key');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.scenes['scene-1']).toEqual({
      actionIndex: 1,
      actionId: 'b',
      actionType: 'speech',
    });
    expect(raw).not.toContain('milliseconds');
    expect(raw).not.toContain('currentTime');
    expect(raw).not.toContain('duration');
    expect(raw).not.toContain('progress');
  });

  it('drops malformed and stale resume positions safely', () => {
    const malformed = createMemoryStorage({ key: '{"scenes":{"scene-1":{"actionIndex":"1"}}}' });
    expect(readActionResumeState(malformed, 'key')).toEqual({ version: 1, scenes: {} });

    const storage = createMemoryStorage();
    saveActionResumePosition(storage, 'key', 'scene-1', {
      actionIndex: 1,
      actionId: 'old-id',
      actionType: 'speech',
    });
    const state = readActionResumeState(storage, 'key');
    expect(getValidActionResumePosition(state, 'scene-1', [speech('a')])).toBeNull();
    expect(getValidActionResumePosition(state, 'scene-1', [speech('a'), speech('b')])).toBeNull();
  });

  it('clears completed scene resume positions', () => {
    const storage = createMemoryStorage();
    saveActionResumePosition(storage, 'key', 'scene-1', {
      actionIndex: 0,
      actionId: 'a',
      actionType: 'speech',
    });
    clearActionResumePosition(storage, 'key', 'scene-1');
    expect(readActionResumeState(storage, 'key').scenes).toEqual({});
  });

  it('uses the saved action as the mount cursor instead of overwriting it with first speech', () => {
    const storage = createMemoryStorage();
    const actions = [
      speech('speech-1', 'First'),
      { id: 'wb-open', type: 'wb_open' } as Action,
      { id: 'wb-text', type: 'wb_draw_text', content: 'A', x: 1, y: 2 } as Action,
      speech('speech-2', 'Second'),
      speech('speech-3', 'Third'),
    ];
    saveActionResumePosition(storage, 'key', 'scene-1', {
      actionIndex: 3,
      actionId: 'speech-2',
      actionType: 'speech',
    });

    const restoreCursor = getActionResumeRestoreCursor(
      readActionResumeState(storage, 'key'),
      'scene-1',
      actions,
    );
    expect(restoreCursor).toEqual({
      actionIndex: 3,
      position: {
        actionIndex: 3,
        actionId: 'speech-2',
        actionType: 'speech',
      },
    });

    const mountPosition = createActionResumePosition(actions, restoreCursor.actionIndex);
    saveActionResumePosition(storage, 'key', 'scene-1', mountPosition!);

    expect(readActionResumeState(storage, 'key').scenes['scene-1']).toEqual({
      actionIndex: 3,
      actionId: 'speech-2',
      actionType: 'speech',
    });
  });

  it('restores a saved action boundary and resumes from that action', async () => {
    const storage = createMemoryStorage();
    const actions = [speech('a'), speech('b'), speech('c')];
    const position = createActionResumePosition(actions, 2)!;
    saveActionResumePosition(storage, 'key', 'scene-1', position);

    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => true);
    const onSpeechStart = vi.fn();
    const saved = getValidActionResumePosition(
      readActionResumeState(storage, 'key'),
      'scene-1',
      actions,
    );
    const engine = new PlaybackEngine([scene(actions)], actionEngine, player, { onSpeechStart });

    expect(saved).toEqual(position);
    expect(await engine.jumpToAction(saved!.actionIndex, { autoplay: false })).toBe(true);
    engine.continuePlayback();
    await flushPromises();

    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(onSpeechStart).toHaveBeenCalledWith('c');
  });
});

describe('PlaybackEngine action navigation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects invalid and unsafe jump targets', async () => {
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer();
    const engine = new PlaybackEngine(
      [
        scene([
          speech('a'),
          { id: 'discussion-1', type: 'discussion', topic: 'Talk' } as Action,
          speech('b'),
        ]),
      ],
      actionEngine,
      player,
    );

    expect(await engine.jumpToAction(-1)).toBe(false);
    expect(await engine.jumpToAction(99)).toBe(false);
    expect(await engine.jumpToAction(2)).toBe(false);
    expect('seekTo' in engine).toBe(false);
  });

  it.each([
    ['widget_setState', { id: 'u', type: 'widget_setState', state: {} }],
    ['discussion', { id: 'u', type: 'discussion', topic: 'Discuss' }],
    ['play_video', { id: 'u', type: 'play_video', elementId: 'video-1' }],
  ] as Array<[string, Action]>)(
    'guards targets requiring %s reconstruction',
    async (_type, unsafe) => {
      const { engine: actionEngine } = createActionEngine();
      const { player } = createAudioPlayer();
      const engine = new PlaybackEngine(
        [scene([speech('a'), unsafe, speech('b')])],
        actionEngine,
        player,
      );

      expect(engine.canJumpToAction(2)).toBe(false);
      expect(await engine.jumpToAction(2)).toBe(false);
    },
  );

  it('silently replays deterministic whiteboard actions before the target', async () => {
    const { engine: actionEngine, executions } = createActionEngine();
    const { player } = createAudioPlayer();
    const actions = [
      { id: 'open', type: 'wb_open' } as Action,
      { id: 'draw', type: 'wb_draw_text', content: 'A', x: 1, y: 2 } as Action,
      speech('target'),
    ];
    const engine = new PlaybackEngine([scene(actions)], actionEngine, player);

    expect(await engine.jumpToAction(2, { autoplay: false })).toBe(true);
    expect(actionEngine.resetPlaybackVisualState).toHaveBeenCalledTimes(1);
    expect(executions).toEqual([
      { action: actions[0], silent: true },
      { action: actions[1], silent: true },
    ]);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('jumping to speech before a spotlight does not fire the later spotlight', async () => {
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer();
    const onEffectFire = vi.fn();
    const actions = [
      speech('third'),
      { id: 'spotlight-4', type: 'spotlight', elementId: 'component-4' } as Action,
      speech('fourth'),
    ];
    const engine = new PlaybackEngine([scene(actions)], actionEngine, player, { onEffectFire });

    expect(await engine.jumpToAction(0, { autoplay: false })).toBe(true);

    expect(onEffectFire).not.toHaveBeenCalled();
    expect(actionEngine.execute).not.toHaveBeenCalledWith(actions[1]);
    expect(engine.getSnapshot().actionIndex).toBe(0);
  });

  it('stale spotlight microtask after jump is ignored by generation token', async () => {
    vi.useFakeTimers();
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => false);
    const onComplete = vi.fn();
    const actions = [
      { id: 'spotlight', type: 'spotlight', elementId: 'box' } as Action,
      speech('a'),
    ];
    const engine = new PlaybackEngine([scene(actions)], actionEngine, player, { onComplete });

    engine.start();
    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2500);

    expect(onComplete).not.toHaveBeenCalled();
    expect(engine.getSnapshot().actionIndex).toBe(1);
  });

  it('normal playback still shows spotlight when its own action is reached', async () => {
    vi.useFakeTimers();
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => false);
    const onEffectFire = vi.fn();
    const actions = [
      speech('a'),
      { id: 'spotlight', type: 'spotlight', elementId: 'box' } as Action,
    ];
    const engine = new PlaybackEngine([scene(actions)], actionEngine, player, { onEffectFire });

    engine.start();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2500);
    await flushPromises();

    expect(onEffectFire).toHaveBeenCalledWith({
      kind: 'spotlight',
      targetId: 'box',
      dimOpacity: undefined,
    });
  });

  it('jumping while paused positions the cursor without autoplay', async () => {
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => true);
    const engine = new PlaybackEngine([scene([speech('a'), speech('b')])], actionEngine, player);

    engine.start();
    await flushPromises();
    engine.pause();
    vi.mocked(player.play).mockClear();

    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);

    expect(engine.getMode()).toBe('paused');
    expect(engine.getSnapshot().actionIndex).toBe(1);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('jumping while playing continues from the target action', async () => {
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => true);
    const engine = new PlaybackEngine([scene([speech('a'), speech('b')])], actionEngine, player);

    engine.start();
    await flushPromises();
    vi.mocked(player.play).mockClear();

    expect(await engine.jumpToAction(1)).toBe(true);
    await flushPromises();

    expect(engine.getMode()).toBe('playing');
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledWith('', undefined);
    expect(engine.getSnapshot().actionIndex).toBe(2);
  });

  it('does not duplicate whiteboard actions after a backward jump and replay', async () => {
    const { engine: actionEngine, executions } = createActionEngine();
    const { player } = createAudioPlayer();
    const actions = [
      { id: 'draw', type: 'wb_draw_text', content: 'A', x: 1, y: 2 } as Action,
      speech('a'),
    ];
    const engine = new PlaybackEngine([scene(actions)], actionEngine, player);

    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);
    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);
    expect(actionEngine.resetPlaybackVisualState).toHaveBeenCalledTimes(2);
    expect(executions).toHaveLength(2);
    expect(executions.every((entry) => entry.action.id === 'draw' && entry.silent)).toBe(true);
  });

  it('stale generated-audio play resolution after jump cannot schedule old completion', async () => {
    vi.useFakeTimers();
    const firstPlay = deferred<boolean>();
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(vi.fn().mockReturnValueOnce(firstPlay.promise));
    const onSpeechEnd = vi.fn();
    const onComplete = vi.fn();
    const engine = new PlaybackEngine([scene([speech('a'), speech('b')])], actionEngine, player, {
      onSpeechEnd,
      onComplete,
    });

    engine.start();
    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);
    firstPlay.resolve(false);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);

    expect(onSpeechEnd).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('stale reading timer after jump cannot advance old action', async () => {
    vi.useFakeTimers();
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => false);
    const onSpeechEnd = vi.fn();
    const onComplete = vi.fn();
    const engine = new PlaybackEngine([scene([speech('a'), speech('b')])], actionEngine, player, {
      onSpeechEnd,
      onComplete,
    });

    engine.start();
    await flushPromises();
    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);

    expect(onSpeechEnd).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('browser TTS callbacks are generation-token guarded', async () => {
    const spoken: Array<{ onend?: () => void; onerror?: (event: { error: string }) => void }> = [];
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string;
        rate = 1;
        volume = 1;
        lang = 'en-US';
        voice?: SpeechSynthesisVoice;
        onend?: () => void;
        onerror?: (event: { error: string }) => void;
        constructor(text: string) {
          this.text = text;
        }
      },
    );
    vi.stubGlobal('window', {
      speechSynthesis: {
        getVoices: () => [{ voiceURI: 'v1', lang: 'en-US' }],
        cancel: vi.fn(),
        speak: vi.fn((utterance) => spoken.push(utterance)),
      },
    });
    const ttsProvidersConfig = useSettingsStore.getState().ttsProvidersConfig;
    useSettingsStore.setState({
      ttsEnabled: true,
      ttsProviderId: 'browser-native-tts',
      ttsProvidersConfig: {
        ...ttsProvidersConfig,
        'browser-native-tts': {
          ...ttsProvidersConfig['browser-native-tts'],
          enabled: true,
        },
      },
    });

    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => false);
    const onSpeechEnd = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('a', 'Sentence.'), speech('b')])],
      actionEngine,
      player,
      {
        onSpeechEnd,
      },
    );

    engine.start();
    await flushPromises();
    expect(spoken).toHaveLength(1);
    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);
    spoken[0].onend?.();

    expect(onSpeechEnd).not.toHaveBeenCalled();
  });

  it('jumping to the last line completes through normal completion flow', async () => {
    vi.useFakeTimers();
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => false);
    const onComplete = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('a'), speech('last')])],
      actionEngine,
      player,
      {
        onComplete,
      },
    );

    expect(await engine.jumpToAction(1, { autoplay: true })).toBe(true);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2500);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(engine.getMode()).toBe('idle');
  });

  it('restores an interrupted final speech before notifying discussion end', async () => {
    const { engine: actionEngine } = createActionEngine();
    const { player } = createAudioPlayer(async () => true);
    const exhaustedAtDiscussionEnd: boolean[] = [];
    const engineRef: { current?: PlaybackEngine } = {};
    const engine = new PlaybackEngine([scene([speech('final')])], actionEngine, player, {
      onDiscussionEnd: () => exhaustedAtDiscussionEnd.push(engineRef.current!.isExhausted()),
    });
    engineRef.current = engine;

    engine.start();
    await flushPromises();
    expect(engine.isExhausted()).toBe(true);

    engine.handleUserInterrupt('One more question');
    expect(engine.hasLectureInterruption()).toBe(true);
    engine.handleEndDiscussion();

    expect(exhaustedAtDiscussionEnd).toEqual([false]);
    expect(engine.getSnapshot().actionIndex).toBe(0);
    expect(engine.getMode()).toBe('idle');
  });
});
