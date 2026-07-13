import { describe, expect, it } from 'vitest';
import {
  estimateSpeechDurationMs,
  EFFECT_AUTO_CLEAR_MS,
  MAX_VIDEO_WAIT_MS,
} from '@/lib/choreography';
import { buildTimeline, buildTimelineOptions } from '@/lib/video-export';
import {
  NO_PROBE,
  laser,
  playVideo,
  slide,
  speech,
  spotlight,
  stubProbe,
  wbDrawText,
} from './helpers';

describe('buildTimeline — narration + subtitles', () => {
  it('uses stored audio durations and derives one subtitle cue per non-empty speech', () => {
    const scenes = [slide('s', [speech('a', 'first'), speech('b', 'second')])];
    const opts = buildTimelineOptions(stubProbe({ a: 3000, b: 2000 }));
    const tl = buildTimeline(scenes, opts);

    expect(tl.ttsEnabled).toBe(true);
    expect(tl.totalDurationMs).toBe(5000);
    const [scene] = tl.scenes;
    expect(scene.narration).toMatchObject([
      { startMs: 0, durationMs: 3000, audio: { source: 'stored' } },
      { startMs: 3000, durationMs: 2000, audio: { source: 'stored' } },
    ]);
    expect(tl.subtitles).toEqual([
      expect.objectContaining({ index: 0, sceneId: 's', startMs: 0, endMs: 3000, text: 'first' }),
      expect.objectContaining({ index: 1, startMs: 3000, endMs: 5000, text: 'second' }),
    ]);
  });

  it('falls back to the deterministic estimate and records estimated-duration', () => {
    const scenes = [slide('s', [speech('a', 'hello world')])];
    const tl = buildTimeline(scenes, buildTimelineOptions(NO_PROBE));
    const est = estimateSpeechDurationMs('hello world');

    expect(tl.ttsEnabled).toBe(false);
    expect(tl.scenes[0].narration[0]).toMatchObject({
      durationMs: est,
      audio: { source: 'estimated' },
    });
    expect(tl.diagnostics).toEqual([
      expect.objectContaining({ code: 'estimated-duration', actionId: 'a' }),
    ]);
  });

  it('scales stored audio by playbackSpeed', () => {
    const scenes = [slide('s', [speech('a', 'x')])];
    const tl = buildTimeline(
      scenes,
      buildTimelineOptions(stubProbe({ a: 4000 }), { playbackSpeed: 2 }),
    );
    expect(tl.scenes[0].narration[0].durationMs).toBe(2000);
  });
});

describe('buildTimeline — effects', () => {
  it('places a fire-and-forget spotlight with a clamped lifetime and no subtitle', () => {
    // speech(2000) → spotlight → speech(2000): the spotlight lives until the
    // scene's completion clock (4000), i.e. 2000ms from its 2000ms start.
    const scenes = [
      slide('s', [speech('a', 'x'), spotlight('sp', 'e1'), speech('b', 'y')], {
        elements: [],
      }),
    ];
    const tl = buildTimeline(scenes, buildTimelineOptions(stubProbe({ a: 2000, b: 2000 })));

    expect(tl.totalDurationMs).toBe(4000);
    expect(tl.scenes[0].effects).toMatchObject([
      {
        type: 'spotlight',
        descriptorId: 'spotlight.v1',
        startMs: 2000,
        durationMs: 2000,
        geometry: null,
      },
    ]);
    expect(tl.subtitles.map((c) => c.text)).toEqual(['x', 'y']);
  });

  it('a lone spotlight at completion is clamped to 0 (never outlives its scene)', () => {
    const tl = buildTimeline([slide('s', [spotlight('sp', 'e1')])], buildTimelineOptions(NO_PROBE));
    expect(tl.scenes[0].effects[0].durationMs).toBe(0);
    expect(EFFECT_AUTO_CLEAR_MS).toBe(5000); // sanity: shared constant is in play
  });

  it('carries descriptor default params when the action has no override', () => {
    const tl = buildTimeline([slide('s', [spotlight('sp', 'e1')])], buildTimelineOptions(NO_PROBE));
    expect(tl.scenes[0].effects[0].params).toEqual({ dimness: 0.5 });
  });

  it('merges authored spotlight dimOpacity and laser color overrides into params', () => {
    const tl = buildTimeline(
      [slide('s', [spotlight('sp', 'e1', 0.8), laser('lz', 'e2', '#00ff00')])],
      buildTimelineOptions(NO_PROBE),
    );
    expect(tl.scenes[0].effects[0].params).toMatchObject({ dimness: 0.8 });
    expect(tl.scenes[0].effects[1].params).toMatchObject({ color: '#00ff00' });
  });
});

describe('buildTimeline — play_video durationSource', () => {
  const vid = [slide('s', [playVideo('v', 'clip')])];

  it("labels a resolved-within-cap duration 'stored'", () => {
    const tl = buildTimeline(vid, buildTimelineOptions(stubProbe({}, { v: 8000 })));
    expect(tl.scenes[0].videos[0]).toMatchObject({ durationSource: 'stored', durationMs: 8000 });
  });

  it("labels a resolved-over-cap duration 'capped' and clamps to MAX_VIDEO_WAIT_MS", () => {
    const tl = buildTimeline(vid, buildTimelineOptions(stubProbe({}, { v: 99_999_999 })));
    expect(tl.scenes[0].videos[0]).toMatchObject({
      durationSource: 'capped',
      durationMs: MAX_VIDEO_WAIT_MS,
    });
  });

  it("defaults an unresolved duration to the cap ('capped')", () => {
    const tl = buildTimeline(vid, buildTimelineOptions(NO_PROBE));
    expect(tl.scenes[0].videos[0]).toMatchObject({
      durationSource: 'capped',
      durationMs: MAX_VIDEO_WAIT_MS,
    });
  });

  it("honors the 'zero' unresolved-video policy", () => {
    const tl = buildTimeline(
      vid,
      buildTimelineOptions(NO_PROBE, { onUnresolvedVideoDuration: 'zero' }),
    );
    expect(tl.scenes[0].videos[0]).toMatchObject({ durationSource: 'zero', durationMs: 0 });
  });
});

describe('buildTimeline — markers & empty scenes', () => {
  it('carries whiteboard beats as markers, preceded by an implicit-wb-open on a closed board', () => {
    const tl = buildTimeline([slide('s', [wbDrawText('w', 'hi')])], buildTimelineOptions(NO_PROBE));
    expect(tl.scenes[0].markers).toMatchObject([
      { kind: 'implicit-wb-open', startMs: 0 },
      { kind: 'wb_draw_text', actionId: 'w', startMs: 2000 },
    ]);
  });

  it('emits an empty-scene marker (and no subtitle) for an actionless scene', () => {
    const tl = buildTimeline([slide('s', [])], buildTimelineOptions(NO_PROBE));
    expect(tl.scenes[0].markers).toMatchObject([{ kind: 'empty-scene' }]);
    expect(tl.subtitles).toHaveLength(0);
  });

  it('splits multi-scene segments into aligned per-scene buckets', () => {
    const scenes = [slide('s0', [speech('a', 'x')]), slide('s1', [speech('b', 'y')], { order: 1 })];
    const tl = buildTimeline(scenes, buildTimelineOptions(stubProbe({ a: 2000, b: 3000 })));
    expect(tl.scenes[0]).toMatchObject({ startMs: 0, durationMs: 2000 });
    expect(tl.scenes[1]).toMatchObject({ startMs: 2000, durationMs: 3000 });
  });
});
