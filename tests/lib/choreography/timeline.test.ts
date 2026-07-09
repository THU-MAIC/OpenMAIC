import { describe, expect, it } from 'vitest';
import {
  resolveActionTimeline,
  EFFECT_AUTO_CLEAR_MS,
  DISCUSSION_TRIGGER_DELAY_MS,
  WB_DRAW_MS,
  wbDrawCodeMs,
  wbClearMs,
  estimateSpeechDurationMs,
} from '@/lib/choreography';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

const act = (a: Partial<Action> & { type: string }): Action => a as unknown as Action;
const speech = (id: string, text: string): Action => act({ id, type: 'speech', text });
const sc = (id: string, actions: Action[]): Scene =>
  ({
    id,
    stageId: 's',
    type: 'slide',
    title: id,
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  }) as unknown as Scene;

describe('resolveActionTimeline — blocking actions advance the cursor', () => {
  it('speech falls back to the deterministic estimate and accumulates startMs', () => {
    const scenes = [sc('S0', [speech('a', '中'.repeat(20)), speech('b', 'hello world')])];
    const tl = resolveActionTimeline(scenes);

    const d0 = estimateSpeechDurationMs('中'.repeat(20)); // 3000
    const d1 = estimateSpeechDurationMs('hello world'); // 2000 floor

    expect(tl).toHaveLength(2);
    expect(tl[0]).toMatchObject({
      sceneId: 'S0',
      sceneIndex: 0,
      actionIndex: 0,
      startMs: 0,
      durationMs: d0,
      advancesCursorMs: d0,
      blocking: true,
    });
    expect(tl[1]).toMatchObject({ startMs: d0, durationMs: d1, advancesCursorMs: d1 });
  });

  it('a supplied audio-duration resolver overrides the estimate', () => {
    const scenes = [sc('S0', [speech('a', 'anything')])];
    const tl = resolveActionTimeline(scenes, { getAudioDurationMs: () => 7777 });
    expect(tl[0]).toMatchObject({ durationMs: 7777, advancesCursorMs: 7777 });
  });

  it('playback speed scales the estimate (but not supplied audio)', () => {
    const scenes = [sc('S0', [speech('a', '中'.repeat(20))])];
    const tl = resolveActionTimeline(scenes, { playbackSpeed: 2 });
    expect(tl[0].durationMs).toBe(estimateSpeechDurationMs('中'.repeat(20)) / 2);
  });
});

describe('resolveActionTimeline — fire-and-forget effects do not advance the cursor', () => {
  it('spotlight/laser have duration EFFECT_AUTO_CLEAR_MS but advancesCursorMs 0', () => {
    const scenes = [
      sc('S0', [
        act({ id: 'sp', type: 'spotlight', elementId: 'e1' }),
        act({ id: 'la', type: 'laser', elementId: 'e2' }),
        speech('s', 'hi there'),
      ]),
    ];
    const tl = resolveActionTimeline(scenes);

    expect(tl[0]).toMatchObject({
      startMs: 0,
      durationMs: EFFECT_AUTO_CLEAR_MS,
      advancesCursorMs: 0,
      blocking: false,
    });
    // Second effect and the speech both start at 0 — the effects didn't move the clock.
    expect(tl[1]).toMatchObject({ startMs: 0, advancesCursorMs: 0, blocking: false });
    expect(tl[2]).toMatchObject({ startMs: 0, blocking: true });
  });
});

describe('resolveActionTimeline — per-action durations', () => {
  it('wb_draw_code uses the line-count formula', () => {
    const code = 'a\nb\nc\nd'; // 4 lines
    const scenes = [sc('S0', [act({ id: 'c', type: 'wb_draw_code', code })])];
    const tl = resolveActionTimeline(scenes);
    expect(tl[0].durationMs).toBe(wbDrawCodeMs(4));
  });

  it('wb_clear scales with the supplied live element count (defaults to floor)', () => {
    const scenes = [sc('S0', [act({ id: 'cl', type: 'wb_clear' })])];
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(wbClearMs(0));
    expect(resolveActionTimeline(scenes, { getClearElementCount: () => 10 })[0].durationMs).toBe(
      wbClearMs(10),
    );
  });

  it('wb_draw_* share WB_DRAW_MS', () => {
    const scenes = [sc('S0', [act({ id: 't', type: 'wb_draw_text' })])];
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(WB_DRAW_MS);
  });

  it('discussion dwells for the trigger delay (interactive wait is out of scope)', () => {
    const scenes = [sc('S0', [act({ id: 'd', type: 'discussion', topic: 't' })])];
    expect(resolveActionTimeline(scenes)[0]).toMatchObject({
      durationMs: DISCUSSION_TRIGGER_DELAY_MS,
      blocking: true,
    });
  });

  it('play_video uses the supplied duration, capped, and 0 when unknown', () => {
    const scenes = [sc('S0', [act({ id: 'v', type: 'play_video', elementId: 'v1' })])];
    expect(resolveActionTimeline(scenes)[0].durationMs).toBe(0);
    expect(resolveActionTimeline(scenes, { getVideoDurationMs: () => 12_345 })[0].durationMs).toBe(
      12_345,
    );
    // capped at MAX_VIDEO_WAIT_MS (5min)
    expect(
      resolveActionTimeline(scenes, { getVideoDurationMs: () => 60 * 60 * 1000 })[0].durationMs,
    ).toBe(5 * 60 * 1000);
  });
});

describe('resolveActionTimeline — scene boundaries', () => {
  it('an empty scene yields one EMPTY_SCENE_DWELL beat', () => {
    const scenes = [sc('S0', [])];
    const tl = resolveActionTimeline(scenes);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({
      sceneId: 'S0',
      actionIndex: 0,
      // empty-text speech → 2000ms floor
      durationMs: estimateSpeechDurationMs(''),
      blocking: true,
    });
    expect(tl[0].action).toMatchObject({ type: 'speech', text: '' });
  });

  it('startMs accumulates across scenes in play order', () => {
    const scenes = [
      sc('S0', [speech('a', 'hello world')]), // 2000
      sc('S1', []), // empty dwell 2000
      sc('S2', [speech('c', '中'.repeat(20))]), // 3000
    ];
    const tl = resolveActionTimeline(scenes);
    expect(tl.map((s) => [s.sceneId, s.startMs])).toEqual([
      ['S0', 0],
      ['S1', 2000],
      ['S2', 4000],
    ]);
  });
});
