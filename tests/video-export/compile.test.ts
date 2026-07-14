import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_WAIT_MS } from '@/lib/choreography';
import { compileVideoTimeline, emitManifest, VideoTimelineCompileError } from '@/lib/video-export';
import {
  NO_ASSETS,
  NO_PROBE,
  el,
  playVideo,
  quiz,
  slide,
  speech,
  spotlight,
  stubAssets,
  stubProbe,
} from './helpers';

describe('compileVideoTimeline — end-to-end golden', () => {
  const scenes = [
    slide('s0', [speech('a', 'Welcome'), spotlight('sp', 'e1'), speech('b', 'Focus here')], {
      title: 'Intro',
      elements: [el('e1', { left: 100, top: 100, width: 200, height: 100 })],
    }),
    quiz('q0', [speech('qa', 'Answer this')], 1),
  ];
  const deps = {
    timing: stubProbe({ a: 2000, b: 3000, qa: 2500 }),
    assets: stubAssets({
      a: { id: 'aud-a', present: true, format: 'mp3' },
      b: { id: 'aud-b', present: true, format: 'mp3' },
      qa: { id: 'aud-qa', present: true, format: 'mp3' },
    }),
  };

  const ir = compileVideoTimeline({ stage: { id: 'stg', name: 'Demo' }, scenes }, deps);

  it('stamps the envelope + config', () => {
    expect(ir).toMatchObject({
      schema: 'openmaic.videoTimeline',
      version: 1,
      compiler: 'openmaic-video-timeline',
      stage: { id: 'stg', name: 'Demo' },
      config: { playbackSpeed: 1, ttsEnabled: true, whiteboardInitiallyOpen: false },
      totalDurationMs: 7500,
    });
    expect(ir.canvas.aspectRatio).toBe('16:9');
  });

  it('buckets the slide scene: base frame, narration, resolved-geometry effect', () => {
    const s0 = ir.scenes[0];
    expect(s0).toMatchObject({ index: 0, supported: true, startMs: 0, durationMs: 5000 });
    expect(s0.base).toMatchObject({ kind: 'slide-snapshot', assetRef: 'frames/001-intro.png' });
    expect(s0.narration).toHaveLength(2);
    expect(s0.effects).toHaveLength(1);
    expect(s0.effects[0]).toMatchObject({
      descriptorId: 'spotlight.v1',
      startMs: 2000,
      durationMs: 3000,
      degraded: false,
    });
    expect(s0.effects[0].geometry).not.toBeNull();
  });

  it('represents the quiz scene as unsupported (placeholder base + marker + diagnostic), never dropped', () => {
    const q0 = ir.scenes[1];
    expect(q0).toMatchObject({ index: 1, type: 'quiz', supported: false, startMs: 5000 });
    expect(q0.base.kind).toBe('placeholder');
    expect(q0.base.reason).toMatch(/Quiz/);
    expect(q0.markers[0].kind).toBe('unsupported-scene');
    // quiz narration is still on the timeline
    expect(q0.narration.map((n) => n.text)).toEqual(['Answer this']);
    expect(ir.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-scene', sceneId: 'q0' }),
    );
  });

  it('derives the subtitle track across scenes in order', () => {
    expect(ir.subtitles.map((c) => [c.text, c.startMs, c.endMs])).toEqual([
      ['Welcome', 0, 2000],
      ['Focus here', 2000, 5000],
      ['Answer this', 5000, 7500],
    ]);
  });

  it('plans deduped assets (a frame + one entry per distinct audio clip)', () => {
    expect(ir.assets.entries.map((e) => e.path)).toEqual([
      'frames/001-intro.png',
      'audio/001-intro/speech-001.mp3',
      'audio/001-intro/speech-002.mp3',
      'audio/002-q0/speech-001.mp3',
    ]);
  });

  it('emits a manifest that satisfies the schema', () => {
    expect(() => emitManifest(ir)).not.toThrow();
  });
});

describe('compileVideoTimeline — degradation & edges', () => {
  it('degrades a spotlight whose element is missing, with a diagnostic (no throw)', () => {
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stg', name: 'x' },
        scenes: [slide('s', [speech('a', 'hi'), spotlight('sp', 'ghost')])],
      },
      { timing: stubProbe({ a: 1000 }), assets: NO_ASSETS },
    );
    expect(ir.scenes[0].effects[0].degraded).toBe(true);
    expect(ir.scenes[0].effects[0].geometry).toBeNull();
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({ code: 'unresolved-element' }));
  });

  it('records estimated-duration when narration has no stored audio', () => {
    const ir = compileVideoTimeline(
      { stage: { id: 'stg', name: 'x' }, scenes: [slide('s', [speech('a', 'hello world')])] },
      { timing: NO_PROBE, assets: NO_ASSETS },
    );
    expect(ir.config.ttsEnabled).toBe(false);
    expect(ir.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['estimated-duration', 'missing-audio']),
    );
  });

  it('is deterministic — same input yields identical IR', () => {
    const input = { stage: { id: 'stg', name: 'x' }, scenes: [slide('s', [speech('a', 'hi')])] };
    const deps = { timing: stubProbe({ a: 1000 }), assets: NO_ASSETS };
    expect(compileVideoTimeline(input, deps)).toEqual(compileVideoTimeline(input, deps));
  });

  it('throws on no scenes', () => {
    expect(() =>
      compileVideoTimeline(
        { stage: { id: 'stg', name: 'x' }, scenes: [] },
        { timing: NO_PROBE, assets: NO_ASSETS },
      ),
    ).toThrow(VideoTimelineCompileError);
  });
});

describe('compileVideoTimeline — play_video placement & availability', () => {
  const scene = () =>
    slide('s', [speech('a', 'x'), playVideo('v', 'clip'), speech('b', 'y')], {
      elements: [el('clip', { left: 100, top: 100, width: 400, height: 300, rotate: 15 })],
    });

  it('carries the target element placement (geometry + rotate) into the video segment', () => {
    const ir = compileVideoTimeline(
      { stage: { id: 'stg', name: 'x' }, scenes: [scene()] },
      {
        timing: stubProbe({ a: 1000, b: 1000 }, { v: 4000 }),
        assets: stubAssets({}, { clip: { id: 'm', present: true, format: 'mp4' } }),
      },
    );
    const video = ir.scenes[0].videos[0];
    expect(video.rotate).toBe(15);
    expect(video.geometry).toMatchObject({ x: 10, w: 40 });
    expect(video.degraded).toBe(false);
    expect(video.assetRef).toBe('media/clip.mp4');
    expect(video.durationSource).toBe('stored');
  });

  it('skips an unavailable video (0ms) so later actions are NOT shifted by the safety cap', () => {
    const deps = {
      timing: stubProbe({ a: 1000, b: 1000 }),
      assets: stubAssets({}, { clip: { id: 'm', present: false, format: 'mp4' } }),
    };
    const ir = compileVideoTimeline({ stage: { id: 'stg', name: 'x' }, scenes: [scene()] }, deps);
    const video = ir.scenes[0].videos[0];
    expect(video.durationMs).toBe(0);
    expect(video.durationSource).toBe('skipped');
    expect(video.present).toBe(false);
    // The trailing speech starts right after the first (1000), not 1000 + cap.
    expect(ir.scenes[0].narration[1].startMs).toBe(1000);
    expect(ir.totalDurationMs).toBe(2000);
    expect(ir.totalDurationMs).toBeLessThan(MAX_VIDEO_WAIT_MS);
  });

  it('does not conflate availability across scenes that share a play_video action id', () => {
    // The DSL does not enforce stage-wide action-id uniqueness. Two scenes both
    // use id `dup`: the first video's media is absent (and its duration unknown),
    // the second's is present. An id-keyed availability set would let the second
    // mark `dup` available and leave the first with a 300000ms cap dwell while
    // assets stamp it `skipped` — a contradictory IR that shifts scene 2 by 5min.
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stg', name: 'x' },
        scenes: [
          slide('s0', [playVideo('dup', 'missing')], { elements: [] }),
          slide('s1', [playVideo('dup', 'good')], { order: 1, elements: [] }),
        ],
      },
      {
        timing: stubProbe({}, { dup: 4000 }),
        assets: stubAssets({}, { good: { id: 'm', present: true, format: 'mp4' } }),
      },
    );
    const first = ir.scenes[0].videos[0];
    // The absent-media clip is skipped (0ms), not held for the safety cap — even
    // though a stored 4000ms duration exists for the shared id `dup`.
    expect(first.durationMs).toBe(0);
    expect(first.durationSource).toBe('skipped');
    expect(first.present).toBe(false);
    // Scene 2 (whose video IS available) starts at 0, not 300000, and plays 4000ms.
    expect(ir.scenes[1].startMs).toBe(0);
    expect(ir.scenes[1].videos[0].durationMs).toBe(4000);
    expect(ir.totalDurationMs).toBe(4000);
  });

  it('degrades placement (geometry null, rotate 0) when the target element is missing', () => {
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stg', name: 'x' },
        scenes: [slide('s', [playVideo('v', 'ghost')], { elements: [] })],
      },
      {
        timing: stubProbe({}, { v: 4000 }),
        assets: stubAssets({}, { ghost: { id: 'm', present: true, format: 'mp4' } }),
      },
    );
    const video = ir.scenes[0].videos[0];
    expect(video.geometry).toBeNull();
    expect(video.rotate).toBe(0);
    expect(video.degraded).toBe(true);
    expect(ir.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-element', actionId: 'v' }),
    );
  });
});
