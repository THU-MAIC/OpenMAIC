import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestAction, ManifestScene } from '@/lib/export/classroom-zip-types';
import {
  DISCUSSION_AUTO_SKIP_MS,
  EFFECT_AUTO_CLEAR_MS,
  WIDGET_MS,
  estimateSpeechDurationMs,
} from '@/lib/choreography/timing';
import { SceneSequencer, type SequencerView } from '@/lib/standalone-player/playback/sequencer';
import {
  PlaybackController,
  SCENE_ADVANCE_DELAY_MS,
} from '@/lib/standalone-player/playback/controller';
import type { StepControl } from '@/lib/standalone-player/playback/pause-gate';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const actions = (list: unknown[]) => list as ManifestAction[];

/** Fake ports recording every call; audio and video finish when the test says so. */
function fakePorts() {
  const log: string[] = [];
  const views: SequencerView[] = [];
  const audio = new Map<string, Deferred<boolean> & { control: StepControl }>();
  const videos = new Map<string, Deferred<void> & { control: StepControl }>();
  const widgetMessages: Array<[string, Record<string, unknown>]> = [];
  return {
    log,
    views,
    audio,
    videos,
    widgetMessages,
    get view(): SequencerView {
      return views[views.length - 1] ?? { caption: null, effects: {}, discussion: null };
    },
    ports: {
      playAudio: (ref: string, control: StepControl) => {
        log.push(`audio:${ref}`);
        const d = deferred<boolean>();
        audio.set(ref, { ...d, control });
        control.signal.addEventListener('abort', () => d.resolve(true));
        return d.promise;
      },
      playVideo: (elementId: string, control: StepControl) => {
        log.push(`video:${elementId}`);
        const d = deferred<void>();
        videos.set(elementId, { ...d, control });
        control.signal.addEventListener('abort', () => d.resolve());
        return d.promise;
      },
      sendWidgetMessage: (type: string, payload: Record<string, unknown>) => {
        log.push(`widget:${type}`);
        widgetMessages.push([type, payload]);
      },
      onView: (view: SequencerView) => views.push(view),
    },
  };
}

/** Let pending promise continuations run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SceneSequencer', () => {
  it('fires effects without waiting, so they overlap the speech that follows', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    const done = sequencer.play(
      actions([
        { id: '1', type: 'spotlight', elementId: 'title' },
        { id: '2', type: 'speech', text: 'First line.', audioRef: 'audio/a.mp3' },
        { id: '3', type: 'laser', elementId: 'chart', color: '#00f' },
        { id: '4', type: 'speech', text: 'Second line.', audioRef: 'audio/b.mp3' },
      ]),
    );
    await flush();
    expect(fake.view.effects).toEqual({ spotlight: { elementId: 'title', dimness: 0.5 } });
    expect(fake.view.caption).toBe('First line.');
    expect(fake.log).toEqual(['audio:audio/a.mp3']);

    fake.audio.get('audio/a.mp3')!.resolve(true);
    await flush();
    expect(fake.log).toEqual(['audio:audio/a.mp3', 'audio:audio/b.mp3']);
    expect(fake.view.caption).toBe('Second line.');
    expect(fake.view.effects).toEqual({
      spotlight: { elementId: 'title', dimness: 0.5 },
      laser: { elementId: 'chart', color: '#00f', duration: 3000 },
    });

    fake.audio.get('audio/b.mp3')!.resolve(true);
    await expect(done).resolves.toBe('completed');
    // A caption lasts as long as its line: nothing lingers over what follows.
    expect(fake.view.caption).toBeNull();
  });

  it('clears effects 5 s after the most recent one fired', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    void sequencer.play(
      actions([
        { id: '1', type: 'spotlight', elementId: 'a' },
        { id: '2', type: 'speech', text: 'one', audioRef: 'x' },
        { id: '3', type: 'laser', elementId: 'b' },
        { id: '4', type: 'speech', text: 'two', audioRef: 'y' },
      ]),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(EFFECT_AUTO_CLEAR_MS - 1000);
    fake.audio.get('x')!.resolve(true);
    await flush();
    // The laser restarted the timer.
    await vi.advanceTimersByTimeAsync(EFFECT_AUTO_CLEAR_MS - 1);
    expect(fake.view.effects.laser).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.view.effects).toEqual({});
  });

  it('paces speech without audio with the reading-time estimate', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    const text = 'Plants turn light into chemical energy every single day of the year.';
    const readingMs = estimateSpeechDurationMs(text);
    let result: string | undefined;
    void sequencer.play(actions([{ id: '1', type: 'speech', text }])).then((r) => (result = r));
    await flush();
    expect(fake.log).toEqual([]);
    expect(fake.view.caption).toBe(text);
    await vi.advanceTimersByTimeAsync(readingMs - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('completed');
  });

  it('falls back to the reading timer when the audio cannot start', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    let result: string | undefined;
    void sequencer
      .play(actions([{ id: '1', type: 'speech', text: 'Short.', audioRef: 'a' }]))
      .then((r) => (result = r));
    await flush();
    fake.audio.get('a')!.resolve(false);
    await vi.advanceTimersByTimeAsync(estimateSpeechDurationMs('Short.') - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('completed');
  });

  it('pausing freezes the reading timer and resuming continues it', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    let result: string | undefined;
    void sequencer.play(actions([{ id: '1', type: 'speech', text: 'Hi.' }])).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(1500);
    sequencer.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result).toBeUndefined();
    sequencer.resume();
    await vi.advanceTimersByTimeAsync(499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('completed');
  });

  it('a new run cancels the running one: its audio aborts and nothing of it remains', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    const first = sequencer.play(
      actions([
        { id: '1', type: 'spotlight', elementId: 'a' },
        { id: '2', type: 'speech', text: 'Old scene.', audioRef: 'old' },
        { id: '3', type: 'speech', text: 'Never spoken.', audioRef: 'never' },
      ]),
    );
    await flush();
    const oldControl = fake.audio.get('old')!.control;

    const second = sequencer.play(actions([{ id: '1', type: 'speech', text: 'New.' }]));
    expect(oldControl.signal.aborted).toBe(true);
    await expect(first).resolves.toBe('cancelled');
    await flush();
    expect(fake.view.effects).toEqual({});
    expect(fake.view.caption).toBe('New.');
    expect(fake.log).not.toContain('audio:never');

    // No stale effect timer from the cancelled run fires into the new one.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(second).resolves.toBe('completed');
  });

  it('cancel() clears caption, effects and the discussion card', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    const run = sequencer.play(
      actions([
        { id: '1', type: 'spotlight', elementId: 'a' },
        { id: '2', type: 'speech', text: 'Talk.' },
        { id: '3', type: 'discussion', topic: 'Why?' },
      ]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.view.discussion).toBe('Why?');
    sequencer.cancel();
    await expect(run).resolves.toBe('cancelled');
    expect(fake.view).toEqual({ caption: null, effects: {}, discussion: null });
  });

  it('shows the discussion card, then continues on its own or when dismissed', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    let result: string | undefined;
    void sequencer
      .play(actions([{ id: '1', type: 'discussion', topic: 'Is light enough?', prompt: 'p' }]))
      .then((r) => (result = r));
    await flush();
    expect(fake.view.discussion).toBe('Is light enough?');
    await vi.advanceTimersByTimeAsync(DISCUSSION_AUTO_SKIP_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('completed');
    expect(fake.view.discussion).toBeNull();

    const again = sequencer.play(actions([{ id: '1', type: 'discussion', topic: 'Again' }]));
    await flush();
    sequencer.dismissDiscussion();
    await expect(again).resolves.toBe('completed');
  });

  it('waits for a slide video to finish before the next action', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    const done = sequencer.play(
      actions([
        { id: '1', type: 'play_video', elementId: 'clip' },
        { id: '2', type: 'speech', text: 'After.', audioRef: 'after' },
      ]),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.log).toEqual(['video:clip']);
    fake.videos.get('clip')!.resolve();
    await flush();
    expect(fake.log).toEqual(['video:clip', 'audio:after']);
    fake.audio.get('after')!.resolve(true);
    await expect(done).resolves.toBe('completed');
  });

  it('posts widget actions to the iframe with the classroom message names', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    const done = sequencer.play(
      actions([
        { id: '1', type: 'widget_highlight', target: '#rate', content: 'Look' },
        { id: '2', type: 'widget_setState', state: { light: 80 } },
        { id: '3', type: 'widget_annotation', target: '#a', content: 'Note' },
        { id: '4', type: 'widget_reveal', target: '#b' },
      ]),
    );
    await flush();
    expect(fake.widgetMessages).toEqual([
      ['HIGHLIGHT_ELEMENT', { target: '#rate', content: 'Look' }],
    ]);
    await vi.advanceTimersByTimeAsync(WIDGET_MS * 4);
    await expect(done).resolves.toBe('completed');
    expect(fake.widgetMessages.map(([type]) => type)).toEqual([
      'HIGHLIGHT_ELEMENT',
      'SET_WIDGET_STATE',
      'ANNOTATE_ELEMENT',
      'REVEAL_ELEMENT',
    ]);
    expect(fake.widgetMessages[1][1]).toEqual({ state: { light: 80 } });
  });

  it('skips whiteboard and unknown actions', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    const done = sequencer.play(
      actions([
        { id: '1', type: 'wb_open' },
        { id: '2', type: 'wb_draw_text', content: 'x', x: 0, y: 0 },
        { id: '3', type: 'teleport' },
      ]),
    );
    await expect(done).resolves.toBe('completed');
    expect(fake.log).toEqual([]);
  });

  it('dwells on a scene without actions for one short beat', async () => {
    const fake = fakePorts();
    const sequencer = new SceneSequencer(fake.ports);
    let result: string | undefined;
    void sequencer.play([]).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(estimateSpeechDurationMs('') - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('completed');
  });
});

function scene(type: ManifestScene['type'], list: unknown[] = []): ManifestScene {
  return { type, title: type, order: 0, content: { type } as never, actions: actions(list) };
}

function controllerFor(scenes: ManifestScene[]) {
  const fake = fakePorts();
  const navigations: number[] = [];
  const controller = new PlaybackController({
    scenes,
    ports: fake.ports,
    navigate: (index) => {
      navigations.push(index);
      // The host re-renders and reports the scene it now shows.
      controller.sceneShown(index);
    },
  });
  controller.sceneShown(0);
  return { controller, fake, navigations };
}

describe('PlaybackController', () => {
  const speech = (text: string) => ({ id: text, type: 'speech', text });

  it('does nothing until played, then auto-advances after a slide scene', async () => {
    const { controller, navigations } = controllerFor([
      scene('slide', [speech('One.')]),
      scene('slide', [speech('Two.')]),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getState().mode).toBe('idle');
    expect(navigations).toEqual([]);

    controller.play();
    expect(controller.getState()).toMatchObject({ mode: 'playing', started: true });
    await vi.advanceTimersByTimeAsync(2000 + SCENE_ADVANCE_DELAY_MS - 1);
    expect(navigations).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(navigations).toEqual([1]);
    expect(controller.getState().mode).toBe('playing');

    // The last scene ends playback.
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.getState().mode).toBe('idle');
  });

  it.each(['quiz', 'interactive', 'pbl'] as const)(
    'holds after a %s scene, with no caption left over it',
    async (type) => {
      const { controller, navigations } = controllerFor([
        scene(type, [speech('Over to you.')]),
        scene('slide', [speech('Next.')]),
      ]);
      controller.play();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.getState().mode).toBe('holding');
      expect(controller.getState().view.caption).toBeNull();
      expect(navigations).toEqual([]);
    },
  );

  it('Play after the last scene finished starts over from the first scene', async () => {
    const { controller, navigations } = controllerFor([
      scene('slide', [speech('One.')]),
      scene('slide', [speech('Two.')]),
    ]);
    controller.play();
    await vi.advanceTimersByTimeAsync(2000 + SCENE_ADVANCE_DELAY_MS + 2000);
    expect(navigations).toEqual([1]);
    expect(controller.getState().mode).toBe('idle');
    controller.play();
    expect(navigations).toEqual([1, 0]);
    expect(controller.getState().mode).toBe('playing');
    await flush();
    expect(controller.getState().view.caption).toBe('One.');
  });

  it('Play on a scene the learner navigated to after the end plays that scene', async () => {
    const { controller, navigations } = controllerFor([
      scene('slide', [speech('One.')]),
      scene('slide', [speech('Two.')]),
      scene('slide', [speech('Three.')]),
    ]);
    controller.sceneShown(2);
    controller.play();
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.getState().mode).toBe('idle');
    controller.sceneShown(1);
    controller.play();
    expect(navigations).toEqual([]);
    expect(controller.getState().mode).toBe('playing');
  });

  it('holds after a quiz scene; Play continues with the next scene', async () => {
    const { controller, navigations } = controllerFor([
      scene('quiz', [speech('Try this quiz.')]),
      scene('slide', [speech('Next.')]),
    ]);
    controller.play();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getState().mode).toBe('holding');
    expect(navigations).toEqual([]);

    controller.play();
    expect(navigations).toEqual([1]);
    expect(controller.getState().mode).toBe('playing');
  });

  it('navigation while playing cancels the scene and plays the new one from its start', async () => {
    const { controller, fake } = controllerFor([
      scene('slide', [{ id: 'a', type: 'speech', text: 'Long.', audioRef: 'a' }]),
      scene('slide', [{ id: 'b', type: 'speech', text: 'Other.', audioRef: 'b' }]),
    ]);
    controller.play();
    await flush();
    const first = fake.audio.get('a')!;
    controller.sceneShown(1);
    expect(first.control.signal.aborted).toBe(true);
    await flush();
    expect(fake.log).toEqual(['audio:a', 'audio:b']);
    expect(controller.getState().mode).toBe('playing');
  });

  it('navigation while paused stops playback; Play then starts the shown scene', async () => {
    const { controller, fake } = controllerFor([
      scene('slide', [{ id: 'a', type: 'speech', text: 'A.', audioRef: 'a' }]),
      scene('slide', [{ id: 'b', type: 'speech', text: 'B.', audioRef: 'b' }]),
    ]);
    controller.play();
    await flush();
    controller.pause();
    expect(controller.getState().mode).toBe('paused');
    expect(fake.audio.get('a')!.control.gate.paused).toBe(true);
    controller.sceneShown(1);
    expect(controller.getState().mode).toBe('idle');
    await flush();
    expect(fake.log).toEqual(['audio:a']);
    controller.play();
    await flush();
    expect(fake.log).toEqual(['audio:a', 'audio:b']);
  });

  it('a pause during the advance delay holds the advance until resumed', async () => {
    const { controller, navigations } = controllerFor([
      scene('slide', [speech('One.')]),
      scene('slide', [speech('Two.')]),
    ]);
    controller.play();
    await vi.advanceTimersByTimeAsync(2000 + 500);
    controller.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(navigations).toEqual([]);
    controller.play();
    await vi.advanceTimersByTimeAsync(SCENE_ADVANCE_DELAY_MS - 500);
    expect(navigations).toEqual([1]);
  });
});
