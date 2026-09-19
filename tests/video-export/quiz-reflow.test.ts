import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/dsl';
import {
  compileVideoTimeline,
  reflowQuizTimelines,
  type CompilerScene,
  type QuizLayoutProbe,
  type SubtitleCue,
  type VideoTimelineScene,
} from '@/lib/video-export';
import { NO_ASSETS, stubProbe } from './helpers';

function timedScene(id: string, index: number, startMs: number, durationMs: number) {
  return {
    id,
    index,
    title: id,
    type: index === 0 ? 'quiz' : 'slide',
    startMs,
    durationMs,
    supported: true,
    base: { kind: 'visual-segments' },
    visuals: [
      {
        kind: 'quiz-cover',
        startMs,
        durationMs,
        title: id,
        questionCount: 1,
        totalPoints: 1,
      },
    ],
    narration: [
      {
        actionIndex: 0,
        startMs: startMs + 10,
        durationMs: 100,
        text: id,
        audio: { durationMs: 100, source: 'stored', present: false },
      },
    ],
    effects: [
      {
        actionIndex: 1,
        type: 'spotlight',
        descriptorId: 'spotlight.v1',
        startMs: startMs + 20,
        durationMs: 100,
        elementId: 'element',
        geometry: null,
        params: {},
        degraded: true,
      },
    ],
    videos: [
      {
        actionIndex: 2,
        startMs: startMs + 30,
        durationMs: 100,
        elementId: 'element',
        geometry: null,
        rotate: 0,
        present: false,
        degraded: true,
        durationSource: 'skipped',
      },
    ],
    markers: [{ actionIndex: 3, kind: 'beat', startMs: startMs + 40, durationMs: 100 }],
  } as VideoTimelineScene;
}

describe('pure Quiz absolute-time reflow', () => {
  it('extends the owner and shifts every absolute field and subtitle in later scenes', () => {
    const scenes = [timedScene('quiz', 0, 0, 1000), timedScene('slide', 1, 1000, 2000)];
    const subtitles: SubtitleCue[] = [
      { index: 0, sceneId: 'quiz', startMs: 10, endMs: 110, text: 'quiz' },
      { index: 1, sceneId: 'slide', startMs: 1010, endMs: 1110, text: 'slide' },
    ];

    const result = reflowQuizTimelines(scenes, subtitles, 3000, [3000, 0]);

    expect(result.totalDurationMs).toBe(6000);
    expect(result.scenes[0]).toMatchObject({
      startMs: 0,
      durationMs: 4000,
      narration: [{ startMs: 10 }],
      effects: [{ startMs: 20 }],
      videos: [{ startMs: 30 }],
      markers: [{ startMs: 40 }],
    });
    expect(result.scenes[1]).toMatchObject({
      startMs: 4000,
      durationMs: 2000,
      visuals: [{ startMs: 4000 }],
      narration: [{ startMs: 4010 }],
      effects: [{ startMs: 4020 }],
      videos: [{ startMs: 4030 }],
      markers: [{ startMs: 4040 }],
    });
    expect(result.subtitles).toEqual([
      { index: 0, sceneId: 'quiz', startMs: 10, endMs: 110, text: 'quiz' },
      { index: 1, sceneId: 'slide', startMs: 4010, endMs: 4110, text: 'slide' },
    ]);
  });

  it('accumulates extensions from consecutive Quiz scenes without changing relative action timing', () => {
    const scenes = [
      timedScene('quiz-1', 0, 0, 1000),
      timedScene('quiz-2', 1, 1000, 1000),
      timedScene('slide', 2, 2000, 1000),
    ];
    const result = reflowQuizTimelines(scenes, [], 3000, [3000, 7000, 0]);

    expect(result.scenes.map((scene) => [scene.startMs, scene.durationMs])).toEqual([
      [0, 4000],
      [4000, 8000],
      [12_000, 1000],
    ]);
    expect(result.scenes[2].narration[0].startMs - result.scenes[2].startMs).toBe(10);
    expect(result.totalDurationMs).toBe(13_000);
  });
});

function quiz(id: string, order: number): CompilerScene {
  return {
    id,
    stageId: 'stage',
    title: id,
    order,
    type: 'quiz',
    content: { type: 'quiz', questions: [{ id: `${id}-q`, type: 'single', question: 'Q' }] },
    actions: [{ id: `${id}-speech`, type: 'speech', text: id } as Action],
  } as CompilerScene;
}

describe('Quiz scroll-duration bounds and cumulative compiler reflow', () => {
  it('clamps one-pixel overflow to 4s and extreme overflow to 24s', () => {
    const probe: QuizLayoutProbe = {
      measureQuestionList: (scene) =>
        scene.id === 'min'
          ? { contentHeightPx: 401, viewportHeightPx: 400, frameHeightPx: 720 }
          : { contentHeightPx: 100_000, viewportHeightPx: 400, frameHeightPx: 720 },
    };
    const ir = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Bounds' }, scenes: [quiz('min', 0), quiz('max', 1)] },
      {
        timing: stubProbe({ 'min-speech': 1000, 'max-speech': 1000 }),
        assets: NO_ASSETS,
        quizLayout: probe,
      },
    );
    const lists = ir.scenes.map((scene) => scene.visuals[1]);

    expect(lists[0]).toMatchObject({
      scrollDistancePx: 1,
      scrollDurationMs: 4000,
      pixelsPerSecond: 0.25,
    });
    expect(lists[1]).toMatchObject({
      scrollDistancePx: 99_600,
      scrollDurationMs: 24_000,
      pixelsPerSecond: 4150,
    });
    expect(ir.scenes.map((scene) => [scene.startMs, scene.durationMs])).toEqual([
      [0, 8000],
      [8000, 28_000],
    ]);
    expect(ir.subtitles.map((cue) => cue.startMs)).toEqual([0, 8000]);
    expect(ir.totalDurationMs).toBe(36_000);
  });
});
