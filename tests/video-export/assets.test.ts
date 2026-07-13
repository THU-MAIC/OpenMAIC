import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  buildTimelineOptions,
  normalizeScenes,
  planAssets,
  sanitizeFilenamePart,
} from '@/lib/video-export';
import { NO_PROBE, playVideo, slide, speech, stubAssets, stubProbe } from './helpers';

/** Run normalize → timeline → assets for a set of scenes. */
function plan(
  scenes: ReturnType<typeof slide>[],
  audio: Parameters<typeof stubAssets>[0] = {},
  media: Parameters<typeof stubAssets>[1] = {},
  probe = NO_PROBE,
) {
  const source = normalizeScenes(scenes).scenes;
  const tl = buildTimeline(source, buildTimelineOptions(probe));
  return planAssets(source, tl.scenes, stubAssets(audio, media));
}

describe('sanitizeFilenamePart', () => {
  it('lowercases, replaces unsafe chars, and never returns empty', () => {
    expect(sanitizeFilenamePart('Intro: Part/One?')).toBe('intro-part-one');
    expect(sanitizeFilenamePart('***')).toBe('scene');
  });
});

describe('planAssets — audio', () => {
  it('plans a present audio clip with an assetRef and a plan entry', () => {
    const res = plan([slide('s', [speech('a', 'hi')])], {
      a: { id: 'aud-a', present: true, format: 'mp3' },
    });
    const audio = res.scenes[0].narration[0].audio;
    expect(audio).toMatchObject({
      assetId: 'aud-a',
      present: true,
      assetRef: 'audio/001-s/speech-001.mp3',
    });
    expect(res.plan.entries).toContainEqual(
      expect.objectContaining({
        assetId: 'aud-a',
        kind: 'audio',
        path: 'audio/001-s/speech-001.mp3',
        present: true,
      }),
    );
    expect(res.diagnostics).toHaveLength(0);
  });

  it('records skipped-media for a referenced-but-absent clip', () => {
    const res = plan([slide('s', [speech('a', 'hi')])], { a: { id: 'aud-a', present: false } });
    expect(res.scenes[0].narration[0].audio.present).toBe(false);
    expect(res.scenes[0].narration[0].audio.assetRef).toBeUndefined();
    expect(res.diagnostics).toContainEqual(expect.objectContaining({ code: 'skipped-media' }));
    expect(res.plan.entries).toContainEqual(
      expect.objectContaining({ assetId: 'aud-a', present: false }),
    );
  });

  it('records missing-audio when a speech with text has no asset at all', () => {
    const res = plan([slide('s', [speech('a', 'hi')])]);
    expect(res.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'missing-audio', actionId: 'a' }),
    );
  });

  it('dedups two references to the same asset id (second carries dedupOf)', () => {
    const res = plan([slide('s', [speech('a', 'x'), speech('b', 'y')])], {
      a: { id: 'shared', present: true, format: 'mp3' },
      b: { id: 'shared', present: true, format: 'mp3' },
    });
    const audioEntries = res.plan.entries.filter((e) => e.kind === 'audio');
    expect(audioEntries).toHaveLength(2);
    expect(audioEntries[0]).not.toHaveProperty('dedupOf');
    expect(audioEntries[1]).toMatchObject({ dedupOf: 'shared', path: audioEntries[0].path });
  });

  it('makes presence authoritative per assetId — a later ref inherits the owner, not its own meta', () => {
    // First ref to `shared` is absent; a later ref claims present:true. The plan
    // must stay internally consistent: the owner's presence wins for both the
    // dedup entry and the stamped segment (no entry disagreeing with its owner).
    const res = plan([slide('s', [speech('a', 'x'), speech('b', 'y')])], {
      a: { id: 'shared', present: false, format: 'mp3' },
      b: { id: 'shared', present: true, format: 'mp3' },
    });
    const audioEntries = res.plan.entries.filter((e) => e.kind === 'audio');
    expect(audioEntries.map((e) => e.present)).toEqual([false, false]);
    expect(audioEntries[1].dedupOf).toBe('shared');
    // Both segments reflect the authoritative (owner) presence: absent → no assetRef.
    expect(res.scenes[0].narration.map((n) => n.audio.present)).toEqual([false, false]);
    expect(res.scenes[0].narration.every((n) => n.audio.assetRef === undefined)).toBe(true);
  });
});

describe('planAssets — base frame & video', () => {
  it('plans a base frame for a slide scene and stamps base.assetRef', () => {
    const res = plan([slide('s', [speech('a', '')])]);
    expect(res.scenes[0].base).toMatchObject({
      kind: 'slide-snapshot',
      assetRef: 'frames/001-s.png',
    });
    expect(res.plan.entries).toContainEqual(
      expect.objectContaining({ kind: 'frame', path: 'frames/001-s.png' }),
    );
  });

  it('plans present video media and skips absent media with a diagnostic', () => {
    const res = plan(
      [slide('s', [playVideo('v', 'clip1'), playVideo('w', 'clip2')])],
      {},
      { clip1: { id: 'media-1', present: true, format: 'mp4' } },
      stubProbe({}, { v: 8000, w: 8000 }),
    );
    expect(res.scenes[0].videos[0].assetRef).toBe('media/clip1.mp4');
    expect(res.scenes[0].videos[1].assetRef).toBeUndefined();
    expect(res.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'skipped-media', message: expect.stringContaining('clip2') }),
    );
  });

  it('suffixes a colliding path when two element ids sanitize to the same name', () => {
    const res = plan(
      [slide('s', [playVideo('a', 'v!'), playVideo('b', 'v?')])],
      {},
      {
        'v!': { id: 'm1', present: true, format: 'mp4' },
        'v?': { id: 'm2', present: true, format: 'mp4' },
      },
    );
    expect(res.scenes[0].videos.map((v) => v.assetRef)).toEqual(['media/v.mp4', 'media/v-2.mp4']);
  });

  it('represents a referenced-but-missing video structurally (assetId + present:false + entry)', () => {
    const res = plan(
      [slide('s', [playVideo('v', 'clip')])],
      {},
      { clip: { id: 'media-x', present: false, format: 'mp4' } },
      stubProbe({}, { v: 8000 }),
    );
    const seg = res.scenes[0].videos[0];
    // Distinguishable from "no association" (which has no assetId) without
    // parsing the diagnostic message.
    expect(seg).toMatchObject({ assetId: 'media-x', present: false, durationSource: 'skipped' });
    expect(seg.assetRef).toBeUndefined();
    expect(res.plan.entries).toContainEqual(
      expect.objectContaining({ assetId: 'media-x', kind: 'video', present: false }),
    );
  });

  it('marks a video with no media association present:false / skipped and plans no entry', () => {
    const res = plan([slide('s', [playVideo('v', 'clip')])], {}, {}, stubProbe({}, { v: 8000 }));
    const seg = res.scenes[0].videos[0];
    expect(seg).toMatchObject({ present: false, durationSource: 'skipped' });
    expect(seg.assetId).toBeUndefined();
    expect(res.plan.entries.filter((e) => e.kind === 'video')).toHaveLength(0);
  });

  it('sanitizes a hostile asset extension so the planned path cannot traverse', () => {
    const res = plan(
      [slide('s', [playVideo('v', 'clip')])],
      {},
      { clip: { id: 'm', present: true, format: '../../escape' } },
      stubProbe({}, { v: 8000 }),
    );
    const path = res.scenes[0].videos[0].assetRef!;
    expect(path).not.toContain('..');
    expect(path).toBe('media/clip.escape');
  });
});
